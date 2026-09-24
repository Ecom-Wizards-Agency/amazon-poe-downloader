import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { identityFieldsConsistent, identityFromDocument, readIdentity } from "../lib/sc-account.mjs";

const origin = "https://sellercentral.amazon.com";
const metaSelector = 'meta[name="anti-csrftoken-a2z"]';
const nameSelector = '#sc-mkt-picker-switcher-select';
const loginSelector = 'input[type="password"],input[type="email"],#ap_email';
const homeHtml = '<meta name="anti-csrftoken-a2z" content="fixture-token"><div id="sc-mkt-picker-switcher-select"> Example Brand / United States </div>';
const signInHtml = '<html><title>Amazon Sign-In</title><input type="password"></html>';
const context = { partnerAccountId: "PARTNER_A", merchantId: "SELLER_A", marketplaceSelection: "ATVPDKIKX0DER" };

// Document-shaped fixtures test the shared selectors without implementing an HTML parser.
function doc({ token = null, name = null, selectors = {} } = {}) {
  const nodes = {
    [metaSelector]: token === null ? null : { getAttribute: attr => attr === "content" ? token : null },
    [nameSelector]: name === null ? null : { textContent: name },
    ...selectors,
  };
  return { querySelector: selector => nodes[selector] || null };
}

async function read({ page = doc(), homeDoc = doc({ token: "fixture-token", name: "Example Brand / United States" }),
  html = homeHtml, homeUrl = `${origin}/amazonsell/business`, homeStatus = 200,
  homeError = null, graphqlStatus = 200, graphqlError = null, settleMs = 0 } = {}) {
  const calls = [];
  let parsed = false;
  const session = {
    async send(method, params) {
      if (method === "Runtime.enable") return {};
      assert.equal(method, "Runtime.evaluate");
      const value = await runInNewContext(params.expression, {
        document: page, location: { origin }, URL, setTimeout,
        DOMParser: class {
          parseFromString(actualHtml, type) {
            assert.equal(actualHtml, html);
            assert.equal(type, "text/html");
            parsed = true;
            return homeDoc;
          }
        },
        async fetch(url, options) {
          calls.push({ url, options });
          assert.equal(options.credentials, "include");
          assert.equal(options.mode, "same-origin", "redirects must not escape the current Seller Central origin");
          if (url === `${origin}/home`) {
            if (homeError) throw homeError;
            return { ok: homeStatus === 200, status: homeStatus, url: homeUrl, text: async () => html };
          }
          assert.equal(url, `${origin}/ox-api/graphql`);
          assert.equal(options.method, "POST");
          assert.equal(JSON.parse(options.body).operationName, "GetUserContext");
          if (graphqlError) throw graphqlError;
          return { ok: graphqlStatus === 200, status: graphqlStatus, json: async () => ({ data: { userContext: context } }) };
        },
      });
      return { result: { value: JSON.parse(JSON.stringify(value)) } };
    },
    close() { assert.fail("identity evaluation must complete without closing the session"); },
  };
  return { identity: await readIdentity(session, { settleMs }), calls, parsed };
}

function expectIds(identity, source) {
  assert.deepEqual(identity, {
    displayName: "Example Brand / United States", partnerAccountId: "PARTNER_A", merchantId: "SELLER_A",
    marketplace: "ATVPDKIKX0DER", err: null, source,
  });
}

test("identityFromDocument reads detached picker text, normalizes whitespace, and keeps selector order", () => {
  assert.deepEqual(identityFromDocument(doc({ token: "fixture-token", name: "\n Example Brand  /\n United States " })),
    { token: "fixture-token", displayName: "Example Brand / United States" });
  assert.equal(identityFromDocument(doc({ name: "fallback", selectors: {
    '[data-test="current-account"]': { innerText: "live account", textContent: "other text" },
  } })).displayName, "live account");
  assert.equal(identityFromDocument(doc({ name: "x".repeat(100) })).displayName.length, 80);
  assert.deepEqual(identityFromDocument(doc()), { token: null, displayName: null });
});

test("readIdentity evaluates the page script and keeps the live-page path", async () => {
  const { identity, calls, parsed } = await read({ page: doc({ token: "page-token", name: "Example Brand / United States" }) });
  expectIds(identity, "page");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers["anti-csrftoken-a2z"], "page-token");
  assert.equal(parsed, false);
});

test("GetUserContext selects only account identity fields", async () => {
  const { calls } = await read({ page: doc({ token: "page-token" }) });
  const { query } = JSON.parse(calls[0].options.body);
  assert.equal(query, "query GetUserContext { userContext { partnerAccountId merchantId marketplaceSelection __typename } }");
});

test("readIdentity fills all baseline fields from /home on a Seller Central page without the meta tag", async () => {
  const { identity, calls, parsed } = await read();
  expectIds(identity, "home");
  assert.equal(parsed, true);
  assert.deepEqual(calls.map(call => call.url), [`${origin}/home`, `${origin}/ox-api/graphql`]);
  assert.equal(calls[1].options.headers["anti-csrftoken-a2z"], "fixture-token");
  assert.deepEqual(Object.keys(identity).sort(), ["displayName", "partnerAccountId", "merchantId", "marketplace", "err", "source"].sort());
});

test("readIdentity prefers the live name over the fetched home name", async () => {
  const { identity } = await read({ page: doc({ name: "Live account" }) });
  assert.equal(identity.displayName, "Live account");
  assert.equal(identity.source, "home");
});

for (const [label, options, error] of [
  ["missing home meta", { homeDoc: doc(), html: signInHtml }, /no anti-csrftoken-a2z meta tag/],
  ["home transport failure", { homeError: new Error("network unavailable") }, /network unavailable/],
  ["home HTTP failure", { homeStatus: 503 }, /HTTP 503/],
  ["sign-in redirect", { homeUrl: `${origin}/ap/signin` }, /sign-in page/],
  ["sign-in HTML", { homeDoc: doc({ selectors: { [loginSelector]: {} } }), html: signInHtml }, /sign-in page/],
  ["foreign redirect response", { homeUrl: "https://www.amazon.com/ap/signin" }, /outside the Seller Central origin/],
]) {
  test(`readIdentity fails closed on ${label}`, async () => {
    const { identity, calls } = await read(options);
    assert.match(identity.err, error);
    assert.equal(identity.source, "home");
    assert.equal(identity.merchantId, null);
    assert.equal(identity.partnerAccountId, null);
    assert.equal(identity.marketplace, null);
    assert.equal(calls.length, 1, "must not query GraphQL after failed home verification");
  });
}

for (const [options, error] of [
  [{ graphqlStatus: 403 }, /GetUserContext not authorized \(403\)/],
  [{ graphqlError: new Error("offline") }, /GetUserContext transport failed: Error: offline/],
]) {
  test(`readIdentity preserves GraphQL error semantics: ${error.source}`, async () => {
    const { identity } = await read(options);
    assert.match(identity.err, error);
    assert.equal(identity.displayName, "Example Brand / United States");
    assert.equal(identity.merchantId, null);
    assert.equal(identity.partnerAccountId, null);
    assert.equal(identity.marketplace, null);
  });
}

test("strict mode ignores loose selectors that match unrelated widgets", () => {
  const widget = { '[class*="AccountSwitcher" i]': { textContent: "Switcher widget" } };
  assert.equal(identityFromDocument(doc({ selectors: widget }), { strict: true }).displayName, null);
  assert.equal(identityFromDocument(doc({ selectors: widget }), { trusted: true }).displayName, null);
  assert.equal(identityFromDocument(doc({ selectors: widget })).displayName, "Switcher widget");
  assert.equal(identityFromDocument(doc({ name: "Brand / US", selectors: widget }), { strict: true }).displayName, "Brand / US");
});

// A tiny element list with real attribute matching for the single compound
// selectors identityFromDocument uses: #id, .class, [attr], [attr="v"],
// [attr*="v"] and the " i" flag. Elements are searched in document order.
function fixtureDocument(elements) {
  const attrRe = /\[([\w-]+)(?:(\*?=)"([^"]*)"(\s+i)?)?\]/g;
  const matches = (el, selector) => {
    const attrs = { ...el.attrs };
    let rest = selector;
    for (const [whole, name, op, value, flag] of selector.matchAll(attrRe)) {
      rest = rest.replace(whole, "");
      if (!(name in attrs)) return false;
      if (!op) continue;
      const have = flag ? String(attrs[name]).toLowerCase() : String(attrs[name]);
      const want = flag ? value.toLowerCase() : value;
      if (op === "=" ? have !== want : !have.includes(want)) return false;
    }
    for (const [, kind, name] of rest.matchAll(/([#.])([\w-]+)/g)) {
      if (kind === "#" && attrs.id !== name) return false;
      if (kind === "." && !String(attrs.class || "").split(/\s+/).includes(name)) return false;
    }
    return !/^\w/.test(rest) || rest.startsWith(el.tag);
  };
  return {
    querySelector: (selector) => {
      const el = elements.find((candidate) => matches(candidate, selector));
      return el ? { textContent: el.text, getAttribute: (name) => el.attrs[name] ?? null } : null;
    },
  };
}

test("the Account Health widget is never read as the account name; the switcher header is", () => {
  const meta = { tag: "meta", attrs: { name: "anti-csrftoken-a2z", content: "fixture-token" }, text: "" };
  const widget = { tag: "div", attrs: { role: "button", "aria-label": "View Account Health details", class: "health-widget" },
    text: "Account Health-HealthyWarningAt RiskSuspended" };
  const headerEl = { tag: "div", attrs: { class: "dropdown-account-switcher-header" }, text: " Example Seller | United States " };
  const early = fixtureDocument([meta, widget]);
  assert.equal(early.querySelector('[aria-label*="account" i][role="button"]').textContent, widget.text,
    "the fixture matcher does match the widget with the removed selector");
  for (const mode of [undefined, { trusted: true }, { strict: true }]) {
    assert.equal(identityFromDocument(early, mode).displayName, null);
  }
  const rendered = fixtureDocument([meta, widget, headerEl]);
  assert.equal(identityFromDocument(rendered).displayName, "Example Seller | United States");
  assert.equal(identityFromDocument(rendered, { trusted: true }).displayName, "Example Seller | United States");
  assert.equal(identityFromDocument(rendered, { strict: true }).displayName, null);
});

test("a settled read waits for the account header to render", async () => {
  let reads = 0;
  const header = '.dropdown-account-switcher-header';
  const page = {
    querySelector: (selector) => {
      if (selector === metaSelector) return { getAttribute: () => "page-token" };
      if (selector === header && ++reads > 2) return { textContent: "Example Brand / United States" };
      if (selector === '[class*="AccountSwitcher" i]') return { textContent: "loose guess" };
      return null;
    },
  };
  const { identity } = await read({ page, settleMs: 5000 });
  expectIds(identity, "page");
  assert.ok(reads > 2);
});

test("a settled read keeps the display name null rather than take a loose guess", async () => {
  const page = doc({ token: "page-token", selectors: { '[class*="AccountSwitcher" i]': { textContent: "loose guess" } } });
  const { identity } = await read({ page, settleMs: 600 });
  assert.equal(identity.displayName, null);
  assert.equal(identity.partnerAccountId, "PARTNER_A");
  const unsettled = await read({ page });
  assert.equal(unsettled.identity.displayName, "loose guess");
});

test("identityFieldsConsistent compares ids exactly and the display name only without a strong id", () => {
  const base = { merchantId: "SELLER_A", partnerAccountId: "PARTNER_A", displayName: "Example Seller" };
  assert.deepEqual(identityFieldsConsistent(base, { ...base, displayName: "Example Seller / United States" }), { ok: true, field: null });
  assert.deepEqual(identityFieldsConsistent(base, { ...base, partnerAccountId: "PARTNER_B" }), { ok: false, field: "partnerAccountId" });
  assert.deepEqual(identityFieldsConsistent(base, { ...base, merchantId: "SELLER_B" }), { ok: false, field: "merchantId" });
  assert.deepEqual(identityFieldsConsistent(base, { ...base, displayName: null }), { ok: true, field: null });
  assert.deepEqual(identityFieldsConsistent(base, { ...base, partnerAccountId: null }), { ok: true, field: null },
    "an id that became unavailable is tolerated while the other id matches");
  assert.deepEqual(identityFieldsConsistent(base, { displayName: "Example Seller" }), { ok: false, field: "merchantId" });
  assert.deepEqual(identityFieldsConsistent({ displayName: "Example Seller" }, { displayName: "Other Seller" }), { ok: false, field: "displayName" });
  assert.deepEqual(identityFieldsConsistent({ displayName: "Example Seller" }, { displayName: " example  SELLER " }), { ok: true, field: null });
  assert.deepEqual(identityFieldsConsistent({ displayName: "Example Seller" }, { displayName: null }), { ok: false, field: "displayName" });
});

test("/home fallback never takes a display name from a loose selector", async () => {
  const widget = { '[aria-label*="account" i][role="button"]': { textContent: "Account Health Healthy" } };
  const { identity } = await read({ homeDoc: doc({ token: "fixture-token", selectors: widget }) });
  assert.equal(identity.source, "home");
  assert.equal(identity.displayName, null);
  assert.equal(identity.err, null);
});
