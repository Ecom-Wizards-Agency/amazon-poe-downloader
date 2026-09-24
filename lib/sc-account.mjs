/*
 * Seller Central account and session primitives for any Chrome started with
 * --remote-debugging-port: page classification (chooser, sign-in,
 * authorization-failed, app), live identity reads (GetUserContext plus the
 * display name), and a deterministic in-app account switch.
 *
 * The switcher drives Seller Central's own full-page account picker with
 * trusted input events. Accounts are switched only through that in-app
 * picker, never by rewriting URLs or domains. The confirm button lives in
 * shadow DOM and ignores synthetic JS clicks, which is why clicks are
 * dispatched as real mouse events over CDP.
 *
 * Identity reads use the page's anti-csrftoken-a2z meta tag, falling back to
 * same-origin /home HTML for shell pages, to call /ox-api/graphql GetUserContext.
 * No cookies, storage or tokens are read beyond that meta tag.
 */
import { Session, evaluate } from "./cdp.mjs";
import { pickerSelectionExpression, pickerSelectionError, waitForMarketplaceSelection } from "./account-selection.mjs";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The picker's confirm button, by visible label. Add new locales here.
export const CONFIRM_BUTTON_LABELS = ["Select account", "Konto auswählen", "Choose account"];

export function normalizeOrigin(value) {
  try { return new URL(value).origin; }
  catch (_) { throw new Error(`invalid Seller Central origin: ${value}`); }
}

export function accountPickerUrl(origin, returnTo = "/home") {
  return `${normalizeOrigin(origin)}/account-switcher/default/merchantMarketplace?returnTo=${encodeURIComponent(returnTo)}`;
}

// One evaluate gathers every fact classifyPage needs, so a probe costs a single
// round-trip on a possibly-sick target.
export const PAGE_FACTS_JS = `(function(){return {
  url: location.href,
  title: document.title,
  hasPasswordInput: !!document.querySelector('input[type="password"],input[type="email"],#ap_email'),
  hasChallengeInput: !!document.querySelector('input[name="guess"],img[src*="captcha"],input[autocomplete="one-time-code"],input[name="otpCode"]'),
  csrfMeta: !!document.querySelector('meta[name="anti-csrftoken-a2z"]'),
  scShell: !!document.querySelector('#sc-navbar-container,#sc-navbar,.sc-navbar,#sc-content-container,#ngstrim-top-navigation'),
  monsErrorPage: !!document.querySelector('#mons-error-page-template,.mons-error-page-template'),
  chooserButtonCount: document.querySelectorAll('button.full-page-account-switcher-account-details').length,
  bodySnippet: ((document.body && document.body.innerText) || "").slice(0, 2000)
};})()`;

// Pure classification so it unit-tests without a browser. Order matters:
// the chooser and the authorization-failed page both contain "auth"-ish URL
// fragments that a naive sign-in regex would misread as logged_out, which
// would produce a false "NOT signed in" verdict for a live session.
export function classifyPage(facts) {
  const f = facts || {};
  const url = String(f.url || "");
  const body = String(f.bodySnippet || "");
  if (/captcha|\/ap\/cvf|account-recovery/i.test(`${url} ${body}`) || f.hasChallengeInput) {
    return { pageKind: "challenge", authState: "human_challenge" };
  }
  // The account picker is an AUTHENTICATED state: reaching it requires a live
  // session. It just has no seller selected yet.
  if (Number(f.chooserButtonCount || 0) > 0 || /\/account-switcher\//.test(url)) {
    return { pageKind: "chooser", authState: "authenticated" };
  }
  if (/\/authorization\/failed/i.test(url)) {
    return { pageKind: "auth-failed", authState: f.csrfMeta ? "authenticated" : "ambiguous" };
  }
  if (/signin|authportal|\/ax\//i.test(url) || /sign[- ]?in/i.test(String(f.title || "")) || f.hasPasswordInput) {
    return { pageKind: "sign-in", authState: "logged_out" };
  }
  if (f.monsErrorPage) return { pageKind: "error", authState: "ambiguous" };
  if (f.csrfMeta) return { pageKind: "app", authState: "authenticated" };
  // Some Seller Central pages render the shell without the CSRF meta tag; the
  // session is still authenticated there.
  if (f.scShell) return { pageKind: "app", authState: "authenticated" };
  return { pageKind: "unknown", authState: "ambiguous" };
}

export async function inspectPage(session, { timeoutMs = 8000 } = {}) {
  const facts = await evaluate(session, PAGE_FACTS_JS, timeoutMs);
  return { facts, ...classifyPage(facts) };
}

// The auth verdict string alone, as the account picker needs it.
export async function inspectAuthenticationState(session) {
  return (await inspectPage(session)).authState;
}

// Shared with the page expression so selector order and name normalization cannot drift.
// Accepts a live or detached Document; it never changes either document.
// opts.strict: only the exact account picker selectors.
// opts.trusted: the exact selectors plus the account-switcher header.
// Neither: every selector, loose ones last.
export function identityFromDocument(doc, opts) {
  const meta = doc.querySelector('meta[name="anti-csrftoken-a2z"]');
  // Strict mode trusts only the exact account picker. On the NGS home and on
  // shell pages without the CSRF tag the loose selectors match unrelated
  // widgets (for example "Account Health Healthy"), and a wrong name is worse
  // than none: a missing name is tolerated when the ids match, a wrong one is not.
  // No selector may match on a generic "account" aria-label: the Account
  // Health widget carries one and renders before the account header.
  const exact = ['[data-test="current-account"]', '#sc-mkt-picker-switcher-select'];
  const header = ['.dropdown-account-switcher-header'];
  const loose = ['[class*="AccountSwitcher" i]', '[data-testid*="account-switcher" i]',
    '[id*="account-switcher" i]', '[class*="partner-switcher" i]'];
  const sels = (opts && opts.strict) ? exact
    : (opts && opts.trusted) ? exact.concat(header)
    : exact.concat(header, loose);
  let displayName = null;
  for (const sel of sels) {
    const el = doc.querySelector(sel);
    const text = el && (el.innerText || el.textContent || "").trim();
    if (text) { displayName = text.replace(/\s+/g, " ").trim().slice(0, 80); break; }
  }
  return { token: meta?.getAttribute("content") || null, displayName };
}

// How long an identity read with a settle budget waits for the account header,
// and how often it looks. The header can render after the POE page is ready.
export const IDENTITY_SETTLE_MS = 10000;
export const IDENTITY_SETTLE_POLL_MS = 500;

// Resolve the ACTIVE session account, including Seller Central pages without the meta tag.
// Returns { displayName, partnerAccountId, merchantId, marketplace, err, source }.
// Never throws for identity problems; `err` names them instead.
// With settleMs > 0 on a page with the CSRF meta tag, the display name comes
// only from the exact or header selectors, polled for up to settleMs; when
// none yields text by then it stays null rather than a loose guess.
const identityScript = (settleMs) => `(async function(){
  const identityFromDocument = ${identityFromDocument.toString()};
  var settleMs = ${Math.max(0, Number(settleMs) || 0)};
  var out = { displayName: null, partnerAccountId: null, merchantId: null, marketplace: null, err: null, source: "page" };
  var strict = !document.querySelector('meta[name="anti-csrftoken-a2z"]');
  var page = identityFromDocument(document, { strict: strict });
  if (!strict && settleMs > 0) {
    var deadline = Date.now() + settleMs;
    page = identityFromDocument(document, { trusted: true });
    while (!page.displayName && Date.now() < deadline) {
      await new Promise(function(resolve){ setTimeout(resolve, ${IDENTITY_SETTLE_POLL_MS}); });
      page = identityFromDocument(document, { trusted: true });
    }
  }
  var token = page.token;
  out.displayName = page.displayName;
  if (!token) {
    out.source = "home";
    try {
      // same-origin mode rejects cross-origin redirects before following them,
      // while allowing /home to redirect to the session's current home path.
      var home = await fetch(location.origin + "/home", { credentials: "include", mode: "same-origin" });
      if (home.url && new URL(home.url).origin !== location.origin) throw new Error("/home redirected outside the Seller Central origin");
      if (!home.ok) throw new Error("/home failed with HTTP " + home.status);
      if (/signin|authportal|\\/ap\\//i.test(home.url || "")) throw new Error("/home redirected to a sign-in page");
      var homeDoc = new DOMParser().parseFromString(await home.text(), "text/html");
      if (homeDoc.querySelector('input[type="password"],input[type="email"],#ap_email')) throw new Error("/home returned a sign-in page");
      var homeIdentity = identityFromDocument(homeDoc, { strict: true });
      token = homeIdentity.token;
      if (!out.displayName) out.displayName = homeIdentity.displayName;
      if (!token) throw new Error("no anti-csrftoken-a2z meta tag on this page or /home");
    } catch (e) { out.err = "Identity /home fallback failed: " + String(e); }
  }
  if (token && !out.err) {
    try {
      var res = await fetch(location.origin + "/ox-api/graphql", {
        method: "POST", credentials: "include", mode: "same-origin",
        headers: { "Content-Type": "application/json", "Accept": "application/json", "anti-csrftoken-a2z": token },
        body: JSON.stringify({ operationName: "GetUserContext", variables: {},
          query: "query GetUserContext { userContext { partnerAccountId merchantId marketplaceSelection __typename } }" })
      });
      if (res.status === 401 || res.status === 403) out.err = "GetUserContext not authorized (" + res.status + ") on this page; ids unavailable here (normal outside Opportunity Explorer pages; the DOM display name still identifies the account)";
      else if (!res.ok) out.err = "GetUserContext failed with HTTP " + res.status;
      else {
        var parsed = await res.json();
        if (parsed.errors && parsed.errors.length) out.err = "GraphQL error: " + String(parsed.errors[0].message || "").slice(0, 200);
        var u = (parsed.data || {}).userContext || {};
        out.partnerAccountId = u.partnerAccountId || null;
        out.merchantId = u.merchantId || null;
        out.marketplace = u.marketplaceSelection || null;
      }
    } catch (e) { out.err = "GetUserContext transport failed: " + String(e); }
  }
  return out;
})()`;

// settleMs: see identityScript. The evaluate budget grows by the same amount.
export async function readIdentity(session, { timeoutMs = 30000, settleMs = 0 } = {}) {
  return evaluate(session, identityScript(settleMs), timeoutMs + Math.max(0, Number(settleMs) || 0));
}

/*
 * Whether a later identity read still shows the account of a baseline read.
 * Ids come from GetUserContext; the display name comes from the page and can
 * render late or differently, so:
 *   - an id that differs from a non-empty baseline id always fails;
 *   - an id that became unavailable fails unless another id (merchantId or
 *     partnerAccountId) is present and equal in both reads;
 *   - the display name is compared only when no such id matches.
 * Values are compared lowercased with collapsed whitespace. Returns
 * { ok, field } naming the first field that failed.
 */
export function identityFieldsConsistent(baseline, actual) {
  const normalize = (value) => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  const b = baseline || {};
  const a = actual || {};
  const strongIdMatches = ["merchantId", "partnerAccountId"].some((field) =>
    normalize(a[field]) && normalize(a[field]) === normalize(b[field]));
  for (const field of ["merchantId", "partnerAccountId", "displayName"]) {
    const want = normalize(b[field]);
    const got = normalize(a[field]);
    if (!want || got === want) continue;
    const fails = field === "displayName" ? !strongIdMatches : Boolean(got) || !strongIdMatches;
    if (fails) return { ok: false, field };
  }
  return { ok: true, field: null };
}

export async function waitFor(session, expression, description, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await evaluate(session, expression, 10000)) return;
    } catch (error) {
      if (!/context|navigation|target|session/i.test(error.message)) throw error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

export async function trustedClick(session, expression, description) {
  // Headed Chrome may leave the target in a background tab. Focus the exact
  // target before dispatching trusted pointer events.
  await session.send("Page.bringToFront", {}, { timeoutMs: 10000 });
  const box = await evaluate(session, expression, 10000);
  if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y)) {
    throw new Error(`Could not find ${description}`);
  }
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await session.send("Input.dispatchMouseEvent", {
      type, x: box.x, y: box.y, button: "left", clickCount: 1,
    }, { timeoutMs: 10000 });
  }
}

export async function waitForAppPage(session, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await evaluate(session,
      `document.readyState === "complete" && !!document.querySelector('meta[name="anti-csrftoken-a2z"]')`,
      10000).catch(() => false);
    if (ok) return;
    await sleep(500);
  }
  throw new Error("page never became ready after the account switch (readyState/meta tag). Is the session logged in?");
}

/*
 * Drive the full-page account picker to `profile.accountName` /
 * `profile.marketplaceLabel` (optionally expanding `profile.parentAccountName`
 * first), then navigate to `returnTo` and wait for an authenticated app page.
 * Fail-closed: any ambiguity (0 or >1 matches, challenge, logged out) throws
 * ACCOUNT_SWITCH_BLOCKED and changes nothing further.
 */
export async function switchAccount(session, origin, profile, { returnTo = "/home", marketplaceTimeoutMs = 30000 } = {}) {
  await session.send("Page.enable", {}, { timeoutMs: 10000 });
  await session.send("Page.navigate", { url: accountPickerUrl(origin, returnTo) }, { timeoutMs: 15000 });
  await waitFor(session, `document.readyState === "complete"`, "Seller Central account picker");
  await waitFor(session, `document.querySelectorAll("button.full-page-account-switcher-account-details").length > 0
    || /signin|auth|login|mfa|captcha|\\/ap\\/cvf/.test(location.href)
    || !!document.querySelector('input[type="password"],input[autocomplete="one-time-code"],input[name="guess"]')`,
  "account picker or authentication challenge");
  const auth = await inspectAuthenticationState(session);
  if (auth !== "authenticated") throw new Error(`ACCOUNT_SWITCH_BLOCKED: Seller Central is ${auth}`);

  const account = JSON.stringify(profile.accountName);
  const parent = JSON.stringify(profile.parentAccountName || "");
  // The picker renders a parent account before the asynchronously loaded
  // seller accounts. Waiting for merely "any button" made a valid account look
  // unavailable whenever this second render had not completed yet.
  await waitFor(session, `(()=>{const norm=s=>(s||"").replace(/\\s*\\((aktuell|current)\\)\\s*$/i,"").trim();
    const labels=[...document.querySelectorAll("button.full-page-account-switcher-account-details")].map(e=>norm(e.innerText));
    return labels.includes(${account}) || (${parent} && labels.includes(${parent}));})()`,
  `requested Seller Central account ${profile.accountName}`);
  const accountBox = pickerSelectionExpression(profile, "account");
  let accountHit = await evaluate(session, accountBox, 10000);
  if (accountHit?.accountCount > 1) throw pickerSelectionError("account", "ambiguous", profile.accountName);
  if (accountHit?.count === 0 && profile.parentAccountName) {
    const parentBox = pickerSelectionExpression(profile, "parent");
    const parentHit = await evaluate(session, parentBox, 10000);
    if (parentHit?.count !== 1) throw pickerSelectionError("parent", parentHit?.accountCount > 1 ? "ambiguous" : "missing", profile.parentAccountName);
    if (!parentHit.expanded) await trustedClick(session, parentBox, `parent account ${profile.parentAccountName}`);
    await waitFor(session, `(${accountBox}).count === 1`, `seller account ${profile.accountName} under ${profile.parentAccountName}`);
    accountHit = await evaluate(session, accountBox, 10000);
  }
  if (accountHit?.count !== 1) throw pickerSelectionError("account", accountHit?.accountCount > 1 ? "ambiguous" : "missing", profile.accountName);

  const marketplaceBox = pickerSelectionExpression(profile, "marketplace");
  const readMarketplace = () => evaluate(session, marketplaceBox, 10000);
  let marketplaceHit = await readMarketplace();
  if (marketplaceHit?.count === 0 && !accountHit.expanded) {
    await trustedClick(session, accountBox, `account ${profile.accountName}`);
  }
  marketplaceHit = await waitForMarketplaceSelection(readMarketplace,
    `${profile.accountName} / ${profile.marketplaceLabel}`, { timeoutMs: marketplaceTimeoutMs });
  if (!marketplaceHit.current) {
    await trustedClick(session, marketplaceBox, `marketplace ${profile.marketplaceLabel}`);
    await sleep(500);
    const labels = JSON.stringify(CONFIRM_BUTTON_LABELS);
    await trustedClick(session, `(()=>{const all=[];const walk=root=>{for(const e of root.querySelectorAll("*")){all.push(e);if(e.shadowRoot)walk(e.shadowRoot)}};walk(document);
      const labels=${labels};const matches=all.filter(e=>e.tagName==="BUTTON"&&labels.includes((e.textContent||"").trim())&&e.getBoundingClientRect().width>0);
      if(matches.length!==1)return null;const r=matches[0].getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`, "account confirmation");
    await waitFor(session, `!location.pathname.includes("account-switcher")`, "selected Seller Central account");
  }
  await session.send("Page.navigate", { url: `${normalizeOrigin(origin)}${returnTo}` }, { timeoutMs: 15000 });
  await waitForAppPage(session);
}

export function accountMatches(acct, expected) {
  if (!expected) return true;
  const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  const want = norm(expected);
  const cands = [acct.displayName, acct.partnerAccountId, acct.merchantId].map(norm).filter(Boolean);
  return cands.some((c) => c === want || c.includes(want) || want.includes(c));
}

/*
 * Probe one /json/list page entry with hard budgets and return a conclusive
 * three-state result. Failures are INDETERMINATE, never "signed out": a target
 * that cannot be probed says nothing about the session, and conflating the two
 * produces a false "NOT signed in" verdict.
 * Returns { state, pageKind, authState, url, title, identity, reason, stale }.
 * `stale: true` marks results whose url could only come from the snapshot.
 */
export async function probeTab(page, opts = {}) {
  const { openTimeoutMs = 8000, factsTimeoutMs = 8000, identityTimeoutMs = 10000, deadlineMs = 20000 } = opts;
  let deadlineTimer;
  const deadline = new Promise((resolve) => {
    deadlineTimer = setTimeout(() => resolve({
      state: "indeterminate", pageKind: null, authState: null, identity: null, stale: true,
      url: page.url, title: page.title, reason: `probe exceeded its ${deadlineMs} ms deadline`,
    }), deadlineMs);
    deadlineTimer.unref?.();
  });
  const work = (async () => {
    let s;
    try {
      s = await Session.open(page.webSocketDebuggerUrl, { timeoutMs: openTimeoutMs });
    } catch (e) {
      return { state: "indeterminate", pageKind: null, authState: null, identity: null, stale: true, url: page.url, title: page.title, reason: `could not attach: ${e.message}` };
    }
    try {
      let facts;
      try {
        facts = await evaluate(s, PAGE_FACTS_JS, factsTimeoutMs);
      } catch (e) {
        return { state: "indeterminate", pageKind: null, authState: null, identity: null, stale: true, url: page.url, title: page.title, reason: `probe failed: ${e.message}` };
      }
      const { pageKind, authState } = classifyPage(facts);
      const state = authState === "authenticated" ? "signed-in"
        : authState === "logged_out" ? "signed-out"
        : authState === "human_challenge" ? "challenge"
        : "indeterminate";
      const out = {
        state, pageKind, authState, identity: null, stale: false,
        url: facts.url, title: facts.title,
        reason: state === "indeterminate" ? "page state is ambiguous (neither an app page, a sign-in page, nor the chooser)" : null,
      };
      if (state === "signed-in" && pageKind !== "chooser") {
        try { out.identity = await readIdentity(s, { timeoutMs: identityTimeoutMs }); }
        catch (e) { out.identity = { displayName: null, partnerAccountId: null, merchantId: null, marketplace: null, err: e.message }; }
      }
      return out;
    } finally { s.close(); }
  })();
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(deadlineTimer);
  }
}

// Pure doctor verdict over probeTab results. Never claims "NOT signed in"
// unless every tab was conclusively probed as signed out.
export function doctorVerdict(tabs) {
  if (!tabs.length) {
    return { exitCode: 1, text: "Login: no Seller Central tab is open. Open Seller Central and sign in to it in the Chrome window you started with --remote-debugging-port, then re-run." };
  }
  const byState = (st) => tabs.filter((t) => t.state === st);
  const signedIn = byState("signed-in");
  if (signedIn.length) {
    const chooserOnly = signedIn.every((t) => t.pageKind === "chooser");
    return {
      exitCode: 0,
      text: chooserOnly
        ? "Login: OK, but the session sits on the account chooser with NO account selected. Pick one in that Chrome window, or pass the account name and marketplace label so the tool selects it."
        : "Login: OK. Session is active, ready to fetch.",
    };
  }
  if (byState("challenge").length) {
    return { exitCode: 1, text: "Login: BLOCKED by a human challenge (captcha/OTP). Complete the captcha or one-time code in that Chrome window, then re-run." };
  }
  const indeterminate = byState("indeterminate");
  if (indeterminate.length) {
    const reasons = [...new Set(indeterminate.map((t) => t.reason).filter(Boolean))].join("; ");
    return { exitCode: 2, text: `Login: INDETERMINATE. Could not conclusively probe ${indeterminate.length} of ${tabs.length} tab(s)${reasons ? ` (${reasons})` : ""}. Retry; if it persists, reload the Seller Central tab in that Chrome window or restart Chrome with --remote-debugging-port and sign in again.` };
  }
  return { exitCode: 1, text: "Login: NOT signed in on any open tab. Sign in to Seller Central in the Chrome window you started with --remote-debugging-port, then re-run." };
}
