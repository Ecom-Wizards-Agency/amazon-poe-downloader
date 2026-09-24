import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CC_MP, CC_ORIGIN, MP_CC, REGION_BY_CC,
  regionForMarketplace, ccForOrigin, regionForOrigin, assertOriginMatchesMarketplace,
} from "../lib/marketplaces.mjs";

test("MP_CC is the exact inverse of CC_MP", () => {
  assert.equal(Object.keys(MP_CC).length, Object.keys(CC_MP).length);
  for (const [cc, mp] of Object.entries(CC_MP)) assert.equal(MP_CC[mp], cc);
  for (const [mp, cc] of Object.entries(MP_CC)) assert.equal(CC_MP[cc], mp);
});

test("every country code has an origin and a region", () => {
  assert.deepEqual(Object.keys(CC_ORIGIN).sort(), Object.keys(CC_MP).sort());
  assert.deepEqual(Object.keys(REGION_BY_CC).sort(), Object.keys(CC_MP).sort());
});

test("region lookups", () => {
  assert.equal(regionForMarketplace("us"), "na");
  assert.equal(regionForMarketplace("ca"), "na");
  for (const cc of ["de", "it", "es", "fr", "uk", "nl", "se", "pl"]) assert.equal(regionForMarketplace(cc), "eu");
  assert.equal(regionForMarketplace("in"), "in");
  assert.equal(regionForMarketplace("jp"), "jp");
  assert.equal(regionForMarketplace("DE"), "eu");
  assert.equal(regionForMarketplace("br"), null);
  assert.equal(regionForMarketplace(undefined), null);
});

test("origin parsing accepts only https Seller Central hosts", () => {
  assert.equal(ccForOrigin("https://sellercentral.amazon.de"), "de");
  assert.equal(ccForOrigin("https://sellercentral.amazon.co.uk/opportunity-explorer/niche/x?a=1"), "uk");
  assert.equal(ccForOrigin("https://sellercentral.amazon.co.jp"), "jp");
  assert.equal(ccForOrigin("https://sellercentral.amazon.com/home"), "us");
  assert.equal(ccForOrigin("http://sellercentral.amazon.de"), null);
  assert.equal(ccForOrigin("https://sellercentral.amazon.de.example.com"), null);
  assert.equal(ccForOrigin("https://www.amazon.de"), null);
  assert.equal(ccForOrigin("not a url"), null);
  assert.equal(ccForOrigin(""), null);
  assert.equal(ccForOrigin(null), null);
  assert.equal(regionForOrigin("https://sellercentral.amazon.fr"), "eu");
  assert.equal(regionForOrigin("http://sellercentral.amazon.fr"), null);
});

test("cross-region reads throw with the mismatch code", () => {
  assert.throws(
    () => assertOriginMatchesMarketplace("us", "https://sellercentral.amazon.de"),
    (error) => error.code === "ORIGIN_MARKETPLACE_REGION_MISMATCH" && /region na/.test(error.message),
  );
  assert.throws(
    () => assertOriginMatchesMarketplace("jp", "https://sellercentral.amazon.com"),
    { code: "ORIGIN_MARKETPLACE_REGION_MISMATCH" },
  );
});

test("same-region and unknown sides pass", () => {
  assert.doesNotThrow(() => assertOriginMatchesMarketplace("fr", "https://sellercentral.amazon.de"));
  assert.doesNotThrow(() => assertOriginMatchesMarketplace("ca", "https://sellercentral.amazon.com"));
  assert.doesNotThrow(() => assertOriginMatchesMarketplace("de", "https://sellercentral.amazon.de"));
  assert.doesNotThrow(() => assertOriginMatchesMarketplace("br", "https://sellercentral.amazon.de"));
  assert.doesNotThrow(() => assertOriginMatchesMarketplace("de", "https://example.com"));
});
