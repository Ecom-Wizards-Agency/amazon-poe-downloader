// Runs fetch-poe.js inside node:vm with a stubbed page: document (meta tag
// lookup), location, fetch and an immediate setTimeout.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const SOURCE = fs.readFileSync(new URL("../fetch-poe.js", import.meta.url), "utf8");
const ORIGIN = "https://sellercentral.amazon.com";

function jsonResponse(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status, text: async () => text };
}

// respond(operationName, variables) -> { status, body }
function makePage({ token = "tok-123", respond } = {}) {
  const calls = [];
  const sandbox = {
    document: {
      querySelector(selector) {
        if (selector !== 'meta[name="anti-csrftoken-a2z"]' || token === null) return null;
        return { getAttribute: (name) => (name === "content" ? token : null) };
      },
    },
    location: { origin: ORIGIN, pathname: "/opportunity-explorer/explore/search",
      href: `${ORIGIN}/opportunity-explorer/explore/search?mons_sel_mkid=FAKE_ID` },
    setTimeout: (fn) => fn(),
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, init, body });
      const { status, body: resBody } = respond(body.operationName, body.variables);
      return jsonResponse(status, resBody);
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(SOURCE, context, { filename: "fetch-poe.js" });
  return { context, calls };
}

const CONTEXT_OK = {
  status: 200,
  body: { data: { userContext: { partnerAccountId: "PARTNER_A", merchantId: "SELLER_A", marketplaceSelection: "ATVPDKIKX0DER", __typename: "UserContext" } } },
};

test("search returns an envelope with the public schema id and the niches", async () => {
  const niches = [{ nicheId: "n1", nicheTitle: "example niche", nicheSummary: {}, topSearchTermMetrics: [] }];
  const { context, calls } = makePage({
    respond: (op) => (op === "GetUserContext" ? CONTEXT_OK : { status: 200, body: { data: { niches } } }),
  });
  const env = await context.fetchPoeSearch({ query: "example query" });
  assert.equal(env.schemaVersion, "amazon-poe-downloader.envelope.v1");
  assert.equal(env.kind, "search");
  assert.equal(env.marketplace, "ATVPDKIKX0DER");
  assert.equal(env.query, "example query");
  assert.equal(env.url, `${ORIGIN}/opportunity-explorer/explore/search`);
  assert.match(env.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(env.error, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(env.niches)), niches);

  assert.deepEqual(calls.map((c) => c.body.operationName), ["GetUserContext", "getNiches"]);
  for (const c of calls) {
    assert.equal(c.url, `${ORIGIN}/ox-api/graphql`);
    assert.equal(c.init.method, "POST");
    assert.equal(c.init.credentials, "include");
    assert.equal(c.init.headers["anti-csrftoken-a2z"], "tok-123");
  }
  assert.equal(calls[1].body.variables.filter.obfuscatedMarketplaceId, "ATVPDKIKX0DER");
  assert.equal(calls[1].body.variables.filter.searchTermsFilter.searchInput, "example query");
});

test("context query asks only for the fields the tool uses", async () => {
  const { context, calls } = makePage({ respond: () => CONTEXT_OK });
  const env = await context.fetchPoeContext();
  assert.equal(env.kind, "context");
  assert.equal(env.marketplace, "ATVPDKIKX0DER");
  assert.equal(env.userContext.partnerAccountId, "PARTNER_A");
  assert.equal(calls[0].body.query, "query GetUserContext { userContext { partnerAccountId merchantId marketplaceSelection __typename } }");
});

test("a 401 produces an envelope with an error string", async () => {
  const { context } = makePage({ respond: () => ({ status: 401, body: "" }) });
  const env = await context.fetchPoeSearch({ query: "example query" });
  assert.equal(env.schemaVersion, "amazon-poe-downloader.envelope.v1");
  assert.equal(typeof env.error, "string");
  assert.match(env.error, /not authorized \(401\)/);
  assert.equal(env.niches, undefined);
});

test("a missing anti-csrftoken meta tag produces an error without any request", async () => {
  const { context, calls } = makePage({ token: null, respond: () => CONTEXT_OK });
  const env = await context.fetchPoeNiche({ nicheId: "n1" });
  assert.match(env.error, /missing anti-csrftoken-a2z meta tag/);
  assert.equal(calls.length, 0);
});

test("the source never references window", () => {
  assert.doesNotMatch(SOURCE, /\bwindow\b/);
});
