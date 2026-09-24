// Redaction of URLs and captured bodies (lib/redact.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { REDACTED, displayUrl, redactText, redactUrl, redactValue } from "../lib/redact.mjs";

const SIGN_IN = "https://sellercentral.amazon.com/ap/signin?openid.return_to=x&ssoResponse=FAKE-SSO-VALUE#frag";

test("displayUrl keeps only origin and path", () => {
  assert.equal(displayUrl(SIGN_IN), "https://sellercentral.amazon.com/ap/signin");
  assert.equal(displayUrl("https://sellercentral.amazon.de/opportunity-explorer"), "https://sellercentral.amazon.de/opportunity-explorer");
  assert.equal(displayUrl("about:blank"), "about:blank");
  assert.equal(displayUrl("not a url?secret=1"), "not a url");
  assert.equal(displayUrl(null), "");
});

test("redactUrl replaces sensitive query values and keeps the rest", () => {
  const out = redactUrl("https://sellercentral.amazon.com/x?search=desk+lamp&ssoResponse=FAKE-SSO-VALUE&openid.mode=y");
  assert.doesNotMatch(out, /FAKE-SSO-VALUE|=y\b/);
  assert.match(out, /search=desk\+lamp/);
  assert.match(out, /ssoResponse=%5Bredacted%5D/);
});

test("redactText scrubs sensitive keys at any depth in JSON bodies", () => {
  const body = JSON.stringify({ data: { userContext: {
    partnerAccountId: "PARTNER_A", merchantId: "SELLER_A", marketplaceSelection: "ATVPDKIKX0DER",
    csrfValue: "fake-csrf-value-123", sessionRef: "fake-session-value-456", customerIdValue: "fake-customer-789",
    nested: [{ accessToken: "fake-access-value" }],
  } } });
  const out = redactText(body);
  assert.doesNotMatch(out, /fake-csrf-value-123|fake-session-value-456|fake-customer-789|fake-access-value/);
  const parsed = JSON.parse(out);
  assert.equal(parsed.data.userContext.partnerAccountId, "PARTNER_A");
  assert.equal(parsed.data.userContext.marketplaceSelection, "ATVPDKIKX0DER");
  assert.equal(parsed.data.userContext.sessionRef, REDACTED);
  assert.equal(parsed.data.userContext.nested[0].accessToken, REDACTED);
});

test("redactText scrubs non-JSON and truncated bodies by pattern", () => {
  const cut = '{"data":{"userContext":{"csrfValue":"fake-csrf-value-123","sessionRef":"fake-session-value-456","merchantId":"SELLER_A"';
  const out = redactText(cut);
  assert.doesNotMatch(out, /fake-csrf-value-123|fake-session-value-456/);
  assert.match(out, /"merchantId":"SELLER_A"/);
  assert.equal(redactText('{"a":1,"sessionRef":"fake-sess'), `{"a":1,"sessionRef":"${REDACTED}"`);
  const form = redactText("a=1&sessionRef=fake-session-value-456&b=2");
  assert.equal(form, `a=1&sessionRef=${REDACTED}&b=2`);
});

test("redactValue leaves non-sensitive data untouched", () => {
  const value = { niche: { nicheId: "NICHE1", obfuscatedMarketplaceId: "ATVPDKIKX0DER", asinMetrics: [{ asin: "B000000001" }] } };
  assert.deepEqual(redactValue(value), value);
});

test("sso matches only at the start of a word", () => {
  const value = { grossOrderSales: 12, assortment: "wide", nicheTitle: "Example Brand" };
  assert.deepEqual(redactValue(value), value);
  const out = redactValue({ ssoResponse: "FAKE1", userSso: "FAKE2", "x-sso": "FAKE3" });
  assert.deepEqual(out, { ssoResponse: REDACTED, userSso: REDACTED, "x-sso": REDACTED });
});

test("redactText scrubs sensitive meta and input tags", () => {
  const html = '<head><meta name="anti-csrftoken-a2z" content="hFAKETOKEN123"><meta content=\'hFAKETOKEN456\' id="csrf"><meta name="viewport" content="width=device-width"></head>'
    + '<input type="hidden" name="sessionRef" value="fake-session-value-456">';
  const out = redactText(html);
  assert.doesNotMatch(out, /hFAKETOKEN123|hFAKETOKEN456|fake-session-value-456/);
  assert.match(out, /content="width=device-width"/);
  const wrapped = redactText(JSON.stringify({ html: '<meta name="anti-csrftoken-a2z" content="hFAKETOKEN789">' }));
  assert.doesNotMatch(wrapped, /hFAKETOKEN789/);
});

test("redactText scrubs unquoted script assignments", () => {
  const out = redactText('window.csrfToken = "FAKE2"; var x={csrfToken:"FAKE3", title:"Example Brand"}; const s = \'FAKE4\', sessionRef=\'FAKE5\';');
  assert.doesNotMatch(out, /FAKE2|FAKE3|FAKE5/);
  assert.match(out, /title:"Example Brand"/);
  assert.match(out, /s = 'FAKE4'/);
});

test("sign-in parameter names outside a sign-in path are redacted only as whole keys", () => {
  const out = redactUrl("https://sellercentral.amazon.com/home?code=FAKECODE&state=FAKESTATE&arb=FAKEARB&nonce=FAKENONCE&currencyCode=USD");
  assert.doesNotMatch(out, /FAKECODE|FAKESTATE|FAKEARB|FAKENONCE/);
  assert.match(out, /currencyCode=USD/);
});

test("redactText scrubs sensitive keys inside JSON stored as a string value", () => {
  const out = redactText(JSON.stringify({ data: { cfg: JSON.stringify({ csrfToken: "FAKE6", title: "Example Brand" }) } }));
  assert.doesNotMatch(out, /FAKE6/);
  assert.match(out, /Example Brand/);
});

test("redactText scrubs the value of a sensitive name/value pair", () => {
  const out = redactText(JSON.stringify({ headers: [
    { name: "anti-csrftoken-a2z", value: "FAKE7" },
    { key: "sessionRef", content: "FAKE8" },
    { name: "Accept", value: "application/json" },
  ] }));
  assert.doesNotMatch(out, /FAKE7|FAKE8/);
  assert.match(out, /application\/json/);
});

test("redactUrl drops the fragment and every query value of a sign-in URL", () => {
  const out = redactUrl("https://sellercentral.amazon.com/ap/signin?siteState=FAKESTATE&pageId=x&clientContext=FAKECTX#frag=FAKEFRAG");
  assert.doesNotMatch(out, /FAKESTATE|FAKECTX|FAKEFRAG|#/);
  assert.match(out, /siteState=%5Bredacted%5D/);
  const plain = redactUrl("https://sellercentral.amazon.com/opportunity-explorer?search=desk+lamp#tab=FAKEFRAG");
  assert.equal(plain, "https://sellercentral.amazon.com/opportunity-explorer?search=desk+lamp");
});
