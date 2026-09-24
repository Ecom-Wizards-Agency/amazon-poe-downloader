#!/usr/bin/env node
/*
 * amazon-poe-downloader: download Amazon Product Opportunity Explorer (POE)
 * niche data from your own logged-in Seller Central session over the Chrome
 * DevTools Protocol (CDP).
 *
 * Start Chrome yourself with a debug port and a dedicated profile, sign in to
 * Seller Central in that window once, then:
 *
 *   node run-poe.mjs doctor --marketplace us
 *   node run-poe.mjs niche  --niche-id <id> --marketplace de [--verbose]
 *   node run-poe.mjs search --query "desk lamp" --marketplace us
 *   node run-poe.mjs batch  --queries "kw one,kw two" --marketplace us --top 10
 *   node run-poe.mjs merchant-niches --marketplace us
 *
 * The tool talks to any Chrome started with --remote-debugging-port=<port>
 * (default 127.0.0.1:9222; override with --host/--port or CDP_HOST/CDP_PORT).
 * Each run opens its own background tab, leaves your other tabs alone, and
 * closes that tab again when it succeeds.
 *
 * --marketplace is REQUIRED for data commands. It selects the Seller Central
 * origin (override with --origin) and the marketplace id sent with every
 * request. What is verified, in order:
 *   1. Before Chrome is touched: --origin must be the https origin of a
 *      Seller Central domain this tool knows (POE_ORIGIN_UNKNOWN) and in the
 *      same region as --marketplace (ORIGIN_MARKETPLACE_REGION_MISMATCH).
 *   2. Before any data request: the active account (and, with --account-name,
 *      the session marketplace) must match the account options. When the
 *      structured account options are present, a mismatch is switched through
 *      Seller Central's own account picker and revalidated.
 *   3. Before and after every data request: the account and session
 *      marketplace (GetUserContext marketplaceSelection) must be unchanged,
 *      and the tab must still be on the exact origin the run opened
 *      (POE_CONTEXT_CHANGED). The baseline is read once POE is ready and the
 *      account header had up to 10 s to render. The ids (merchantId,
 *      partnerAccountId) and the marketplace are compared exactly; the
 *      display name is compared only when no strong id is available, because
 *      it comes from the page and can render late. A field that could not be
 *      read for the baseline (for example a missing marketplaceSelection) is
 *      not compared; item 4 still checks the marketplace of the data.
 *   4. After every data request: the obfuscatedMarketplaceId the response
 *      itself reports must equal --marketplace (POE_MARKETPLACE_MISMATCH). That
 *      is niche.obfuscatedMarketplaceId for niche, every returned niche row for
 *      search, and the merchant info for merchant-niches. A missing id fails
 *      the same way; an empty search result or an empty merchant-niches
 *      result has nothing to compare.
 *
 * ACCOUNT SAFETY: POE records every niche you open in the active account's
 * "recently viewed niches". Researching for one seller while signed in to
 * another seller's account shows that research to the other account's users.
 * Every data command resolves and prints the active account (display name and
 * partnerAccountId) before fetching and re-reads it after every response. A
 * response is discarded when the account, marketplace or origin changed.
 * Pass --account-name, --expected-partner-account-id and --marketplace-label
 * to make the check strict (--expect-account is a looser substring check).
 *
 * Output: files in a local folder (--out-dir, POE_OUT_DIR or ./poe-output,
 * plus an optional --label subfolder) and one JSON receipt on stdout that
 * lists every stored file with its SHA-1. Progress and diagnostics go to stderr.
 *
 * Safety: read-only GraphQL reads in your own session (plus a same-origin GET
 * /home for identity on pages without the CSRF meta tag), about 5 s of pacing
 * between heavy requests inside fetch-poe.js, one data command per Chrome
 * endpoint at a time. The only account-visible effects are POE's own "recently viewed
 * niches" list and, when the structured account options ask for it, a switch
 * of the selected account and marketplace through the account picker. On any
 * error after its tab started loading Seller Central, including a failed
 * fetch, a rejected response, a batch with failed niches or Ctrl+C, the run
 * exits non-zero and keeps its tab for inspection. Diagnostics print URLs
 * without their query string.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCdpEndpoint, evaluate } from "./lib/cdp.mjs";
import { normalizeOrigin, accountPickerUrl, accountMatches, switchAccount, readIdentity, inspectPage, waitFor, probeTab, doctorVerdict,
  identityFieldsConsistent, IDENTITY_SETTLE_MS } from "./lib/sc-account.mjs";
import { displayUrl } from "./lib/redact.mjs";
import { formatEnvelope } from "./format-poe.mjs";
import { accountProfileMatches } from "./lib/account-selection.mjs";
import { resolveOutDir, prepareStore, publishFiles } from "./lib/local-store.mjs";
import { acquireRunLock } from "./lib/run-lock.mjs";
import { parseOptions } from "./lib/args.mjs";
import { CC_MP, CC_ORIGIN, MP_CC, assertOriginMatchesMarketplace, ccForOrigin, regionForMarketplace, regionForOrigin } from "./lib/marketplaces.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FETCH_SRC = fs.readFileSync(path.join(HERE, "fetch-poe.js"), "utf8");
let cdp = null;
let storeTarget = null;
let verifiedIdentity = null;
let openTab = null;
const storedArtifacts = [];
const captures = [];
// Batch progress for the receipt, kept at module scope so a fatal error or an
// interrupt still reports it: niches that failed, and niches the batch had not
// finished when it stopped.
const batchState = { started: false, failed: [], pending: [] };

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

// Output folder first, then the per-endpoint run lock, so two runs never
// drive the same Chrome at once.
function configureStorage() {
  storeTarget = prepareStore(resolveOutDir({
    outDir: opt("out-dir", null),
    label: opt("label", null),
  }));
  acquireRunLock({ host: cdp.host, port: cdp.port });
}

function receiptText({ complete = true } = {}) {
  const { failed, pending } = batchState;
  return JSON.stringify({ schema_version: 1, status: complete ? "stored_verified" : "incomplete", complete,
    output_folder: storeTarget.root, artifacts: storedArtifacts, captures,
    ...(failed.length ? { failed } : {}),
    ...(pending.length ? { pending } : {}) });
}

function completeStorage({ complete = true } = {}) {
  if (terminating) return;
  console.log(receiptText({ complete }));
}

// Failure and interrupt exits. process.exit() drops whatever stdout still
// queues for a pipe (a receipt past 64 KiB), so the process exits only once
// the receipt has been written. The first call wins; a second signal while
// the receipt is flushing exits at once.
let terminating = false;
function terminate(code, { receipt = false } = {}) {
  if (terminating) {
    process.exit(code);
    return;
  }
  terminating = true;
  process.exitCode = code;
  if (!receipt) {
    process.exit(code);
    return;
  }
  process.stdout.write(receiptText({ complete: false }) + "\n", () => process.exit(code));
}

// A receipt is printed once a file was stored or a batch reached its niche
// downloads, also when the run fails or is interrupted afterwards.
const receiptDue = () => Boolean(storeTarget && (storedArtifacts.length || batchState.started));

const argv = process.argv.slice(2);
const cmd = argv[0];

// The options each command accepts. An unknown or misspelled option, a stray
// argument, an empty value or a repeated option stops the run before the
// output folder, the run lock or Chrome is touched, so a mistyped account
// option can never fall back to whatever account is active.
const ENDPOINT_OPTIONS = ["marketplace", "origin", "port", "host"];
const DATA_OPTIONS = [...ENDPOINT_OPTIONS, "out-dir", "label", "account-name", "expected-partner-account-id",
  "parent-account-name", "marketplace-label", "expect-account"];
const DATA_FLAGS = ["keep-tab", "verbose"];
const COMMAND_OPTIONS = {
  doctor: { values: ENDPOINT_OPTIONS, flags: ["quick", "keep-tab"] },
  niche: { values: [...DATA_OPTIONS, "niche-id"], flags: DATA_FLAGS },
  search: { values: [...DATA_OPTIONS, "query"], flags: DATA_FLAGS },
  batch: { values: [...DATA_OPTIONS, "queries", "query", "niche-ids", "top"], flags: [...DATA_FLAGS, "all"] },
  "merchant-niches": { values: DATA_OPTIONS, flags: DATA_FLAGS },
  "self-test": { values: [], flags: [] },
};

// Values follow as the next argument or as --name=value (lib/args.mjs).
function parseArgs(command, args) {
  return parseOptions(args, COMMAND_OPTIONS[command], { context: command, hint: 'Run "run-poe.mjs help" for the options.' });
}

let parsed = { values: new Map(), flags: new Set() };
const opt = (name, dflt) => (parsed.values.has(name) ? parsed.values.get(name) : dflt);
const flag = (name) => parsed.flags.has(name);

function parsePort(raw) {
  const text = String(raw ?? "").trim();
  const port = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw codedError("CDP_PORT_INVALID",
      `invalid Chrome debug port ${JSON.stringify(String(raw ?? ""))}: use an integer from 1 to 65535 (--port or CDP_PORT)`);
  }
  return port;
}

function isLoopbackHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

// --host/--port win over CDP_HOST/CDP_PORT, which win over 127.0.0.1:9222.
function resolveEndpoint() {
  const host = opt("host", null) || process.env.CDP_HOST || "127.0.0.1";
  const port = parsePort(opt("port", null) || process.env.CDP_PORT || 9222);
  if (!isLoopbackHost(host)) {
    console.error(`WARNING: Chrome DevTools at ${host}:${port} is not on this machine. The debug port has no authentication and gives full control of that browser and its signed-in sessions. Prefer an SSH tunnel (ssh -L ${port}:127.0.0.1:${port} <remote>) and --host 127.0.0.1.`);
  }
  return createCdpEndpoint({ host, port });
}

const USAGE = `usage: run-poe.mjs <command> [options]

commands:
  doctor [--origin URL | --quick] [--marketplace cc]
                         check Chrome, the Seller Central login, the POE page and the active account
  niche --niche-id ID    download one niche in full (products, search terms, review insights, returns, overview)
  search --query KW      download the related-niches grid for one keyword
  batch --queries "a,b" [--niche-ids id1,id2] [--top N=15 | --all]
                         search each keyword, then download every kept niche in full
                         (--query KW works in place of --queries, not together with it)
  merchant-niches        download the niches POE lists for the active account
  self-test              run the offline self-checks
  help                   print this help

Data commands are niche, search, batch and merchant-niches. Options take their
value as the next argument or after "=", as in --marketplace=us; unknown,
repeated or empty options are rejected with POE_ARGUMENT_INVALID.

options for doctor and the data commands:
  --marketplace cc       required for data commands: ${Object.keys(CC_MP).join(", ")}
  --origin URL           Seller Central origin override (default: derived from --marketplace)
  --port N               Chrome debug port (default: CDP_PORT or 9222)
  --host H               Chrome debug host (default: CDP_HOST or 127.0.0.1)
  --keep-tab             keep the run's tab open after a successful run

options for the data commands only:
  --out-dir DIR          output folder (default: POE_OUT_DIR or ./poe-output)
  --label NAME           optional subfolder inside the output folder
  --verbose              also store the raw capture envelope

account options (data commands only):
  --account-name NAME                seller account name as shown in the account picker
  --expected-partner-account-id ID   partnerAccountId that must match exactly
  --parent-account-name NAME         parent entry to expand in the picker, when applicable
  --marketplace-label LABEL          marketplace label in the picker, e.g. "United States"
  --expect-account TEXT              loose check: name or id the active account must contain or be contained in

--account-name, --expected-partner-account-id and --expect-account are
checked against the active account before any data request.
--marketplace-label and --parent-account-name only steer the account picker
and are rejected without --account-name. A mismatch is switched through the
account picker only when --account-name and --marketplace-label are both
given; otherwise the run stops before fetching.

Output: files in the output folder plus one JSON receipt on stdout.
Environment: CDP_PORT, CDP_HOST, CDP_DEBUG=1 (log every protocol call), POE_OUT_DIR.`;

function usage(code = 1) {
  (code === 0 ? console.log : console.error)(USAGE);
  process.exit(code);
}

// Only the https origins of the Seller Central domains in lib/marketplaces.mjs.
function sellerCentralOrigin(url) {
  try {
    return ccForOrigin(url) ? new URL(url).origin : null;
  } catch (_) {
    return null;
  }
}

// An explicit --origin must be one of those known Seller Central origins, so
// the region check below can never be skipped by an unknown host.
function knownOrigin(value) {
  const origin = sellerCentralOrigin(String(value || ""));
  if (!origin) {
    throw codedError("POE_ORIGIN_UNKNOWN", `--origin ${JSON.stringify(String(value || ""))} is not a known Seller Central origin. Use https://sellercentral.amazon.<domain> for one of: ${Object.keys(CC_ORIGIN).join(", ")}`);
  }
  return origin;
}

function resolveDataOrigin(ccArg, explicitOrigin = null) {
  const cc = String(ccArg || "").toLowerCase();
  let origin;
  if (explicitOrigin) {
    origin = knownOrigin(explicitOrigin);
  } else {
    origin = CC_ORIGIN[cc];
    if (!origin) throw codedError("POE_ORIGIN_UNKNOWN", `cannot infer Seller Central origin for marketplace '${ccArg || ""}'; pass --origin URL`);
  }
  assertOriginMatchesMarketplace(cc, origin);
  return origin;
}

function resolveDoctorOrigins(pages, explicitOrigin = null) {
  if (explicitOrigin) return [knownOrigin(explicitOrigin)];
  const poe = [];
  const other = [];
  for (const page of pages) {
    const origin = sellerCentralOrigin(page.url);
    if (!origin) continue;
    (/\/opportunity-explorer(?:\/|$)/.test(new URL(page.url).pathname) ? poe : other).push(origin);
  }
  return [...new Set([...poe, ...other])];
}

// Every run gets its own background tab, so the user's tabs are never
// navigated. The tab's expected origin is fixed here and rechecked around
// every data request. A tab whose navigation could not even start holds
// nothing to inspect, so it is closed again.
async function openPoePage(origin) {
  const { targetId, session } = await cdp.createPage("about:blank");
  session.expectedOrigin = normalizeOrigin(origin);
  try {
    await session.send("Page.navigate", { url: session.expectedOrigin + "/opportunity-explorer" });
    return { targetId, session };
  } catch (error) {
    session.close();
    await cdp.closePage(targetId).catch(() => {});
    throw error;
  }
}

function poeReadinessError({ pageKind = "unknown", authState = "ambiguous", facts = {} } = {}) {
  const url = facts.url ? displayUrl(facts.url) : "(URL unavailable)";
  const details = `Observed ${pageKind}/${authState} at ${url}`;
  let message;
  let code;
  if (pageKind === "chooser") {
    code = "POE_ACCOUNT_CHOOSER";
    message = `Seller Central is authenticated but stopped at the account chooser. ${details}. Select the account and marketplace in the kept tab, or pass the structured account options so the runner can select it.`;
  } else if (pageKind === "sign-in") {
    code = "POE_SIGNED_OUT";
    message = `Seller Central redirected this origin to sign-in. ${details}. Sign in to Seller Central in the Chrome window, then re-run.`;
  } else if (pageKind === "challenge") {
    code = "POE_HUMAN_CHALLENGE";
    message = `Seller Central is blocked by a human authentication challenge. ${details}. Complete the captcha or one-time code in the kept tab, then re-run.`;
  } else if (pageKind === "auth-failed") {
    code = "POE_AUTHORIZATION_FAILED";
    message = `Seller Central loaded an authorization-failed page instead of Opportunity Explorer. ${details}. Verify this account has Opportunity Explorer access.`;
  } else {
    code = "POE_NOT_READY";
    message = `Opportunity Explorer did not become ready within the timeout. ${details}.`;
  }
  return codedError(code, message);
}

async function waitPoeReady(session, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await evaluate(session,
      `document.readyState === "complete" && !!document.querySelector('meta[name="anti-csrftoken-a2z"]')`, 10000).catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  const page = await inspectPage(session, { timeoutMs: 10000 })
    .catch(() => ({ pageKind: "unknown", authState: "ambiguous", facts: {} }));
  throw poeReadinessError(page);
}

async function waitPoeEntryState(session, timeoutMs = 30000) {
  // createPage returns as soon as the CDP target exists, before navigation has
  // necessarily committed. Identity recovery must not run against that brief
  // loading/about:blank state or a valid session is misread as unknown.
  try {
    await waitFor(session, `document.readyState === "complete" && (
      !!document.querySelector('meta[name="anti-csrftoken-a2z"]')
      || document.querySelectorAll('button.full-page-account-switcher-account-details').length > 0
      || /signin|auth|login|mfa|captcha|\\/ap\\/cvf/.test(location.href)
      || !!document.querySelector('input[type="password"],input[autocomplete="one-time-code"],input[name="guess"]')
    )`, "Opportunity Explorer app, account chooser, or authentication state", timeoutMs);
  } catch (_) {
    const page = await inspectPage(session, { timeoutMs: 10000 })
      .catch(() => ({ pageKind: "unknown", authState: "ambiguous", facts: {} }));
    throw poeReadinessError(page);
  }
}

// The account-picker mechanics (waitFor, trusted clicks, the shadow-DOM
// confirm button, auth-state classification) live in lib/sc-account.mjs.
// POE passes returnTo /opportunity-explorer so a completed switch lands back
// on a POE page ready for GraphQL reads.
async function switchSellerCentralAccount(session, origin, profile) {
  await switchAccount(session, origin, profile, { returnTo: "/opportunity-explorer" });
  await waitPoeReady(session);
}

// Printed only: origin and path, never the query string (a sign-in URL
// carries single-use sign-in parameters there).
async function tabUrl(targetId, fallback) {
  let url = fallback;
  try { url = (await cdp.listPages()).find((page) => page.id === targetId)?.url || fallback; }
  catch (_) { url = fallback; }
  return displayUrl(url);
}

// Open a fresh POE tab, run `work`, and close the tab on success. A failed or
// rejected run keeps its tab so the page state can be inspected, and so does a
// result that sets accountCheckFailed or keepTab.
async function withPoePage(origin, work, { requireReady = true } = {}) {
  await cdp.version();
  const { targetId, session } = await openPoePage(origin);
  openTab = { targetId };
  let keep = false;
  try {
    if (requireReady) await waitPoeReady(session);
    const result = await work(session);
    if (result && (result.accountCheckFailed || result.keepTab)) keep = true;
    return result;
  } catch (error) {
    keep = true;
    throw error;
  } finally {
    session.close();
    if (keep) {
      console.error(`Kept tab ${targetId} (${await tabUrl(targetId, origin)}) for inspection`);
    } else if (flag("keep-tab")) {
      console.error(`Kept tab ${targetId} (${await tabUrl(targetId, origin)}) as requested by --keep-tab`);
    } else {
      await cdp.closePage(targetId).catch((error) => console.error(`Could not close tab ${targetId}: ${error.message}`));
    }
    openTab = null;
  }
}

async function runFetch(session, callExpr) {
  await assertPoeContext(session);
  const expr = `(async function(){ ${FETCH_SRC}\n return await ${callExpr}; })()`;
  const result = await evaluate(session, expr, 180000);
  await assertPoeContext(session);
  return result;
}

async function assertPoeContext(session) {
  const expected = session._poeExpectedIdentity;
  if (!expected) throw new Error("POE_CONTEXT_UNVERIFIED: account preflight is required");
  const actual = await readAccount(session);
  // Read the committed URL as well: a redirect can land while a result and its
  // identity response are already available.
  const actualUrl = await evaluate(session, "location.href", 10000);
  let actualOrigin = null;
  try { actualOrigin = actualUrl ? new URL(actualUrl).origin : null; } catch (_) { actualOrigin = null; }
  if (!actualOrigin || actualOrigin !== session.expectedOrigin) {
    throw new Error(`POE_CONTEXT_CHANGED: origin changed or became unavailable (${actualUrl ? displayUrl(actualUrl) : "none"}); response rejected`);
  }
  assertSameIdentity(expected, actual);
}

// Ids exactly, the display name only when no strong id is available
// (identityFieldsConsistent), and the session marketplace exactly.
function assertSameIdentity(expected, actual) {
  const identity = identityFieldsConsistent(expected, actual);
  if (!identity.ok) {
    throw new Error(`POE_CONTEXT_CHANGED: ${identity.field} changed or became unavailable; response rejected`);
  }
  if (expected.marketplace != null && JSON.stringify(actual.marketplace) !== JSON.stringify(expected.marketplace)) {
    throw new Error("POE_CONTEXT_CHANGED: marketplace changed or became unavailable; response rejected");
  }
}

// Resolve --marketplace <cc> to the marketplace id requested in the GraphQL
// variables. One Seller Central login covers every marketplace of its region,
// so a .de session can read de, it, es, fr and the other EU marketplaces
// directly, without the account picker. Another region needs its own origin.
function requestedMarketplace(ccArg) {
  const cc = String(ccArg || "").toLowerCase();
  if (!cc) throw codedError("POE_MARKETPLACE_REQUIRED", "--marketplace <cc> is required (e.g. --marketplace de). No silent default.");
  const mp = CC_MP[cc];
  if (!mp) throw codedError("POE_MARKETPLACE_UNKNOWN", `unknown marketplace code '${cc}'. Known: ${Object.keys(CC_MP).join(", ")}`);
  return mp;
}

// The marketplace ids the response payload itself reports. fetch-poe.js sets
// env.marketplace to the id it requested, so that field alone proves nothing.
// niche: niche.obfuscatedMarketplaceId. search: every returned niche row.
// merchant-niches: the merchant info (an object or a list of them); the
// merchantNiches[] entries are not compared, because they may list other
// marketplaces.
function reportedMarketplaces(env) {
  if (env.kind === "niche") return [env.niche?.obfuscatedMarketplaceId];
  if (env.kind === "search") return (env.niches || []).map((n) => n?.obfuscatedMarketplaceId);
  if (env.kind === "merchant-niches") {
    const info = env.merchantInfo;
    return (Array.isArray(info) ? info : info ? [info] : []).map((m) => m?.obfuscatedMarketplaceId);
  }
  return [env.marketplace];
}

function assertMarketplace(env, mpExpected) {
  if (env.marketplace !== mpExpected) {
    throw codedError("POE_MARKETPLACE_MISMATCH",
      `the ${env.kind} request was sent for marketplace ${env.marketplace}, requested ${mpExpected}; response rejected`);
  }
  // An empty search result or an empty merchant list has nothing to compare.
  for (const reported of reportedMarketplaces(env)) {
    if (reported !== mpExpected) {
      throw codedError("POE_MARKETPLACE_MISMATCH",
        `the ${env.kind} response reports marketplace ${reported || "(none)"}, requested ${mpExpected}; response rejected`);
    }
  }
}

// The niche the response reports must be the niche that was requested.
function assertNicheId(env, requested) {
  const reported = env.niche?.nicheId;
  if (reported !== requested) {
    throw codedError("POE_NICHE_MISMATCH",
      `the niche response reports niche ${reported || "(none)"}, requested ${requested}; response rejected`);
  }
}

// A fetch error is reported before the marketplace check, so an error
// envelope without a marketplace does not masquerade as a mismatch.
function checkEnvelope(env, mpExpected) {
  if (env.error) throw codedError("POE_FETCH_FAILED", `POE fetch failed: ${env.error}`);
  assertMarketplace(env, mpExpected);
}

// Resolve the ACTIVE Seller Central account from the live POE session.
// Identity comes from lib/sc-account.mjs readIdentity (GetUserContext ids plus
// the account-switcher display name). accountMatches also comes from there.
// `settle` gives the account header up to IDENTITY_SETTLE_MS to render and
// then takes the display name only from the exact or header selectors.
async function readAccount(session, { settle = false } = {}) {
  return readIdentity(session, { timeoutMs: 30000, settleMs: settle ? IDENTITY_SETTLE_MS : 0 });
}

// `expectations` lists every account option the user gave as
// [optionName, value]; each one must match.
function assertAccount(acct, expectations) {
  const label = acct.displayName || acct.partnerAccountId || "(unknown account)";
  console.error(`Account: ${label}${acct.partnerAccountId ? ` [partnerAccountId=${acct.partnerAccountId}]` : ""}`);
  if (!expectations.length) {
    console.error("NOTE: no expected account given; confirm this is the account you intend; POE records viewed niches in this account's history.");
    return true;
  }
  const cands = [acct.displayName, acct.partnerAccountId, acct.merchantId].filter(Boolean);
  if (!cands.length) {
    const [optionName, expected] = expectations[0];
    console.error(`ACCOUNT CHECK FAILED: ${optionName} "${expected}" was given but the session's account identity could not be resolved${acct.err ? ` (${acct.err})` : ""}.`);
    console.error("The account must be recovered and revalidated before any POE request.");
    return false;
  }
  for (const [optionName, expected] of expectations) {
    if (!accountMatches(acct, expected)) {
      console.error(`ACCOUNT MISMATCH: ${optionName} expects "${expected}" but the active session is "${label}" [partnerAccountId=${acct.partnerAccountId || "?"}].`);
      console.error("The account must be recovered and revalidated before any POE request.");
      return false;
    }
  }
  return true;
}

function structuredAccountMatches(acct, accountName, expectedId) {
  // Without --account-name a run may read another marketplace of the same
  // region through the active session, so the session marketplace is not
  // compared here. The response marketplace check (assertMarketplace) still
  // applies to every response.
  if (!accountName) return !expectedId || acct.partnerAccountId === expectedId;
  return accountProfileMatches(acct, {
    accountName, expectedPartnerAccountId: expectedId,
    marketplace: opt("marketplace", null),
    marketplaceId: CC_MP[String(opt("marketplace", "")).toLowerCase()],
    marketplaceLabel: opt("marketplace-label", null),
  });
}

// One account preflight per command, before any data fetch. Returns the
// verified identity, or null when the account did not verify.
async function accountPreflight(session) {
  const expectedId = opt("expected-partner-account-id", null);
  const accountName = opt("account-name", null);
  // Every account option given is checked, none shadows another.
  const expectations = [["--expected-partner-account-id", expectedId], ["--expect-account", opt("expect-account", null)],
    ["--account-name", accountName]].filter(([, value]) => value);
  let acct = await readAccount(session, { settle: true });
  if (assertAccount(acct, expectations) && structuredAccountMatches(acct, accountName, expectedId)) return acct;
  const marketplaceLabel = opt("marketplace-label", null);
  if (!accountName || !marketplaceLabel) {
    console.error("ACCOUNT SWITCH NOT ATTEMPTED: structured account options are incomplete. No POE data was fetched.");
    return null;
  }
  console.error(`Recovering Seller Central session through the account picker: ${accountName} / ${marketplaceLabel}`);
  try {
    await switchSellerCentralAccount(session, resolveDataOrigin(opt("marketplace", null), opt("origin", null)), {
      accountName,
      parentAccountName: opt("parent-account-name", null),
      marketplaceLabel,
      marketplace: opt("marketplace", null),
    });
  } catch (error) {
    console.error(String(error.message || error));
    console.error("ACCOUNT RECOVERY FAILED. No POE data was fetched.");
    return null;
  }
  acct = await readAccount(session, { settle: true });
  if (!assertAccount(acct, expectations) || !structuredAccountMatches(acct, accountName, expectedId)) {
    console.error("POST-SWITCH ACCOUNT CHECK FAILED. No POE data was fetched.");
    return null;
  }
  console.error("Account recovery succeeded and the partner account identity was revalidated.");
  return acct;
}

async function withAccountCheckedPoePage(origin, work) {
  const result = await withPoePage(origin, async (session) => {
    await waitPoeEntryState(session);
    const verified = await accountPreflight(session);
    if (!verified) return { accountCheckFailed: true };
    // Account recovery must be allowed to run from the authenticated chooser.
    // Requiring the POE meta tag before this point made recovery unreachable
    // and mislabeled a valid login as a login failure.
    await waitPoeReady(session);
    // The baseline is read only now: POE is ready and the account header had
    // time to render, so a late header cannot be misread as a changed account.
    const baseline = await readAccount(session, { settle: true });
    assertSameIdentity(verified, baseline);
    if (!["merchantId", "partnerAccountId", "displayName"].some((key) => baseline[key])) {
      throw new Error("POE_CONTEXT_UNVERIFIED: no account identity is observable");
    }
    session._poeExpectedIdentity = baseline;
    verifiedIdentity = { ...baseline, displayName: baseline.displayName || verified.displayName || null };
    await assertPoeContext(session);
    const value = await work(session);
    return { value, keepTab: Boolean(value && value.keepTab) };
  }, { requireReady: false });
  if (result.accountCheckFailed) throw codedError("POE_ACCOUNT_CHECK_FAILED", "the active Seller Central account did not verify; no POE data was fetched");
  return result.value;
}

function finish(env, { verbose }) {
  if (env.error) throw codedError("POE_FETCH_FAILED", `POE fetch failed: ${env.error}`);
  const account = verifiedIdentity ? {
    displayName: verifiedIdentity.displayName || null,
    partnerAccountId: verifiedIdentity.partnerAccountId || null,
    // The session's selected marketplace. In a same-region read it can differ
    // from the data's marketplace, which the overview's `marketplace` holds.
    sessionMarketplaceId: typeof verifiedIdentity.marketplace === "string" ? verifiedIdentity.marketplace : null,
  } : undefined;
  const files = formatEnvelope(env, { account });
  if (verbose) files.push({ name: `${(env.capturedAt || new Date().toISOString()).replace(/[:]/g, "-")}_poe_${env.kind}_raw.json`, content: JSON.stringify(env, null, 1) });
  let receipt;
  try {
    receipt = publishFiles(files, storeTarget);
  } catch (error) {
    // Files of this set stored before the failure still go into the receipt.
    if (Array.isArray(error.artifacts)) storedArtifacts.push(...error.artifacts);
    throw error;
  }
  storedArtifacts.push(...receipt.artifacts);
  captures.push({ kind: env.kind, captured_at: env.capturedAt,
    last_updated: env.niche?.lastUpdatedTimeISO8601 || null });
  console.error(`Stored ${receipt.artifacts.length} POE files in ${receipt.output_folder}`);
}

function selfTest() {
  const codeOf = (fn) => {
    try { fn(); return "no error"; } catch (error) { return error.code || error.message; }
  };
  const checks = [
    [resolveDataOrigin("de"), "https://sellercentral.amazon.de"],
    [resolveDataOrigin("uk"), "https://sellercentral.amazon.co.uk"],
    [resolveDataOrigin("us"), "https://sellercentral.amazon.com"],
    [resolveDataOrigin("de", "https://sellercentral.amazon.fr/path"), "https://sellercentral.amazon.fr"],
    [resolveDataOrigin("fr", "https://sellercentral.amazon.de"), "https://sellercentral.amazon.de"],
    [codeOf(() => resolveDataOrigin("fr", "https://sellercentral.amazon.com")), "ORIGIN_MARKETPLACE_REGION_MISMATCH"],
    [codeOf(() => resolveDataOrigin("xx")), "POE_ORIGIN_UNKNOWN"],
    [codeOf(() => resolveDataOrigin("us", "https://sellercentral-europe.amazon.com")), "POE_ORIGIN_UNKNOWN"],
    [codeOf(() => resolveDataOrigin("de", "http://sellercentral.amazon.de")), "POE_ORIGIN_UNKNOWN"],
    [codeOf(() => resolveDataOrigin("us", "https://sellercentral.amazon.evil.example")), "POE_ORIGIN_UNKNOWN"],
    [codeOf(() => requestedMarketplace("")), "POE_MARKETPLACE_REQUIRED"],
    [codeOf(() => requestedMarketplace("zz")), "POE_MARKETPLACE_UNKNOWN"],
    [codeOf(() => parsePort("abc")), "CDP_PORT_INVALID"],
    [codeOf(() => parsePort(70000)), "CDP_PORT_INVALID"],
    [codeOf(() => parsePort("0")), "CDP_PORT_INVALID"],
    [parsePort("9222"), 9222],
    [isLoopbackHost("127.0.0.1") && isLoopbackHost("localhost") && isLoopbackHost("[::1]"), true],
    [isLoopbackHost("192.0.2.10"), false],
    [resolveDoctorOrigins([
      { url: "https://sellercentral.amazon.com/amazonsell/business" },
      { url: "https://sellercentral.amazon.de/opportunity-explorer" },
      { url: "https://sellercentral.amazon.evil.example/opportunity-explorer" },
      { url: "https://example.com/" },
    ]).join(","), "https://sellercentral.amazon.de,https://sellercentral.amazon.com"],
    [accountPickerUrl("https://sellercentral.amazon.com", "/opportunity-explorer"), "https://sellercentral.amazon.com/account-switcher/default/merchantMarketplace?returnTo=%2Fopportunity-explorer"],
    [accountMatches({ displayName: "Example Seller United States", partnerAccountId: "AEXAMPLE000001" }, "AEXAMPLE000001"), true],
    [accountMatches({ displayName: "Other account", partnerAccountId: "OTHER" }, "AEXAMPLE000001"), false],
    [poeReadinessError({ pageKind: "chooser", authState: "authenticated", facts: { url: "https://sellercentral.amazon.de/account-switcher/default/merchantMarketplace" } }).code, "POE_ACCOUNT_CHOOSER"],
    [poeReadinessError({ pageKind: "sign-in", authState: "logged_out", facts: { url: "https://sellercentral.amazon.de/ap/signin" } }).code, "POE_SIGNED_OUT"],
    [/openid|ssoResponse|FAKE-SSO/.test(poeReadinessError({ pageKind: "sign-in", authState: "logged_out",
      facts: { url: "https://sellercentral.amazon.com/ap/signin?openid.return_to=x&ssoResponse=FAKE-SSO-VALUE" } }).message), false],
    [codeOf(() => assertMarketplace({ kind: "niche", marketplace: CC_MP.us, niche: { obfuscatedMarketplaceId: CC_MP.us } }, CC_MP.us)), "no error"],
    [codeOf(() => assertMarketplace({ kind: "niche", marketplace: CC_MP.us, niche: { obfuscatedMarketplaceId: CC_MP.de } }, CC_MP.us)), "POE_MARKETPLACE_MISMATCH"],
    [codeOf(() => assertMarketplace({ kind: "niche", marketplace: CC_MP.us, niche: {} }, CC_MP.us)), "POE_MARKETPLACE_MISMATCH"],
    [codeOf(() => assertMarketplace({ kind: "search", marketplace: CC_MP.us, niches: [] }, CC_MP.us)), "no error"],
    [codeOf(() => assertMarketplace({ kind: "search", marketplace: CC_MP.us, niches: [{ obfuscatedMarketplaceId: CC_MP.us }, { obfuscatedMarketplaceId: CC_MP.ca }] }, CC_MP.us)), "POE_MARKETPLACE_MISMATCH"],
    [codeOf(() => assertMarketplace({ kind: "merchant-niches", marketplace: CC_MP.us, merchantInfo: { obfuscatedMarketplaceId: CC_MP.us, merchantNiches: [{ obfuscatedMarketplaceId: CC_MP.ca }] } }, CC_MP.us)), "no error"],
    [codeOf(() => assertMarketplace({ kind: "merchant-niches", marketplace: CC_MP.us, merchantInfo: [{ obfuscatedMarketplaceId: CC_MP.uk }] }, CC_MP.us)), "POE_MARKETPLACE_MISMATCH"],
    [codeOf(() => assertNicheId({ niche: { nicheId: "NICHE1" } }, "NICHE1")), "no error"],
    [codeOf(() => assertNicheId({ niche: { nicheId: "NICHE2" } }, "NICHE1")), "POE_NICHE_MISMATCH"],
    [codeOf(() => assertNicheId({ niche: {} }, "NICHE1")), "POE_NICHE_MISMATCH"],
    [marketplaceVerdict("fr", [{ origin: "https://sellercentral.amazon.de", identity: { marketplace: CC_MP.de } }]).kind, "same-region"],
    [marketplaceVerdict("us", [{ origin: "https://sellercentral.amazon.de", identity: { marketplace: CC_MP.de } }]).kind, "wrong-region"],
    [marketplaceVerdict("de", [{ origin: "https://sellercentral.amazon.de", identity: { marketplace: CC_MP.de } }]).kind, "match"],
  ];
  checks.forEach(([actual, expected], index) => {
    if (actual !== expected) throw new Error(`self-test check ${index + 1} failed: expected ${expected}, got ${actual}`);
  });
  console.log(`run-poe self-test: ${checks.length}/${checks.length} passed`);
}

function describeAccount(acct) {
  const mp = typeof acct.marketplace === "string" ? acct.marketplace : null;
  return `${acct.displayName || acct.partnerAccountId || "(unresolved)"}`
    + `${acct.partnerAccountId ? ` [partnerAccountId=${acct.partnerAccountId}]` : ""}`
    + ` marketplace=${mp || "?"} (${(mp && MP_CC[mp]) || "?"})`
    + `${acct.err ? ` (note: ${String(acct.err).slice(0, 160)})` : ""}`;
}

// Compare the requested marketplace with what the session shows. A known
// marketplace id decides the region; otherwise the page origin does.
function marketplaceVerdict(cc, observations) {
  const wantedId = CC_MP[cc];
  const wantedRegion = regionForMarketplace(cc);
  const rank = { match: 3, "same-region": 2, "wrong-region": 1 };
  let best = null;
  for (const { origin, identity } of observations) {
    const mp = typeof identity?.marketplace === "string" ? identity.marketplace : null;
    const region = mp && MP_CC[mp] ? regionForMarketplace(MP_CC[mp]) : regionForOrigin(origin);
    const kind = mp && mp === wantedId ? "match"
      : region && region === wantedRegion ? "same-region"
      : region ? "wrong-region" : null;
    if (kind && (!best || rank[kind] > rank[best.kind])) best = { kind, origin, mp, region };
  }
  if (!best) {
    return { kind: "unknown", ok: false,
      text: `Marketplace: could not verify ${cc}; no account identity or Seller Central origin was observed.` };
  }
  if (best.kind === "match") {
    return { ...best, ok: true, text: `Marketplace: match. The active marketplace is ${cc} (${wantedId}) at ${best.origin}.` };
  }
  if (best.kind === "same-region") {
    const current = best.mp ? `${(MP_CC[best.mp]) || best.mp}` : "an unreported marketplace";
    return { ...best, ok: true, text: `Marketplace: same region (${best.region}). The session is on ${current} at ${best.origin}. `
      + `Unstructured runs read ${cc} through this regional login; structured runs (--account-name and --marketplace-label) `
      + `switch to ${cc} through the account picker first.` };
  }
  return { ...best, ok: false, text: `Marketplace: WRONG REGION. ${cc} is in region ${wantedRegion}, but the session at ${best.origin} `
    + `is in region ${best.region}. Open ${CC_ORIGIN[cc]}/opportunity-explorer in the Chrome window, sign in, then re-run.` };
}

async function doctor() {
  // --quick judges only the open tabs, so an --origin would be silently ignored.
  if (flag("quick") && parsed.values.has("origin")) {
    throw codedError("POE_ARGUMENT_INVALID", "doctor --quick uses only the open Seller Central tabs and ignores --origin; drop one of the two");
  }
  const explicitOrigin = opt("origin", null) ? knownOrigin(opt("origin", null)) : null;
  const cc = opt("marketplace", null) ? String(opt("marketplace", null)).toLowerCase() : null;
  if (cc) requestedMarketplace(cc);
  let ok = true;

  // 1) Chrome reachable
  let ver;
  try {
    ver = await cdp.version();
  } catch (error) {
    console.log(`Chrome: not reachable (${error.code || "CDP_UNREACHABLE"}). ${error.message}`);
    return 1;
  }
  console.log(`Chrome: ${ver.Browser || "unknown"} (protocol ${ver["Protocol-Version"] || "?"}) at ${cdp.base}`);

  // 2) Seller Central tabs
  const pages = await cdp.listPages();
  const sc = pages.filter((page) => sellerCentralOrigin(page.url));
  console.log(`Seller Central tabs: ${sc.length}`);
  for (const page of sc) console.log(`  ${page.id} ${displayUrl(page.url).slice(0, 100)}`);
  const fallbackOrigin = explicitOrigin || (cc ? CC_ORIGIN[cc] : null);
  let probes = [];
  if (!sc.length) {
    if (!fallbackOrigin) {
      console.log("No Seller Central tab is open. In the Chrome window started with --remote-debugging-port, open "
        + "https://sellercentral.amazon.<tld>/opportunity-explorer (for example sellercentral.amazon.com or sellercentral.amazon.de), "
        + "sign in, then re-run. Passing --marketplace cc lets doctor open the page itself.");
      return 1;
    }
    console.log(flag("quick") ? "No Seller Central tab is open."
      : `No Seller Central tab is open; skipping the tab probe and checking ${fallbackOrigin} directly.`);
  } else {
    // 3) read-only probe of every open Seller Central tab, no navigation
    probes = await Promise.all(sc.map((page) => probeTab(page)));
    for (const probe of probes) {
      console.log(`  [${probe.state}] ${probe.pageKind || "?"} ${displayUrl(probe.url).slice(0, 90)}`
        + `${probe.identity ? ` account=${describeAccount(probe.identity)}` : ""}${probe.reason ? ` (${probe.reason})` : ""}`);
    }
    const verdict = doctorVerdict(probes);
    console.log(verdict.text);
    // --quick judges the open tabs only. Otherwise a stale or signed-out tab
    // does not decide: the fresh tab below checks what a data run would see.
    if (verdict.exitCode) {
      if (flag("quick")) return verdict.exitCode;
      console.log("The open tabs are not ready; checking a fresh Opportunity Explorer tab instead.");
    }
  }

  // 4) open POE in a fresh tab per origin and read the active account
  const observations = [];
  if (!flag("quick")) {
    const origins = explicitOrigin ? [explicitOrigin] : sc.length ? resolveDoctorOrigins(sc) : [fallbackOrigin];
    // A data run for --marketplace opens that marketplace's own origin, so
    // doctor checks it as well when no open tab is in that region.
    if (!explicitOrigin && cc && !origins.some((origin) => regionForOrigin(origin) === regionForMarketplace(cc))) {
      origins.push(CC_ORIGIN[cc]);
    }
    for (const origin of origins) {
      try {
        const acct = await withPoePage(origin, (session) => readAccount(session, { settle: true }));
        console.log(`POE ${origin}: ready`);
        console.log(`Active account: ${describeAccount(acct)}`);
        observations.push({ origin, identity: acct });
      } catch (error) {
        ok = false;
        console.log(`POE ${origin}: ${error.code || "POE_NOT_READY"}: ${String(error.message || error).split("\n")[0]}`);
      }
    }
  } else if (!sc.length) {
    console.log("Login: not verified (no Seller Central tab is open and --quick skips the POE check).");
    return 1;
  } else {
    for (const probe of probes) {
      if (probe.state === "signed-in") observations.push({ origin: sellerCentralOrigin(probe.url), identity: probe.identity });
    }
  }

  // 5) requested marketplace against the observed session
  if (cc) {
    const verdict = marketplaceVerdict(cc, observations);
    console.log(verdict.text);
    if (!verdict.ok) ok = false;
  }
  console.log(ok ? "Doctor: ready." : "Doctor: NOT ready.");
  return ok ? 0 : 1;
}

async function runDataCommand() {
  const marketplace = opt("marketplace", null);
  const verbose = flag("verbose");
  let call = null;
  let queries = [];
  let nicheIds = [];
  let top = 15;
  let nicheId = null;
  if (cmd === "niche") {
    nicheId = opt("niche-id", null);
    if (!nicheId) throw codedError("POE_ARGUMENT_INVALID", "--niche-id is required for niche");
    call = (mp) => `fetchPoeNiche(${JSON.stringify({ nicheId, obfuscatedMarketplaceId: mp })})`;
  } else if (cmd === "search") {
    const query = opt("query", null);
    if (!query) throw codedError("POE_ARGUMENT_INVALID", "--query is required for search");
    call = (mp) => `fetchPoeSearch(${JSON.stringify({ query, obfuscatedMarketplaceId: mp })})`;
  } else if (cmd === "merchant-niches") {
    call = (mp) => `fetchPoeMerchantNiches(${JSON.stringify({ obfuscatedMarketplaceId: mp })})`;
  } else {
    if (parsed.values.has("queries") && parsed.values.has("query")) {
      throw codedError("POE_ARGUMENT_INVALID", "batch takes --queries or --query, not both; put every keyword in one of them");
    }
    if (parsed.values.has("top") && flag("all")) {
      throw codedError("POE_ARGUMENT_INVALID", "--top and --all both limit the search niches; drop one of the two");
    }
    queries = (opt("queries", opt("query", "")) || "").split(",").map((q) => q.trim()).filter(Boolean);
    nicheIds = (opt("niche-ids", "") || "").split(",").map((x) => x.trim()).filter(Boolean);
    if (!queries.length && !nicheIds.length) {
      throw codedError("POE_ARGUMENT_INVALID", "batch needs --queries (or --query) or --niche-ids");
    }
    top = flag("all") ? Infinity : Number(opt("top", "15"));
    if (top !== Infinity && (!Number.isInteger(top) || top < 1)) {
      throw codedError("POE_ARGUMENT_INVALID", "--top must be a positive integer (or use --all)");
    }
  }
  // The picker options mean nothing without --account-name; accepting them
  // alone would suggest a check that never runs.
  if (!opt("account-name", null)) {
    for (const name of ["marketplace-label", "parent-account-name"]) {
      if (parsed.values.has(name)) {
        throw codedError("POE_ARGUMENT_INVALID", `--${name} only steers the account picker and needs --account-name; add --account-name or drop --${name}`);
      }
    }
  }
  // Validate everything that needs no browser before touching the output
  // folder, the run lock or Chrome.
  const mp = requestedMarketplace(marketplace);
  const origin = resolveDataOrigin(marketplace, opt("origin", null));
  configureStorage();

  if (cmd !== "batch") {
    // Checked and stored while the tab is still open, so a fetch error or a
    // rejected response keeps the tab for inspection.
    await withAccountCheckedPoePage(origin, async (session) => {
      const env = await runFetch(session, call(mp));
      checkEnvelope(env, mp);
      if (cmd === "niche") assertNicheId(env, nicheId);
      finish(env, { verbose });
    });
    completeStorage();
    return 0;
  }

  // batch: search, union/dedupe, then download every kept niche in full.
  const { failed } = batchState;
  await withAccountCheckedPoePage(origin, async (session) => {
    // 1) searches (paced inside fetch-poe), union by nicheId, keep search order (UI relevance)
    const byId = new Map();
    for (const q of queries) {
      const env = await runFetch(session, `fetchPoeSearch(${JSON.stringify({ query: q, obfuscatedMarketplaceId: mp })})`);
      if (env.error) throw codedError("POE_SEARCH_FAILED", `search "${q}" failed: ${env.error}`);
      assertMarketplace(env, mp);
      finish(env, { verbose }); // per-query related-niches files
      for (const n of env.niches || []) if (!byId.has(n.nicheId)) byId.set(n.nicheId, n.nicheTitle);
      console.error(`search "${q}": ${(env.niches || []).length} niches (union now ${byId.size})`);
    }
    // --top limits the search results only; every explicit --niche-ids entry
    // is downloaded.
    const searchIds = [...byId.keys()];
    const ids = searchIds.slice(0, top);
    if (searchIds.length > ids.length) console.error(`NOTE: downloading the top ${ids.length} of ${searchIds.length} search niches (relevance order). Use --all or --top N for more.`);
    for (const id of nicheIds) {
      if (!byId.has(id)) byId.set(id, null);
      if (!ids.includes(id)) ids.push(id);
    }

    // 2) full download per niche, sequential (fetch-poe paces each heavy call).
    // A rejected response (marketplace, context or format) stops the batch; it
    // is listed in `failed`, and the niches after it stay in `pending`.
    batchState.started = true;
    batchState.pending = ids.map((id) => ({ id, title: byId.get(id) }));
    const done = (id) => { batchState.pending = batchState.pending.filter((entry) => entry.id !== id); };
    let ok = 0;
    for (const [i, id] of ids.entries()) {
      let env;
      try {
        env = await runFetch(session, `fetchPoeNiche(${JSON.stringify({ nicheId: id, obfuscatedMarketplaceId: mp })})`);
        if (!env.error) {
          assertMarketplace(env, mp);
          assertNicheId(env, id);
          finish(env, { verbose });
        }
      } catch (error) {
        failed.push({ id, title: byId.get(id), error: error.code ? `${error.code}: ${error.message}` : String(error.message || error) });
        done(id);
        throw error;
      }
      done(id);
      if (env.error) {
        failed.push({ id, title: byId.get(id), error: env.error });
        console.error(`[${i + 1}/${ids.length}] ${byId.get(id) || id} FAILED: ${env.error}`);
        continue;
      }
      ok += 1;
      console.error(`[${i + 1}/${ids.length}] ${env.niche.nicheTitle} OK`);
    }
    console.error(`batch done: ${ok}/${ids.length} niches downloaded${failed.length ? `, ${failed.length} FAILED` : ""}`);
    return { keepTab: failed.length > 0 };
  });
  completeStorage({ complete: !failed.length });
  if (failed.length) {
    console.error(JSON.stringify(failed, null, 1));
    return 1;
  }
  return 0;
}

async function main() {
  if (cmd === "help" || cmd === "--help" || argv.includes("--help")) usage(0);
  if (!cmd) usage(0);
  if (!Object.hasOwn(COMMAND_OPTIONS, cmd)) usage(1);
  parsed = parseArgs(cmd, argv.slice(1));
  if (cmd === "self-test") { selfTest(); return 0; }
  // Ctrl+C or a kill: report the open tab and exit, which also releases the
  // run lock through its exit handler.
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    process.on(signal, () => {
      if (!terminating) console.error(`Interrupted by ${signal}.${openTab ? ` Kept tab ${openTab.targetId} for inspection.` : ""}`);
      terminate(code, { receipt: receiptDue() });
    });
  }
  cdp = resolveEndpoint();
  if (cmd === "doctor") return doctor();
  return runDataCommand();
}

main().then((code) => { if (!terminating) process.exitCode = code ?? 0; }, (e) => {
  // An interrupt is already exiting with its own code and receipt.
  if (terminating) return;
  console.error(e && e.code ? `${e.code}: ${e.message}` : (e && e.message) || String(e));
  // Files already stored before the failure, and a started batch's failed and
  // pending niches, are still listed, marked incomplete.
  terminate(1, { receipt: receiptDue() });
});
