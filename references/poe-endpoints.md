# POE GraphQL endpoints

> The `getNiche`, `getNiches` and `getMerchantInfoByPartnerId` query strings were last checked live on 2026-07-05. This release's code has not been run against live Seller Central yet.

Discovered 2026-07-05.

The discovery run opened one niche in a signed-in Seller Central tab, clicked
through every tab and logged the page's own network traffic over the Chrome
DevTools Protocol. `fetch-poe.js` is written against the contract below. These
are undocumented endpoints, and Amazon can change them at any time.
`tools/discover-poe-endpoints.mjs` repeats the capture when that happens.

## Transport

All POE data comes from one GraphQL endpoint on the Seller Central origin of
the open page:

```
POST {origin}/ox-api/graphql
Content-Type: application/json
anti-csrftoken-a2z: <content of the page's own meta[name="anti-csrftoken-a2z"] tag>
Body: {"operationName": "...", "variables": {...}, "query": "query ... { ... }"}
```

- The request adds only the `anti-csrftoken-a2z` header. Its value is read
  from the page's own `<meta name="anti-csrftoken-a2z">` tag, which holds the
  anti-forgery value the page itself sends on every `ox-api` request. The tag
  is present on every `/opportunity-explorer/*` page.
- Nothing else is read from the browser: no cookies, no local or session
  storage, no tokens. The request is same-origin, so the browser attaches the
  signed-in session itself.
- A successful response is plain GraphQL JSON, `{"data": {...}}`. GraphQL
  errors arrive in `errors[]`, and `fetch-poe.js` reports the first message.
- HTTP 401 or 403 means the session is signed out or on the wrong account or
  marketplace. A body that is not JSON is usually a sign-in redirect.
- The UI language does not affect the API. Field names are the same under a
  German or an English UI. Only the page's own CSV export uses localized
  headers.

## Request pattern

Each data function in `fetch-poe.js` (`fetchPoeNiche`, `fetchPoeSearch`,
`fetchPoeMerchantNiches`) sends `GetUserContext` first, waits about 5 seconds
(4.75 to 5.25 s, jittered), then sends its one data operation.
`fetchPoeContext` sends `GetUserContext` only.

`run-poe.mjs` also reads the active account before and after every fetch: one
`GetUserContext` call plus the account name shown in the page's account
switcher header. When the account, the session marketplace or the page origin
changed in between, the response is discarded with a `POE_CONTEXT_CHANGED`
error. The ids and the marketplace are compared exactly; the display name is
compared only when no strong id is available, because it comes from the page
and can render late.
After that, the `obfuscatedMarketplaceId` the response reports must equal the
requested marketplace (see Identifiers), or the response is discarded with
`POE_MARKETPLACE_MISMATCH`.

## Envelope

Every `fetch-poe.js` function resolves to one object and never throws for a
failed request:

```
{ schemaVersion: "amazon-poe-downloader.envelope.v1",
  kind: "niche" | "search" | "context" | "merchant-niches",
  marketplace, capturedAt, url, ...payload, error? }
```

`url` is the page's origin and path, without the query string. The payload
is `nicheId` and `niche` for `niche`, `query` and `niches` for
`search`, `merchantInfo` for `merchant-niches` and `userContext` for
`context`. On failure `error` holds a message and the payload is missing or
null. `format-poe.mjs` refuses an envelope that carries an `error`.

## Identifiers

- `obfuscatedMarketplaceId`: Amazon's public marketplace id, for example
  `ATVPDKIKX0DER` for the US. The niche objects in `getNiche` and `getNiches`
  responses and the `getMerchantInfoByPartnerId` result carry it as well.
  `run-poe.mjs` compares that reported id with `--marketplace` after every
  response: `niche.obfuscatedMarketplaceId`, every row of `niches[]`, and the
  merchant info (not its `merchantNiches[]` entries). A missing or different
  id rejects the response; an empty search result or an empty merchant-niches
  result has nothing to compare. The
  envelope's own `marketplace` field is the id that was requested, so it
  proves nothing on its own.
  `GetUserContext` reports the page's current marketplace as
  `marketplaceSelection` (singular), and that field is sometimes missing.
  The id `run-poe.mjs` sends with every call never comes from it: the runner
  maps `--marketplace` to a fixed table of public marketplace ids in
  `lib/marketplaces.mjs`. `marketplaceSelection` is still part of the
  before-and-after identity comparison, and with `--account-name` it must
  equal `--marketplace`; when it is missing there, the header name must end
  with the marketplace label for the account check to pass. `fetch-poe.js`
  falls back to `marketplaceSelection` only when one of its functions is
  called without an id.
- `partnerAccountId`: the active seller account, read from `GetUserContext`.
  Never hard-code it.
- `nicheId`: a 32-character hex hash or a UUID. It comes from search results
  and from niche URLs (`/opportunity-explorer/explore/niche/<nicheId>`).

## Data operations

### 1. `getNiche`: one call returns every niche-detail tab

`variables: {"nicheInput": {"nicheId": "<nicheId>", "obfuscatedMarketplaceId": "<mp>"}}`

The response is about 200 KB under `data.niche`, with no pagination: every
list has a fixed size. English labels come first below; labels observed on a
German UI are given in parentheses.

| Response section | UI tab or element | Contents |
|---|---|---|
| `nicheSummary` | Overview metric cards, plus fee metrics the UI barely shows | Search volume T90 and T360, growth T90, T180 and T360, units sold minimum and maximum T90 and T360, minimum and maximum price, `avgPrice` and `avgPriceT360`, `productCount`, `returnRateT360`, `salesPotentialScore`, `nicheType`, post-launch ad spend, glance views, units shipped and conversion rate (90 days), and the full T365 fee breakdown (referral, FBA, storage and the rest) |
| `launchPotential` | Insights & Trends launch potential cards | About 30 metrics, each `{currentValue, qoq, yoy}`: product, brand and seller counts and ages, top 5 and top 20 click-share concentration, BSR, price, reviews, out-of-stock rate, launches and detail page quality |
| `asinMetrics[]` | Products tab, all rows | `asin`, `asinTitle`, `asinImageUrl`, `avgPrice`, `avgPriceT360`, `brand`, `category`, `launchDate`, `clickCount`, `clickCountT360`, `clickShareT90`, `clickShareT360`, `customerRating`, `bestSellersRanking`, `avgSellerVendorCount`, `avgSellerVendorCountT360`, `totalReviews`, `currency` |
| `searchTermMetrics[]` | Search Terms tab, all rows | `searchTermId`, `searchTerm`, `searchConversionRate`, `searchConversionRateT360`, `searchVolumeT90`, `searchVolumeT360`, `searchVolumeQoq`, `searchVolumeYoy`, `searchVolumeGrowthT180`, `searchVolumeGrowthT360Yoy`, `clickShare`, `clickShareT360`, `topClickedProducts[3] {asin, asinTitle, asinImageUrl}` |
| `trendsMetrics[]` | Insights & Trends time series, about 104 weekly points | `datasetDate` plus about 24 weekly metrics: search volume, price, conversion, counts, click-share concentration, out-of-stock rate, launches and others |
| `nichePdr.positiveCustomerReviewInsights[]` | Customer Review Insights tab, Positive topics (Positive Themen) | `topic`, `percentOfMentions`, `verbatims[]` (the snippets arrive inline, with no lazy loading) |
| `nichePdr.negativeCustomerReviewInsights[]` | Customer Review Insights tab, Negative topics (Negative Themen) | Same shape |
| `nichePdr.productStarRatingImpact[]` | Customer Review Insights, Star rating impact (Auswirkungen auf Sternebewertung) | `topic`, `starRatingImpactAllProducts`, `starRatingImpactTop25PercentProducts` |
| `nichePdr.pdrTopics[]` | Customer Review Insights topic drill-down, the Returns tab and purchase-driver trends | `name`; `positiveReviewInsights` and `negativeReviewInsights` `{percentOfMentions, verbatims, trends[]}`; `starRatingImpact`; `returnsInsights {percentOfMentions, trends[]}`; `subTopics[]`, the topic to subtopic hierarchy with positive and negative verbatims |
| `lastUpdatedTimeISO8601` | Last updated (Datum der letzten Aktualisierung) | ISO date |

The Returns tab (Rücksendungen) renders entirely from
`pdrTopics[].returnsInsights`. There is no separate returns endpoint. A niche
without returns data has empty or null `returnsInsights`. `format-poe.mjs`
then writes the returns files with `notExposed: true` and a marker row in the
CSV.

### 2. `getNiches`: keyword search and the niche grid

`variables: {"filter": {"obfuscatedMarketplaceId": "<mp>", "rangeFilters": [], "multiSelectFilters": [], "searchTermsFilter": {"searchInput": "<keyword>"}}, "useNewQuery": true, "searchImprovementsEnabled": true}`

Returns `data.niches[]`. The page's query has no pagination parameters, and
the result is not capped: in the 2026-07-05 check, broad keywords returned
several hundred niches.

Each row carries `nicheId`, `obfuscatedMarketplaceId`, `nicheTitle`,
`referenceAsinImageUrl`, `currency`, a `nicheSummary` (search volume and
growth, units sold ranges, minimum and maximum price, `salesPotentialScore`,
`productCount`, `avgPrice`, `avgPriceT360`, `demand`, `category`,
`nicheType`, `returnRateT360`) and `topSearchTermMetrics[] {searchTerm}`,
which fills the keywords column of the grid.

This is the data behind the search results grid: one row per niche with
keywords, search volume, growth, units sold range, return rate and price
range. `format-poe.mjs` writes it as the related-niches JSON and CSV.

UI route after a search:
`/opportunity-explorer/explore/search?search=<kw>&search_type=KEYWORD`.

### 3. `searchNicheSearchTerms`: typeahead

`variables: {"input": {"obfuscatedMarketplaceId": "<mp>", "partialSearchTerm": "<kw>", "pageSize": 10}}`
returns `data.searchNiches.hits`. The page uses it for search suggestions.
`getNiches` is the real search, and `fetch-poe.js` does not call this
operation.

## Context and home page operations

The page loads these on its own.

| Operation | Purpose | Used by this tool |
|---|---|---|
| `GetUserContext` | Active account and marketplace context | Yes, before every data call and in every identity check. The query selects only `partnerAccountId`, `merchantId`, `marketplaceSelection` and `__typename`. The other session fields that the page's own query asks for are not requested. |
| `getMerchantInfoByPartnerId` | The active account's own niches (`nicheId` and title) | Yes, by `merchant-niches` |
| `getUserSavedItems` | Saved niches | No |
| `getBrowseTreeChildren` | Category browse tree | No |
| `getTrendingNiches`, `getTrendingNichesByPdrMetrics`, `getTopPerformanceNichesT180` | Trending modules on the POE home page | No |

The query strings in `fetch-poe.js` are copied verbatim from the page's own
requests; recapture, do not hand-edit. Whitespace is collapsed, and the
`GetUserContext` query is trimmed to the four fields above, so the page's
session values are never requested. The trimmed query exists twice, in
`fetch-poe.js` and in the identity read of `lib/sc-account.mjs`; update both
together (the tests pin both copies). That trimmed query has not been run
against live Seller Central yet (see Marketplace verification status). To refresh a
query, record the page's traffic with `tools/discover-poe-endpoints.mjs` and
copy the query text of the matching operation. The `getNiche` query is about
5.6 KB once whitespace is collapsed.

## The native CSV export

The Download (Herunterladen) buttons on the Products and Search Terms tabs do
not call a server endpoint. The page builds the CSV in the browser, as a
`blob:` URL, from the `getNiche` data it already holds. Headers and filename
follow the UI language: a German UI produces a name of the form
`Tab Nischendetails mit Suchbegriffen_<d.m.yyyy>.csv`.

- There is no CSV endpoint to pass through. `format-poe.mjs` rebuilds both
  CSVs from the `getNiche` JSON.
- It writes the canonical English headers of the native
  `NicheDetailsProductsTab.csv` and `NicheDetailsSearchTermsTab.csv` layouts,
  so the output does not change with the UI language.
- Numbers follow the native export. Shares, growth rates and conversion rates
  are floored to 4 decimals and prices to 2, without trailing zeros. Counts are
  truncated to integers. This rule was checked cell by cell against native
  exports.

Manual use of these buttons is described in
[manual-export-fallback.md](manual-export-fallback.md).

### Search Terms tab: CSV column to `getNiche` field

| CSV column (canonical English) | `getNiche` field |
|---|---|
| Search term | `searchTermMetrics[].searchTerm` |
| Search Volume (Past 360 days) | `searchVolumeT360` |
| Search Volume Growth (Past 90 days) | `searchVolumeQoq` |
| Search Volume Growth (Past 180 days) | `searchVolumeGrowthT180` |
| Click Share (Past 360 days) | `clickShare` (see the note below) |
| Search Conversion Rate (Past 360 days) | `searchConversionRateT360` |
| Top Clicked Product 1 to 3 (Title) and (Asin) | `topClickedProducts[0..2].asinTitle` and `.asin` |

The native export fills "Click Share (Past 360 days)" from `clickShare`, not
from `clickShareT360`, despite the 360-day label. This was verified against a
live export. `format-poe.mjs` copies the behavior so its files match the
native ones.

### Products tab: CSV column to `getNiche` field

| CSV column (canonical English) | `asinMetrics[]` field |
|---|---|
| Product Name | `asinTitle` |
| ASIN | `asin` |
| Brand | `brand` |
| Category | `category` |
| Launch date | `launchDate` |
| Niche Click Count (Past 360 days) | `clickCountT360` |
| Click Share (past 360 days) | `clickShareT360` |
| Average Selling Price (past 360 days) (currency) | `avgPriceT360` |
| Total Ratings | `totalReviews` |
| Average Customer Rating | `customerRating` |
| Average BSR | `bestSellersRanking` |
| Buyable Offer Average 1P+3P (past 360 days) | `avgSellerVendorCountT360` |

## UI route map

For manual checks and screenshots:

```
/opportunity-explorer/explore                     home (the search box is a kat-predictive-input in shadow DOM)
/opportunity-explorer/explore/search?search=<kw>&search_type=KEYWORD
/opportunity-explorer/explore/niche/<nicheId>                    Overview (fires getNiche)
/opportunity-explorer/explore/niche/<nicheId>/insights-trends    Insights & Trends tab
/opportunity-explorer/explore/niche/<nicheId>/product            Products tab
/opportunity-explorer/explore/niche/<nicheId>/search-queries     Search Terms tab
/opportunity-explorer/explore/niche/<nicheId>/review-insights    Customer Review Insights tab (the positive and negative toggles are client-side too)
/opportunity-explorer/explore/niche/<nicheId>/returns-insights   Returns tab
```

Every tab is a client-side route over the one `getNiche` payload. Switching
tabs sends no further data request.

## Marketplace verification status

- US (`ATVPDKIKX0DER`) and DE (`A1PA6795UKMFR9`) were live-verified on
  2026-07-05. Response shapes on DE matched US, and review topic names came
  back in the marketplace language. The checks used the same `getNiche`,
  `getNiches` and `getMerchantInfoByPartnerId` query strings that
  `fetch-poe.js` sends.
- This release: not yet run live. Every run of this repository's code
  depends on two parts that have never met live Seller Central: the
  trimmed `GetUserContext` query (every identity read) and the comparison of
  the response's own `obfuscatedMarketplaceId` with `--marketplace`. Until a
  live run confirms both, treat a `POE_FETCH_FAILED`, `POE_CONTEXT_UNVERIFIED`,
  `POE_MARKETPLACE_MISMATCH` or `POE_NICHE_MISMATCH` on a correctly
  signed-in session as a possible contract difference and recapture with
  `tools/discover-poe-endpoints.mjs`.
- Live captures show that `niche.obfuscatedMarketplaceId` and every
  `getNiches` row echo the requested id. No capture of
  `getMerchantInfoByPartnerId` confirms that
  `merchantInfoByPartnerId.obfuscatedMarketplaceId` is filled. If Seller
  Central leaves it empty, every `merchant-niches` run fails with
  `POE_MARKETPLACE_MISMATCH` and the message names `(none)` as the reported
  marketplace. Record the result here after the first live run.
- The other ids in `lib/marketplaces.mjs` (it, es, fr, uk, nl, se, pl, ca,
  in, jp) are public marketplace constants. They have not been live-verified
  against POE, and POE availability on those marketplaces has not been
  checked.
- Same-region cross reads are supported by design. One Seller Central login
  covers every marketplace of its region, so a `sellercentral.amazon.de`
  session can request `it`, `es` or `fr` niches. `run-poe.mjs` rejects a
  marketplace from another region before any request, with
  `ORIGIN_MARKETPLACE_REGION_MISMATCH`.
