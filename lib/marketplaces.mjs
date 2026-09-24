// Marketplace tables shared by the runner and the formatter.
//
// CC_MP maps a lowercase country code to Amazon's public marketplace id.
// CC_ORIGIN maps the same codes to the Seller Central origin that serves them.
// MP_CC is the exact inverse of CC_MP and is used to name output files.

export const CC_MP = {
  us: "ATVPDKIKX0DER", de: "A1PA6795UKMFR9", it: "APJ6JRA9NG5V4",
  es: "A1RKKUPIHCS9HS", fr: "A13V1IB3VIYZZH", uk: "A1F83G8C2ARO7P",
  nl: "A1805IZSGTT6HS", se: "A2NODRKZP88ZB9", pl: "A1C3SOZRARQ6R3",
  ca: "A2EUQ1WTGCTBG2", in: "A21TJRUUN4KGV", jp: "A1VC38T7YXB528",
};

export const CC_ORIGIN = {
  us: "https://sellercentral.amazon.com",
  de: "https://sellercentral.amazon.de",
  it: "https://sellercentral.amazon.it",
  es: "https://sellercentral.amazon.es",
  fr: "https://sellercentral.amazon.fr",
  uk: "https://sellercentral.amazon.co.uk",
  nl: "https://sellercentral.amazon.nl",
  se: "https://sellercentral.amazon.se",
  pl: "https://sellercentral.amazon.pl",
  ca: "https://sellercentral.amazon.ca",
  in: "https://sellercentral.amazon.in",
  jp: "https://sellercentral.amazon.co.jp",
};

export const MP_CC = Object.freeze(
  Object.fromEntries(Object.entries(CC_MP).map(([cc, mp]) => [mp, cc])),
);

// Seller Central region per country code. One account in a region can read
// every marketplace of that region, so a French niche fetched through the
// German origin is a valid same-region read.
export const REGION_BY_CC = Object.freeze({
  us: "na", ca: "na",
  de: "eu", it: "eu", es: "eu", fr: "eu", uk: "eu", nl: "eu", se: "eu", pl: "eu",
  in: "in",
  jp: "jp",
});

const HOST_CC = new Map(
  Object.entries(CC_ORIGIN).map(([cc, origin]) => [new URL(origin).host, cc]),
);

/** Region ("na", "eu", "in", "jp") for a country code, or null when unknown. */
export function regionForMarketplace(cc) {
  if (typeof cc !== "string") return null;
  return REGION_BY_CC[cc.toLowerCase()] ?? null;
}

/**
 * Country code for a Seller Central URL or origin. Only https URLs whose host
 * is one of the CC_ORIGIN hosts qualify; anything else returns null.
 */
export function ccForOrigin(url) {
  if (typeof url !== "string" || !url) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "https:") return null;
  if (parsed.port && parsed.port !== "443") return null;
  return HOST_CC.get(parsed.hostname.toLowerCase()) ?? null;
}

/** Region for a Seller Central URL or origin, or null when unknown. */
export function regionForOrigin(url) {
  const cc = ccForOrigin(url);
  return cc ? regionForMarketplace(cc) : null;
}

/**
 * Throw when the requested marketplace and the page origin belong to two
 * different known regions. Same-region reads are allowed by design, and an
 * unknown side on either end is left to the caller.
 */
export function assertOriginMatchesMarketplace(cc, origin) {
  const wanted = regionForMarketplace(cc);
  const actual = regionForOrigin(origin);
  if (wanted && actual && wanted !== actual) {
    const error = new Error(
      `Marketplace "${cc}" is in region ${wanted}, but the page origin ${origin} is in region ${actual}. ` +
      `Open Seller Central for the ${wanted} region and retry.`,
    );
    error.code = "ORIGIN_MARKETPLACE_REGION_MISMATCH";
    error.marketplace = cc;
    error.origin = origin;
    error.expectedRegion = wanted;
    error.actualRegion = actual;
    throw error;
  }
}
