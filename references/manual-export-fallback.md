# Manual export fallback

Export from the Opportunity Explorer UI by hand in two cases:

- The API path is broken, for example because Amazon changed POE and
  `run-poe.mjs` or `fetch-poe.js` now returns errors.
- You want to cross-check the tool's output against what the UI shows.

The UI offers less than the tool. Only the Products and Search Terms tabs have
a download button. Everything else has to be copied as text or captured as
screenshots.

## Before you export

- Check the account name in the Seller Central header, the selected
  marketplace and the niche title. POE records every niche you open in the
  active account's recently viewed niches, so research opened in the wrong
  account stays visible to that account's users.
- Never inspect cookies, local storage, session storage or tokens. The manual
  path needs none of them.
- Keep the export date with every file and screenshot. The native CSV
  preamble carries the date POE last updated the data, which is usually
  earlier than the day you export.

## Steps

1. Open `https://sellercentral.amazon.<tld>/opportunity-explorer` in the
   marketplace you need and sign in.
2. Search for the keyword. The results grid lists every matching niche. To
   keep the grid, take a screenshot or copy the rows.
3. Open the niche and compare its title with the one you meant to open.
4. On the Products tab, click Download (Herunterladen on a German UI).
5. On the Search Terms tab, click Download.
6. The Insights & Trends, Customer Review Insights and Returns tabs have no
   download button. Take screenshots or copy the text, and write the date and
   the niche title next to each capture. On Customer Review Insights, capture
   both the positive and the negative topics.
7. Repeat steps 3 to 6 for every niche you need.

## What the native files look like

- The page builds each CSV in the browser from the niche data it loaded when
  you opened the niche. No server export runs.
- Filename and column headers follow the UI language. On a German UI the
  Search Terms file is named `Tab Nischendetails mit Suchbegriffen_<d.m.yyyy>.csv`.
- Set the Seller Central UI language to English to get the canonical headers.
  They are the same headers `format-poe.mjs` writes in its
  `NicheDetailsProductsTab.csv` and `NicheDetailsSearchTermsTab.csv` files,
  so an English export compares with the tool's output column by column.
- Each file starts with a byte order mark and three preamble lines (niche
  name, tab name, last updated date), then a blank line and the header row.
- Expect one difference from the tool's output: the native Average Customer
  Rating has 2 decimals where the API has 1. The Search Terms "Click Share
  (Past 360 days)" column matches, because the tool copies the native export
  and fills it from the short-window click share field as well.

## Data to capture

The table maps each item to the file where the tool stores it and to its place
in the UI when you capture it by hand. "Niche-full JSON" is the unmodified
`getNiche` capture.

| Item | Tool output | Manual source |
|---|---|---|
| Account and marketplace | `account` and `marketplace` in the overview JSON; the run prints the account to stderr | Account name and marketplace in the Seller Central header |
| Niche title and URL | `nicheTitle` and `nicheId` in the overview JSON; the niche URL is `/opportunity-explorer/explore/niche/<nicheId>`, and the related-niches JSON stores it as `href` | Page title and address bar |
| Export date | `capturedAt` in the overview and niche-full JSON and the date prefix of every filename; `lastUpdated` holds the date POE last updated the data | Date you exported; "Last updated" line of the CSV preamble |
| Search volume and growth | `summary` and `textLines` in the overview JSON; per niche in the related-niches JSON and CSV | Overview metric cards; search results grid |
| Brand and product concentration | `launchPotential` in the overview JSON: top 5 and top 20 click share by product and by brand, brand and seller counts | Insights & Trends launch potential cards |
| Price structure | Average, minimum and maximum price and the fee breakdown in `summary` of the overview JSON; the Average Selling Price column of the Products CSV; the price range in the related-niches files | Overview metric cards and Products tab |
| Products and top ASINs | Products CSV; `asinMetrics` in the niche-full JSON | Products tab download |
| Search terms | Search Terms CSV; `searchTermMetrics` in the niche-full JSON | Search Terms tab download |
| Customer review insights | Review insights JSON and CSV: positive and negative topics, snippets, star rating impact, subtopics | Customer Review Insights tab, screenshots or copied text |
| Returns | Returns JSON and CSV; the JSON also carries `returnRateT360` | Returns tab, screenshots or copied text |
| Seasonal patterns | `trendsMetrics` (104 weekly points) in the niche-full JSON; topic trends in the review insights and returns JSON | Insights & Trends charts, screenshots |
| Demographics | Not captured. The `getNiche` response has no demographic fields. | Record by hand if the UI shows any |

## Stop points

Stop before any of these steps, whether the data came from the tool or from a
manual export:

- Saving or publishing live listing changes.
- Uploading product images or A+ content.
- Changing catalog data.
- Sharing recommendations outside your team while the analysis is still
  speculative and nobody responsible for the account has reviewed it.
