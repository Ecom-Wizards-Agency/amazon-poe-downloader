/*
 * Browser-side Product Opportunity Explorer (POE) fetcher.
 *
 * HOW IT WORKS
 *   Runs inside an ALREADY logged-in sellercentral.amazon.* tab. POE is served
 *   by ONE GraphQL endpoint (POST {origin}/ox-api/graphql). Because the code
 *   runs in the page origin, the calls are same-origin: the browser attaches
 *   the login cookies, Origin and Referer automatically. The only extra header
 *   is `anti-csrftoken-a2z`, read from the page's OWN <meta> tag (the value the
 *   page itself sends on every ox-api request). This file never reads cookies,
 *   localStorage, sessionStorage, passwords, bearer/refresh tokens, or any
 *   credential, and it never logs in. Data is returned to the caller and never
 *   sent anywhere else.
 *
 *   ONE getNiche call returns every niche-detail tab (overview, products,
 *   search terms, insights and trends, customer review insights positive AND
 *   negative, returns, purchase-driver topics). Tab clicks in the UI are pure
 *   client-side routes; no per-tab requests exist.
 *
 * SAFETY
 *   Read-only: these operations only READ niche data. About 5 s of jittered
 *   spacing between heavy requests (mirrors real usage); one niche per
 *   invocation. If there is no active session (network error, 401/403, or a
 *   non-JSON response) the function returns an envelope with an `error`
 *   string and changes nothing. Open or refresh an Opportunity Explorer tab,
 *   log in, and retry.
 *
 * USAGE
 *   A) Manual: open any Opportunity Explorer page in a logged-in Seller
 *      Central tab, paste this whole file into the DevTools console (or
 *      evaluate it through any automation tool), then call one of:
 *        await fetchPoeNiche({ nicheId: "..." })
 *        await fetchPoeSearch({ query: "..." })
 *        await fetchPoeMerchantNiches()
 *        await fetchPoeContext()
 *      fetchPoeNiche, fetchPoeSearch and fetchPoeMerchantNiches accept an
 *      optional obfuscatedMarketplaceId; the default is the marketplace
 *      currently selected on the page. fetchPoeContext takes no parameters.
 *   B) Scripted: run-poe.mjs evaluates this source over the Chrome DevTools
 *      Protocol in a tab of a Chrome started with --remote-debugging-port.
 *
 * Returns:
 *   { schemaVersion:"amazon-poe-downloader.envelope.v1",
 *     kind:"niche"|"search"|"context"|"merchant-niches",
 *     marketplace, capturedAt, url, ...payload, error? }
 */

function _pfSleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

// ~5 s with jitter between heavy requests, so multi-request pulls read like a
// person clicking around.
function _pfPace() {
  return _pfSleep(4750 + Math.floor(Math.random() * 500));
}

function _pfCsrfToken() {
  var el = document.querySelector('meta[name="anti-csrftoken-a2z"]');
  return el ? el.getAttribute("content") : "";
}

// Resolve fetch from whatever global the evaluate context exposes.
function _pfFetch() {
  var g = (typeof globalThis !== "undefined" && globalThis) ||
          (typeof self !== "undefined" && self) || null;
  var f = g && g.fetch;
  return typeof f === "function" ? f.bind(g) : null;
}

// XHR fallback for evaluate worlds that don't expose fetch. Returns {status, text}.
function _pfXhrPost(url, headers, body) {
  return new Promise(function (resolve, reject) {
    var X = (typeof XMLHttpRequest !== "undefined") ? XMLHttpRequest :
            (typeof globalThis !== "undefined" && globalThis.XMLHttpRequest) || null;
    if (!X) { reject(new Error("no fetch and no XMLHttpRequest in this context")); return; }
    var xhr = new X();
    xhr.open("POST", url, true);
    xhr.withCredentials = true;               // same-origin session cookies
    for (var k in headers) if (Object.prototype.hasOwnProperty.call(headers, k)) xhr.setRequestHeader(k, headers[k]);
    xhr.onload = function () { resolve({ status: xhr.status, text: xhr.responseText }); };
    xhr.onerror = function () { reject(new Error("XHR network error")); };
    xhr.send(body);
  });
}

// POST one GraphQL operation. Returns {data} or {__error}. Never fabricates.
async function _pfGraphql(operationName, query, variables) {
  var url = location.origin + "/ox-api/graphql";
  var t = _pfCsrfToken();
  if (!t) return { __error: "missing anti-csrftoken-a2z meta tag; open an Opportunity Explorer page and retry" };
  var headers = { "Content-Type": "application/json", "Accept": "application/json", "anti-csrftoken-a2z": t };
  var body = JSON.stringify({ operationName: operationName, variables: variables, query: query });
  var status, text;
  var f = _pfFetch();
  try {
    if (f) {
      var res = await f(url, { method: "POST", credentials: "include", headers: headers, body: body });
      status = res.status;
      text = await res.text();
    } else {
      var xr = await _pfXhrPost(url, headers, body);
      status = xr.status; text = xr.text;
    }
  } catch (e) {
    return { __error: "request transport failed (no active session, or evaluate context blocks network): " + String(e) };
  }
  if (status === 401 || status === 403) {
    return { __error: "not authorized (" + status + "): session logged out or wrong account/marketplace" };
  }
  if (status < 200 || status >= 300) return { __error: "request failed with HTTP " + status };
  try {
    var parsed = JSON.parse(text);
    if (parsed.errors && parsed.errors.length) {
      return { __error: "GraphQL error: " + (parsed.errors[0].message || JSON.stringify(parsed.errors[0])).slice(0, 300) };
    }
    return { data: parsed.data };
  }
  catch (e) { return { __error: "response was not JSON (likely a login redirect)" }; }
}

// ---------------------------------------------------------------- queries
// Copied verbatim (whitespace-collapsed) from the live page's own requests.
// Do not hand-edit field lists; re-capture them from the page instead. The
// one deliberate exception is the context query: it is trimmed to the fields
// this file uses, so the page's session values are never requested. That
// trimmed form has not yet been run against live Seller Central (see
// references/poe-endpoints.md).
var _PF_Q_CONTEXT = "query GetUserContext { userContext { partnerAccountId merchantId marketplaceSelection __typename } }";

var _PF_Q_MERCHANT_NICHES = "query getMerchantInfoByPartnerId($obfuscatedMarketplaceId: String!, $partnerAccountId: String!) { merchantInfoByPartnerId( obfuscatedMarketplaceId: $obfuscatedMarketplaceId partnerAccountId: $partnerAccountId ) { obfuscatedMerchantId obfuscatedMarketplaceId merchantNiches { nicheId nicheTitle obfuscatedMarketplaceId __typename } __typename } }";

var _PF_Q_NICHES = "query getNiches($filter: NicheFilter!, $useNewQuery: Boolean, $searchImprovementsEnabled: Boolean) { niches( filter: $filter useNewQuery: $useNewQuery searchImprovementsEnabled: $searchImprovementsEnabled ) { nicheId obfuscatedMarketplaceId nicheTitle referenceAsinImageUrl currency nicheSummary { searchVolumeT90 searchVolumeGrowthT90 searchVolumeT360 searchVolumeGrowthT180 searchVolumeGrowthT360 minimumUnitsSoldT90 maximumUnitsSoldT90 minimumUnitsSoldT360 maximumUnitsSoldT360 minimumAverageUnitsSoldT360 maximumAverageUnitsSoldT360 minimumPrice maximumPrice salesPotentialScore productCount avgPrice avgPriceT360 demand category nicheType returnRateT360 __typename } topSearchTermMetrics { searchTerm __typename } __typename } }";

var _PF_Q_NICHE = "query getNiche($nicheInput: NicheInput!) { niche(request: $nicheInput) { nicheId obfuscatedMarketplaceId nicheTitle referenceAsinImageUrl currency nicheBrowsePath { browseNodeId browseNodeName __typename } nicheSummary { searchVolumeT90 searchVolumeGrowthT90 searchVolumeT360 searchVolumeGrowthT180 searchVolumeGrowthT360 minimumUnitsSoldT90 maximumUnitsSoldT90 minimumUnitsSoldT360 maximumUnitsSoldT360 minimumAverageUnitsSoldT360 maximumAverageUnitsSoldT360 minimumPrice maximumPrice salesPotentialScore productCount returnRateT360 avgPrice avgPriceT360 nicheType adSpendPostLaunch90d glanceViewPostLaunch90d quantityShippedPostLaunch90d purchaseConversionRatePostLaunch90d totalFeesT365 totalFeesNonPeakT365 totalFeesPeakT365 amazonFeesT365 amazonFeesNonPeakT365 amazonFeesPeakT365 referralFeeT365 referralFeeNonPeakT365 referralFeePeakT365 variableClosingFeeT365 variableClosingFeeNonPeakT365 variableClosingFeePeakT365 fixedClosingFeeT365 fixedClosingFeeNonPeakT365 fixedClosingFeePeakT365 fulfillmentFeesT365 fulfillmentFeesNonPeakT365 fulfillmentFeesPeakT365 fbaFeeT365 fbaFeeNonPeakT365 fbaFeePeakT365 digitalServicesFeeT365 digitalServicesFeeNonPeakT365 digitalServicesFeePeakT365 storageFeesT365 storageFeesNonPeakT365 storageFeesPeakT365 monthlyStorageFeeT365 monthlyStorageFeeNonPeakT365 monthlyStorageFeePeakT365 longtermStorageFeeT365 longtermStorageFeeNonPeakT365 longtermStorageFeePeakT365 refundFeeT365 refundFeeNonPeakT365 refundFeePeakT365 __typename } launchPotential { productCount { currentValue qoq yoy __typename } sponsoredProductsPercentage { currentValue qoq yoy __typename } sponsoredProductsPercentageT360 { currentValue qoq yoy __typename } primeProductsPercentage { currentValue qoq yoy __typename } primeProductsPercentageT360 { currentValue qoq yoy __typename } top5ProductsClickShare { currentValue qoq yoy __typename } top5ProductsClickShareT360 { currentValue qoq yoy __typename } top5BrandsClickShare { currentValue qoq yoy __typename } top5BrandsClickShareT360 { currentValue qoq yoy __typename } top20ProductsClickShare { currentValue qoq yoy __typename } top20ProductsClickShareT360 { currentValue qoq yoy __typename } top20BrandsClickShare { currentValue qoq yoy __typename } top20BrandsClickShareT360 { currentValue qoq yoy __typename } avgBestSellerRank { currentValue qoq yoy __typename } avgProductPrice { currentValue qoq yoy __typename } avgReviewCount { currentValue qoq yoy __typename } avgReviewRating { currentValue qoq yoy __typename } brandCount { currentValue qoq yoy __typename } brandCountT360 { currentValue qoq yoy __typename } sellingPartnerCount { currentValue qoq yoy __typename } sellingPartnerCountT360 { currentValue qoq yoy __typename } avgBrandAge { currentValue qoq yoy __typename } avgBrandAgeT360 { currentValue qoq yoy __typename } avgSellingPartnerAge { currentValue qoq yoy __typename } newProductsLaunchedT180 { currentValue qoq yoy __typename } successfulLaunchesT90 { currentValue qoq yoy __typename } successfulLaunchesT180 { currentValue qoq yoy __typename } newProductsLaunchedT360 { currentValue qoq yoy __typename } successfulLaunchesT360 { currentValue qoq yoy __typename } avgOOSRate { currentValue qoq yoy __typename } avgOOSRateT360 { currentValue qoq yoy __typename } avgDetailPageQuality { currentValue qoq yoy __typename } __typename } asinMetrics(request: $nicheInput) { asin asinTitle asinImageUrl avgPrice avgPriceT360 brand category launchDate clickCount clickShareT90 currency customerRating bestSellersRanking avgSellerVendorCount totalReviews clickCountT360 clickShareT360 avgSellerVendorCountT360 __typename } searchTermMetrics(request: $nicheInput) { searchTermId searchTerm searchConversionRate searchVolumeT90 searchVolumeQoq searchVolumeYoy searchVolumeT360 searchVolumeGrowthT180 searchVolumeGrowthT360Yoy searchConversionRateT360 clickShare clickShareT360 topClickedProducts { asin asinTitle asinImageUrl obfuscatedMarketplaceId __typename } __typename } trendsMetrics(request: $nicheInput) { datasetDate searchVolumeT7 productCount averagePriceT7 searchConversionRateT7 sellingPartnerCount brandCount productCountT90 avgSellingPriceT7 sellingPartnerCountT7 brandCountT7 primeProductCountT7 sponsoredProductCountT7 avgOosRateT7 newProductCountT90 successLaunchProductCountT90 avgRatingsOfProducts avgReviewCountOfProducts avgBestSellersRank top5ProductsClickShareT7 top20ProductsClickShareT7 top5BrandClickShareT7 top20BrandClickShareT7 avgBrandAgeInDays avgSellingPartnerAgeInDays __typename } nichePdr(request: $nicheInput) { positiveCustomerReviewInsights { topic percentOfMentions verbatims __typename } negativeCustomerReviewInsights { topic percentOfMentions verbatims __typename } productStarRatingImpact { topic starRatingImpactTop25PercentProducts starRatingImpactAllProducts __typename } pdrTopics { name positiveReviewInsights { percentOfMentions verbatims trends { datasetDate percentOfMentionsAllProducts percentOfMentionsTop25PercentProducts __typename } __typename } negativeReviewInsights { percentOfMentions verbatims trends { datasetDate percentOfMentionsAllProducts percentOfMentionsTop25PercentProducts __typename } __typename } starRatingImpact { starRatingImpactAllProducts starRatingImpactTop25PercentProducts __typename } returnsInsights { percentOfMentions trends { datasetDate percentOfMentions __typename } __typename } subTopics { name positiveReviewInsights { percentOfMentions verbatims __typename } negativeReviewInsights { percentOfMentions verbatims __typename } __typename } __typename } lastUpdatedTimeISO8601 __typename } lastUpdatedTimeISO8601 __typename } }";

// ------------------------------------------------------------- operations

function _pfEnvelope(kind, marketplace) {
  return {
    schemaVersion: "amazon-poe-downloader.envelope.v1", kind: kind,
    marketplace: marketplace || null,
    capturedAt: new Date().toISOString(),
    // Origin and path only: the query string can carry account ids.
    url: location.origin + location.pathname
  };
}

// Resolve the marketplace to use: explicit param wins, else the page's current
// marketplace from GetUserContext. Returns {mp, context} or {__error}.
async function _pfResolveMarketplace(params) {
  var r = await _pfGraphql("GetUserContext", _PF_Q_CONTEXT, {});
  if (r.__error) return r;
  var ctx = (r.data || {}).userContext || {};
  var mp = (params && params.obfuscatedMarketplaceId) || ctx.marketplaceSelection;
  if (!mp) return { __error: "could not resolve obfuscatedMarketplaceId from GetUserContext" };
  return { mp: mp, context: ctx };
}

// params: none. Current account and marketplace context (ids for other calls).
async function fetchPoeContext() {
  var out = _pfEnvelope("context", null);
  var r = await _pfGraphql("GetUserContext", _PF_Q_CONTEXT, {});
  if (r.__error) { out.error = r.__error; return out; }
  out.userContext = (r.data || {}).userContext || null;
  out.marketplace = out.userContext ? out.userContext.marketplaceSelection : null;
  return out;
}

// params: { nicheId, obfuscatedMarketplaceId? }
// ONE call returns every niche-detail tab under .niche.
async function fetchPoeNiche(params) {
  var out = _pfEnvelope("niche", null);
  if (!params || !params.nicheId) { out.error = "params.nicheId is required"; return out; }
  var m = await _pfResolveMarketplace(params);
  if (m.__error) { out.error = m.__error; return out; }
  out.marketplace = m.mp;
  out.nicheId = params.nicheId;
  await _pfPace();
  var r = await _pfGraphql("getNiche", _PF_Q_NICHE, {
    nicheInput: { nicheId: params.nicheId, obfuscatedMarketplaceId: m.mp }
  });
  if (r.__error) { out.error = r.__error; return out; }
  out.niche = (r.data || {}).niche || null;
  if (!out.niche) out.error = "getNiche returned no niche (wrong nicheId or marketplace?)";
  return out;
}

// params: { query, obfuscatedMarketplaceId? }
// Keyword search: the grid behind /explore/search ("related niches" data).
async function fetchPoeSearch(params) {
  var out = _pfEnvelope("search", null);
  if (!params || !params.query) { out.error = "params.query is required"; return out; }
  var m = await _pfResolveMarketplace(params);
  if (m.__error) { out.error = m.__error; return out; }
  out.marketplace = m.mp;
  out.query = params.query;
  await _pfPace();
  var r = await _pfGraphql("getNiches", _PF_Q_NICHES, {
    filter: {
      obfuscatedMarketplaceId: m.mp,
      rangeFilters: [], multiSelectFilters: [],
      searchTermsFilter: { searchInput: params.query }
    },
    useNewQuery: true, searchImprovementsEnabled: true
  });
  if (r.__error) { out.error = r.__error; return out; }
  out.niches = (r.data || {}).niches || [];
  return out;
}

// params: { obfuscatedMarketplaceId? }. The merchant's own niches.
async function fetchPoeMerchantNiches(params) {
  var out = _pfEnvelope("merchant-niches", null);
  var m = await _pfResolveMarketplace(params || {});
  if (m.__error) { out.error = m.__error; return out; }
  out.marketplace = m.mp;
  await _pfPace();
  var r = await _pfGraphql("getMerchantInfoByPartnerId", _PF_Q_MERCHANT_NICHES, {
    obfuscatedMarketplaceId: m.mp, partnerAccountId: m.context.partnerAccountId
  });
  if (r.__error) { out.error = r.__error; return out; }
  out.merchantInfo = (r.data || {}).merchantInfoByPartnerId || [];
  return out;
}
