# POE captured-vs-visible gap matrix

> The `getNiche`, `getNiches` and `getMerchantInfoByPartnerId` query strings were last checked live on 2026-07-05. This release's code has not been run against live Seller Central yet.

Verified 2026-07-05 on one US niche. The UI and the captured data were
compared side by side, and the native CSV exports were diffed cell by cell
against the formatted output. The query strings for `getNiche`, `getNiches`
and `getMerchantInfoByPartnerId` were the ones `fetch-poe.js` sends today.
The check sent the same query strings through two paths: by evaluating the
fetcher in the page and formatting the returned envelope separately, and
through the CDP runner. Both produced byte-identical output.

"Both run paths" in the Verified column means the row was checked both ways.
This release's code, with its trimmed `GetUserContext` query and the
response marketplace check, has not been run against live Seller Central yet;
see the first row of the table.

| UI element | Visible in UI | Captured as | Verified |
|---|---|---|---|
| This release: `run-poe.mjs` and `fetch-poe.js` as they are now, with the trimmed `GetUserContext` query, the response marketplace and niche id checks and the per-run background tab | n/a | n/a | Not yet run against live Seller Central |
| Overview metric cards (search volume 360 days, growth 180 days, number of top clicked products, average price, units sold range, return rate, last updated) | Yes | `nicheSummary`, plus the overview JSON (`amazon-poe-downloader.overview.v1`) whose `textLines` repeat the Overview tab labels, each followed by its value | 2026-07-05, both run paths; all six metric lines parse with a label-then-value pattern |
| Overview: fee breakdown, sales potential score, post-launch ad spend, glance view and conversion metrics | Partly, deep in the UI | `nicheSummary`, which holds more than the UI shows | 2026-07-05 |
| Products tab, all rows and columns | Yes | `asinMetrics`, written as `NicheDetailsProductsTab.csv` in the canonical English layout | 2026-07-05; every cell exact against the native export except Average Customer Rating |
| Products tab, Average Customer Rating | Yes (2 decimals) | The API value, with 1 decimal (`4.6` where the UI shows `4.59`) | Known cosmetic deviation, one column |
| Search Terms tab, all rows and columns | Yes | `searchTermMetrics`, written as `NicheDetailsSearchTermsTab.csv` | 2026-07-05; every cell exact against the native export |
| Search Terms fields the UI does not show (`searchTermId`, T90 volume, YoY growth, `clickShareT360`, product images) | No, API only | The niche-full JSON | 2026-07-05 |
| Customer Review Insights, positive topics with % of mentions and snippets | Yes, Positive topics (Positive Themen) | `nichePdr.positiveCustomerReviewInsights` (snippets inline), written to the review insights JSON and CSV with the sentiment `positive` | 2026-07-05, both run paths |
| Customer Review Insights, negative topics with % of mentions and snippets | Yes, Negative topics (Negative Themen) | `nichePdr.negativeCustomerReviewInsights`, written with the sentiment `negative` | 2026-07-05, both run paths |
| Customer Review Insights, star rating impact table | Yes | `nichePdr.productStarRatingImpact` | 2026-07-05 |
| Customer Review Insights, topic to subtopic drill-down with positive and negative snippets | Yes (expanders) | `nichePdr.pdrTopics[].subTopics` | 2026-07-05 |
| Customer Review Insights, topic trends over time | Yes (charts) | `pdrTopics[].positiveReviewInsights.trends` and `pdrTopics[].negativeReviewInsights.trends` | 2026-07-05 |
| Returns tab, topic table with % of mentions | Yes | `pdrTopics[].returnsInsights`, written to the returns JSON and CSV | 2026-07-05; values match the UI table |
| Returns tab, trend chart per topic | Yes | `returnsInsights.trends[]` (monthly) | 2026-07-05 |
| Niches without returns data | Not applicable | `notExposed: true` in the returns JSON and a marker row in the returns CSV | Self-test |
| Insights & Trends time series (search volume, price, counts, conversion and others) | Yes (charts) | `trendsMetrics[]`, about 104 weekly points with about 24 metrics each, in the niche-full JSON | 2026-07-05 |
| Insights & Trends launch potential cards | Yes | `launchPotential`, about 30 metrics with QoQ and YoY, in the overview JSON | 2026-07-05 |
| Keyword search box | Yes (explore page) | `fetchPoeSearch`, which calls `getNiches` and receives the whole grid with no cap | 2026-07-05, both run paths |
| Search results grid (keywords, search volume, growth, units sold, price range, return rate) | Yes | `getNiches`, written as the related-niches JSON (`amazon-poe-downloader.related-niches.v1`, 13 cells per row in the grid's column order) and CSV | 2026-07-05; cell order matches the grid columns |
| Niche typeahead suggestions | Yes | `searchNicheSearchTerms`, documented and not fetched | Endpoint documentation only |
| The active account's own niches | Yes (home page) | `fetchPoeMerchantNiches`, written as the merchant-niches JSON | 2026-07-05; whether `merchantInfoByPartnerId.obfuscatedMarketplaceId` is filled, which the response marketplace check needs, is not confirmed live |
| Trending niche modules | Yes (home page) | `getTrendingNiches`, `getTrendingNichesByPdrMetrics` and `getTopPerformanceNichesT180`, documented and not fetched because product research is outside the downloader's scope | Documentation only |
| Category browse tree | Yes (home page) | `getBrowseTreeChildren`, documented and not fetched, outside the downloader's scope | Documentation only |
| Native CSV Download buttons | Yes | Not needed. The buttons build client-side blobs from the same `getNiche` data, and `format-poe.mjs` rebuilds the canonical English CSVs from it. Manual use stays documented in [manual-export-fallback.md](manual-export-fallback.md). | 2026-07-05 parity diffs |

## Native export parity

- Products tab: every cell matched the native export exactly except those in
  Average Customer Rating, where the API has 1 decimal and the native export
  has 2.
- Search Terms tab: every cell matched exactly.
- The file layout copies the native export: a byte order mark, three preamble
  lines (niche name, tab name, last updated date), a blank line, then the
  header row. A reader written for the native export reads these files too.
- Headers are always the canonical English ones. A native export from a German
  UI has German headers and a German filename.
- The native Search Terms export fills "Click Share (Past 360 days)" from the
  short-window `clickShare` field, not from `clickShareT360`. `format-poe.mjs`
  does the same.
- On DE, the Products CSV header matched a native Products export byte for
  byte.

## EU verification (2026-07-05, one DE niche)

- On `sellercentral.amazon.de` with marketplace `de`, the niche names in the
  search result matched the POE search grid. The full niche fetch returned EUR data with
  products, search terms, weekly trend points, positive and negative review
  topics, and returns topics.
- Search coverage: `getNiches` is uncapped and returns the complete grid.
  Broad keywords returned several hundred niches on US. No pagination is
  needed.
- Review topic names come back in the marketplace language: a DE niche returns
  German topic names. Field names do not change.
- Seller Central sign-in is per domain. The Chrome profile needs its own
  sign-in on `sellercentral.amazon.de` in addition to
  `sellercentral.amazon.com`.

## Outstanding

- Review insights, returns and insights data for very small niches may be
  sparse. The formatter's not-exposed handling covers returns, and empty review
  insight lists pass through as empty arrays.
- Not re-verified since 2026-07-05, and never with this release's code. The
  [README maintenance steps](../README.md#maintenance-when-amazon-changes-poe)
  describe how to repeat the check.
