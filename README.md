# amazon-poe-downloader

Downloads Amazon Product Opportunity Explorer (POE) niche data from your own signed-in Seller Central session and writes it to local CSV and JSON files. It drives a Chrome window you started with remote debugging, calls the same GraphQL API the POE page uses, and formats the results on your machine. It is self-contained and needs no npm packages. It is not affiliated with or endorsed by Amazon.

## What it captures

| POE UI element | Output file | Notes |
|---|---|---|
| Overview metric cards | `*_overview.json` | Full `nicheSummary` (search volume, growth, units sold, prices, return rate, fee breakdown, sales potential score) plus `textLines` in the Overview tab's label format |
| Launch potential cards | `*_overview.json` (`launchPotential`) | About 30 metrics, each with current value, QoQ and YoY |
| Insights & Trends charts | `*_niche-full.json` (`niche.trendsMetrics`) | About 104 weekly points with about 24 metrics each |
| Products tab | `*_NicheDetailsProductsTab.csv` | Every row, in the English layout of POE's own Products download |
| Search Terms tab | `*_NicheDetailsSearchTermsTab.csv` | Every row, in the English layout of POE's own Search Terms download; extra API fields stay in `*_niche-full.json` |
| Customer Review Insights | `*_customer-review-insights.json` and `.csv` | Positive and negative topics with % of mentions and review snippets, star-rating impact, topic and subtopic drill-down, topic trends (JSON). Topic names arrive in the marketplace language |
| Returns tab | `*_returns.json` and `.csv` | Return topics with % of mentions and monthly trends, plus the niche return rate. A niche without returns data gets `notExposed: true` and a marker row in the CSV |
| Keyword search results grid | `*_related-niches.json` and `.csv` | Every niche the search returns, with no cap (broad keywords return several hundred) and a `Niche ID` column |
| Your own niches | `*_merchant-niches.json` | The niches POE lists for the active account |

Not captured: the trending niche modules on the POE home page, the category browse tree, search typeahead suggestions and demographics.

## Requirements

- Node.js 22.23.4 or 24.22.1 or newer (October 2026 security release). There are no npm dependencies.
- Google Chrome or Chromium.
- A Seller Central account with access to Product Opportunity Explorer. The menu entry is usually Growth > Product Opportunity Explorer.
- One sign-in per Seller Central regional domain you use. `sellercentral.amazon.com` and `sellercentral.amazon.de` are separate sign-ins, even for the same account.

## Install

### As a command-line tool

```bash
git clone https://github.com/Ecom-Wizards-Agency/amazon-poe-downloader.git
cd amazon-poe-downloader
node run-poe.mjs help
```

No `npm install` step is needed.

### As an agent skill

The repository root is a skill folder (`SKILL.md` sits at the top). Link it into the skills folder of each agent you use. The link name must equal the folder name, `amazon-poe-downloader`.

macOS and Linux, from the folder that contains the clone:

```bash
mkdir -p ~/.claude/skills ~/.codex/skills
ln -s "$PWD/amazon-poe-downloader" ~/.claude/skills/amazon-poe-downloader
ln -s "$PWD/amazon-poe-downloader" ~/.codex/skills/amazon-poe-downloader
```

Windows PowerShell (symbolic links need an elevated shell, or Developer Mode with PowerShell 7 or later):

```powershell
mkdir -Force "$HOME\.claude\skills", "$HOME\.codex\skills" | Out-Null
New-Item -ItemType SymbolicLink -Path "$HOME\.claude\skills\amazon-poe-downloader" -Target "$PWD\amazon-poe-downloader"
New-Item -ItemType SymbolicLink -Path "$HOME\.codex\skills\amazon-poe-downloader" -Target "$PWD\amazon-poe-downloader"
```

If you cannot create symbolic links, copy the folder instead. A copy does not follow the clone, so replace it after each `git pull`. Remove the old copy first: `Copy-Item -Recurse` into a folder that already exists puts a second copy inside it and leaves the old files in place.

```powershell
foreach ($agent in ".claude", ".codex") {
  $dest = "$HOME\$agent\skills\amazon-poe-downloader"
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Copy-Item -Recurse amazon-poe-downloader $dest
}
```

Start a new agent session after installing so the agent picks up the skill.

## Quick start

1. Start Chrome with a debug port and a dedicated profile. Quit any Chrome that already uses that profile first.

   macOS:

   ```bash
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/.poe-chrome"
   ```

   Linux:

   ```bash
   google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.poe-chrome"
   ```

   Windows PowerShell:

   ```powershell
   & "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:LOCALAPPDATA\poe-chrome"
   ```

   Other installs work the same way with the same two flags: on Linux the binary may be `google-chrome-stable`, `chromium` or `chromium-browser`, and a per-user Windows install lives at `"$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"`.

   Chrome 136 and later ignore `--remote-debugging-port` on the default profile, so the separate `--user-data-dir` is required.

2. In that window, sign in to Seller Central, open Product Opportunity Explorer and select the account and marketplace you want. Complete any two-step verification yourself. The profile keeps the sign-in for later runs.

3. Check the setup and read the active account:

   ```bash
   node run-poe.mjs doctor --marketplace us
   ```

   Copy the account name and `partnerAccountId` from the `Active account:` line. If the name is printed as `Example Seller United States` or `Example Seller / United States`, the account name is `Example Seller` and the marketplace label is `United States`. When the account header has not rendered within 10 s, the line shows the partnerAccountId only.

   `doctor` exits 0 when it ends with `Doctor: ready.` and 1 when something is not ready (Chrome unreachable, no sign-in, a challenge, POE not loading, a wrong region or an invalid option). Without `--quick` it opens a fresh POE tab even when the open Seller Central tabs are stale or signed out, and that tab decides; with `--marketplace` it also checks that marketplace's own domain when no open tab is in its region. `doctor --quick` judges only the open tabs and exits 2 when they could not be probed conclusively (`Login: INDETERMINATE`); retry or reload the tab in that case.

4. Search a keyword and store the related-niches grid:

   ```bash
   node run-poe.mjs search --query "desk lamp" --marketplace us \
     --account-name "Example Seller" --expected-partner-account-id AEXAMPLE000001 \
     --marketplace-label "United States" --out-dir ./poe-output
   ```

5. Download one niche in full. Take the id from the `Niche ID` column of the search CSV, or from a niche URL `/opportunity-explorer/explore/niche/<nicheId>`:

   ```bash
   node run-poe.mjs niche --niche-id <nicheId> --marketplace us \
     --account-name "Example Seller" --expected-partner-account-id AEXAMPLE000001 \
     --marketplace-label "United States"
   ```

6. Search several keywords, merge the results by niche id and download the first 10 niches in full:

   ```bash
   node run-poe.mjs batch --queries "desk lamp,floor lamp" --top 10 --marketplace us \
     --account-name "Example Seller" --expected-partner-account-id AEXAMPLE000001 \
     --marketplace-label "United States"
   ```

7. List the niches POE shows for your own account:

   ```bash
   node run-poe.mjs merchant-niches --marketplace us \
     --account-name "Example Seller" --expected-partner-account-id AEXAMPLE000001 \
     --marketplace-label "United States"
   ```

### Flags

| Flag | Applies to | Default | Meaning |
|---|---|---|---|
| `--marketplace cc` | `doctor` (optional), data commands (required) | none | Marketplace code: `us`, `de`, `it`, `es`, `fr`, `uk`, `nl`, `se`, `pl`, `ca`, `in`, `jp` |
| `--origin URL` | data commands, `doctor` without `--quick` | derived from `--marketplace` | Seller Central origin to open, for example `https://sellercentral.amazon.de`. Must be the https origin of the Seller Central domain of one of the `--marketplace` codes (`POE_ORIGIN_UNKNOWN` otherwise). Data commands reject an origin in another region than `--marketplace` with `ORIGIN_MARKETPLACE_REGION_MISMATCH`; `doctor` reports it as `Marketplace: WRONG REGION` |
| `--quick` | `doctor` | off | Skip opening POE; use only the open Seller Central tabs. Cannot be combined with `--origin` (`POE_ARGUMENT_INVALID`) |
| `--niche-id ID` | `niche` | none | Niche to download |
| `--query KW` | `search` | none | Keyword to search |
| `--queries "a,b"` | `batch` | none | Comma-separated keywords. `--query` works in its place; giving both is rejected (`POE_ARGUMENT_INVALID`) |
| `--niche-ids id1,id2` | `batch` | none | Extra niche ids, downloaded after the search niches. `--top` does not limit them |
| `--top N` | `batch` | 15 | Download the first N niches of the merged search results, in search order. Cannot be combined with `--all` (`POE_ARGUMENT_INVALID`) |
| `--all` | `batch` | off | Download every niche of the merged search results |
| `--port N` | `doctor`, data commands | `CDP_PORT` or 9222 | Chrome debug port |
| `--host H` | `doctor`, data commands | `CDP_HOST` or 127.0.0.1 | Chrome debug host. A host other than loopback prints a warning |
| `--out-dir DIR` | data commands | `POE_OUT_DIR` or `./poe-output` | Output folder, created if missing |
| `--label NAME` | data commands | none | Subfolder inside the output folder: 1 to 64 letters, digits, `.`, `_` or `-`, starting with a letter or digit |
| `--keep-tab` | `doctor`, data commands | off | Keep the run's tab open after success. A run that fails once its tab has started loading Seller Central always keeps it |
| `--verbose` | data commands | off | Also store the raw capture envelope |
| `--account-name NAME` | data commands | none | Seller account name as shown in the account picker. The page header must show exactly this name, or this name followed by the marketplace label with a space or ` / ` between them |
| `--expected-partner-account-id ID` | data commands | none | partnerAccountId that must match exactly |
| `--parent-account-name NAME` | data commands | none | Parent entry to expand in the picker when accounts are grouped. Needs `--account-name` |
| `--marketplace-label LABEL` | data commands | none | Marketplace label in the picker, for example `United States`. Needs `--account-name` |
| `--expect-account TEXT` | data commands | none | Loose check: the account name or an id must contain or be contained in TEXT. Prefer the options above |
| `help`, `--help` | | | Print the usage text |

The table follows `node run-poe.mjs help`: data commands are `niche`, `search`, `batch` and `merchant-niches`; `--marketplace`, `--origin`, `--port`, `--host` and `--keep-tab` apply to `doctor` and the data commands; `--out-dir`, `--label`, `--verbose` and the account options apply to the data commands only.

An option takes its value as the next argument (`--marketplace us`) or in the same argument (`--marketplace=us`). An unknown or misspelled option, an option of another command, an extra argument, an empty value, a repeated option, a missing required option (`--niche-id` for `niche`, `--query` for `search`, `--queries` or `--niche-ids` for `batch`), or `batch` with both `--queries` and `--query` or both `--top` and `--all` stops the run with `POE_ARGUMENT_INVALID` before the output folder, the run lock or Chrome is touched.

Environment variables: `CDP_PORT`, `CDP_HOST`, `CDP_DEBUG=1` (prints one line per protocol call with its round-trip time) and `POE_OUT_DIR`.

What the account check compares depends on the options. `--account-name`, `--expected-partner-account-id` and `--expect-account` are checked against the active account. `--expected-partner-account-id` must equal the session's partnerAccountId, and `--expect-account` is a loose name or id match. Only with `--account-name` does the check also compare the header name and the session's selected marketplace with `--marketplace`. The header must show exactly the `--account-name` value, or that value followed by the `--marketplace-label` value with a space or ` / ` between them (`Example Seller United States` or `Example Seller / United States`). `--marketplace-label` and `--parent-account-name` steer the account picker; `--marketplace-label` also lets a header name such as `Example Seller United States` prove the marketplace when the session does not report one. Both need `--account-name` and are rejected with `POE_ARGUMENT_INVALID` without it. Without `--account-name` the session marketplace is not compared before the fetch; the marketplace id each response reports is still checked (see How it works). When the check fails, the runner switches through Seller Central's account picker only if `--account-name` and `--marketplace-label` are both given. Otherwise it stops before fetching. Without any account option it prints the active account and downloads from it, so pass the options whenever you manage more than one account.

One sign-in covers every marketplace of its region, but each marketplace code defaults to its own domain. To read `fr` through a `.de` sign-in without changing the session's marketplace, pass `--origin https://sellercentral.amazon.de --marketplace fr` and leave out `--account-name` (use `--expected-partner-account-id` to pin the account). With `--account-name`, the session marketplace must be `fr`: pass the picker label of the target marketplace (for example `--marketplace-label "France"`) and the runner switches the session to it through the account picker before fetching.

## Alternative without remote debugging

You can run the fetcher by hand in a normal Chrome window:

1. Open any Product Opportunity Explorer page in Seller Central.
2. Open DevTools (F12), go to the Console, paste the whole content of `fetch-poe.js` and press Enter. Chrome shows a warning on the first paste and asks you to type `allow pasting` before it accepts pasted code.
3. Run:

   ```js
   copy(JSON.stringify(await fetchPoeNiche({nicheId:"<id>"})))
   ```

   `fetchPoeSearch({query:"<keyword>"})` and `fetchPoeMerchantNiches()` work the same way.
4. Format the clipboard content into files:

   ```bash
   pbpaste | node format-poe.mjs --stdin --out-dir ./poe-output             # macOS
   xclip -selection clipboard -o | node format-poe.mjs --stdin --out-dir ./poe-output   # Linux (X11)
   ```

   ```powershell
   # Windows. The first line makes PowerShell pipe UTF-8; without it, Windows
   # PowerShell 5.1 turns every non-ASCII character (umlauts, accents) into "?".
   $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
   Get-Clipboard -Raw | node format-poe.mjs --stdin --out-dir ./poe-output
   ```

This path has no automatic account check. Look at the account and marketplace in the page header before you run anything. `format-poe.mjs` also accepts `--label NAME` and `--date YYYY-MM-DD` (overrides the date in file names), and `node format-poe.mjs --self-test` runs its offline checks. [references/manual-export-fallback.md](references/manual-export-fallback.md) covers the manual CSV download buttons.

## Output layout

```text
poe-output/
  <label>/                                                  only with --label
    2026-09-24_poe_us_desk-lamp_related-niches.json         search, batch
    2026-09-24_poe_us_desk-lamp_related-niches.csv
    2026-09-24_us-desk-lamp_NicheDetailsProductsTab.csv      niche, batch
    2026-09-24_us-desk-lamp_NicheDetailsSearchTermsTab.csv
    2026-09-24_poe_us-desk-lamp_customer-review-insights.json
    2026-09-24_poe_us-desk-lamp_customer-review-insights.csv
    2026-09-24_poe_us-desk-lamp_returns.json
    2026-09-24_poe_us-desk-lamp_returns.csv
    2026-09-24_poe_us-desk-lamp_overview.json
    2026-09-24_poe_us-desk-lamp_niche-full.json
    2026-09-24_poe_us_merchant-niches.json                   merchant-niches
    2026-09-24T10-15-02.123Z_poe_niche_raw.json              --verbose only
```

- The date is the UTC capture date. The country code comes from the marketplace id. The slug is the niche title or keyword in lowercase ASCII letters and digits, at most 60 characters. A niche title with no Latin letters or digits (common on `jp`) uses `niche-<niche id>` instead. Such a keyword becomes `unknown`, so two such searches in one folder share a base name and the second is stored under the `<sha1 prefix>_<name>` rule below.
- Files are never overwritten. If a file with the same name and identical bytes exists, it is reported as `existing`. If the name holds different bytes, the new file is stored as `<sha1 prefix>_<name>`.
- Schema ids: `amazon-poe-downloader.envelope.v1` (niche-full, merchant-niches and raw files), `amazon-poe-downloader.overview.v1`, `amazon-poe-downloader.cri.v1`, `amazon-poe-downloader.returns.v1` and `amazon-poe-downloader.related-niches.v1`.
- The overview JSON carries an `account` block (`displayName`, `partnerAccountId`, `sessionMarketplaceId`) from the verified session. `sessionMarketplaceId` is the marketplace selected in the session; in a same-region read it differs from the overview's `marketplace`, which is the marketplace of the data. Files made by `format-poe.mjs --stdin` have `account: null`.
- The `url` field of niche-full, merchant-niches and raw files holds the page's origin and path only, without a query string. For `niche`, the `--verbose` raw file has the same content as `niche-full.json`.
- All CSVs are UTF-8 with a byte order mark. The Products and Search Terms CSVs follow POE's own download: 3 preamble lines (niche name, tab name, last updated date), a blank line, then English headers whatever your UI language. Their numbers are floored like the UI download: shares and growth to 4 decimals, prices to 2, counts to whole numbers.
- CSV cells are quoted but otherwise written as POE returns them, like POE's own download. Product titles and search terms come from third parties, and a spreadsheet may run a cell that starts with `=`, `+`, `-` or `@` as a formula. Open the CSVs with formulas disabled, or import them as text, when that matters to you.
- Known deviations from POE's own download: "Average Customer Rating" has 1 decimal (`4.6`) where the UI shows 2 (`4.59`), because the API returns 1. The Search Terms column "Click Share (Past 360 days)" uses the short-window `clickShare` field, as the UI download does, not `clickShareT360`.

Each data command that stores at least one file prints one JSON receipt on stdout, and so does every `batch` that reaches its niche downloads, even when all of them failed or the batch stopped (its `artifacts` array can then be empty). Any other run that fails before a file is stored prints no receipt: the error message, with its code where one applies, is on stderr and the exit code is non-zero. Progress and account lines go to stderr.

```json
{
  "schema_version": 1,
  "status": "stored_verified",
  "complete": true,
  "output_folder": "/path/to/poe-output",
  "artifacts": [
    { "name": "…", "stored_name": "…", "path": "…", "sha1": "…", "bytes": 1234, "status": "written" }
  ],
  "captures": [
    { "kind": "niche", "captured_at": "2026-09-24T10:15:02.123Z", "last_updated": "2026-09-21T00:00:00Z" }
  ]
}
```

`output_folder` is the absolute path of the output folder, including the `--label` subfolder. `last_updated` is POE's own data date for a niche and `null` for other kinds. When a batch loses niches, or a run fails or is interrupted after storing some files (including files of a set whose later files could not be stored), the receipt has `"status": "incomplete"`, `"complete": false`, lists the stored files and exits non-zero. For a batch it also lists `failed`, the niches whose download failed or was rejected (each with its `id`, `title` and `error`), and `pending`, the niches it had not finished when it stopped. A niche whose download fails is skipped and the batch goes on. A rejected niche response (`POE_MARKETPLACE_MISMATCH`, `POE_NICHE_MISMATCH`, `POE_CONTEXT_CHANGED`, `POE_FORMAT_INVALID`), a CDP timeout or an interrupt stops the batch. Ctrl+C exits 130 and a termination signal 143; both print the id of the run's open tab, which stays open.

The output contains your account's data. Keep it private. `poe-output/` is listed in `.gitignore`.

## How it works

1. `run-poe.mjs` connects to Chrome over the DevTools protocol and opens a new background tab at `<origin>/opportunity-explorer`. Your other tabs are left alone.
2. It waits for the POE app, the account chooser or a sign-in state, then reads the active account: the name from the account header of the page, and partnerAccountId, merchantId and marketplace from the `GetUserContext` GraphQL operation. On a loaded POE page it gives the account header up to 10 s to render and takes the name only from the header or the account picker, never from another element such as the Account Health widget; if neither shows text by then, the name stays empty. It checks the account against your account options and switches through the account picker when allowed. A switch brings the run's tab to the front of its Chrome window for the picker clicks, because the clicks need a focused page. Once POE is ready it reads the account the same way again as the baseline for step 4.
3. It evaluates `fetch-poe.js` inside the page. The fetcher sends `POST /ox-api/graphql` requests from the page's own origin, so the browser attaches your session. It uses four operations: `getNiche`, `getNiches` (keyword search), `getMerchantInfoByPartnerId` and `GetUserContext`. One `getNiche` call returns every niche tab: overview, products, search terms, trends, review insights and returns.
4. Before and after each request the runner reads the account and the session marketplace (`GetUserContext` `marketplaceSelection`) again, together with the tab's origin. It discards the response with `POE_CONTEXT_CHANGED` if the account or the marketplace changed or the origin is no longer the exact origin the run opened. The ids (merchantId, partnerAccountId) and the marketplace are compared exactly; the display name is compared only when no strong id is available, because it comes from the page and can render late. A field that could not be read for the baseline, for example a missing `marketplaceSelection`, is not compared; step 5 still checks the marketplace of the data.
5. It then compares the marketplace id the response itself reports with `--marketplace`: `niche.obfuscatedMarketplaceId` for `niche`, the `obfuscatedMarketplaceId` of every returned row for `search` and `batch`, and the merchant info's `obfuscatedMarketplaceId` for `merchant-niches` (not yet confirmed against live Seller Central; see [references/poe-endpoints.md](references/poe-endpoints.md#marketplace-verification-status)). A different or missing id discards the response with `POE_MARKETPLACE_MISMATCH`. An empty search result or an empty merchant-niches result has nothing to compare. A niche response must also report the requested niche id (`POE_NICHE_MISMATCH` otherwise). Before any of this, and before Chrome is contacted, a data command's `--origin` must be a known Seller Central origin in the same region as `--marketplace`.
6. `format-poe.mjs` turns each accepted capture into files locally. No data leaves your machine.
7. On success the tab is closed. When a run fails once its tab has started loading Seller Central, including a failed fetch, a rejected response or a batch with failed niches, the tab stays open so you can see the page state. A tab whose navigation could not start at all is closed again, because it holds nothing to inspect.

Only one data command at a time can use a Chrome endpoint. A lock file in the system temp folder enforces this; `localhost`, `127.0.0.1` and `::1` count as the same endpoint. A lock left by a process that no longer exists is reclaimed, and so is a lock naming the current run's own process id, which can only come from a reused id after a crash.

Field-level details are in [references/poe-endpoints.md](references/poe-endpoints.md). What POE shows against what the tool captures is in [references/poe-gap-matrix.md](references/poe-gap-matrix.md).

## Safety and responsible use

- The tool sends read-only, same-origin GraphQL requests in your own signed-in session, plus a same-origin `GET /home` to read the account identity on pages without the anti-forgery meta tag. It creates, edits and deletes nothing in your account, with two exceptions you should know about:
  - POE itself adds every niche you open to the active account's recently viewed niches.
  - When `--account-name` and `--marketplace-label` are both given and the session does not match them, the runner clicks through Seller Central's account picker. That changes the selected account and marketplace of the Seller Central session in that Chrome profile, as if you had switched it by hand.
- The only header it adds is the value of the page's own `anti-csrftoken-a2z` meta tag, the anti-forgery value the page sends on its own requests. It never reads cookies, local or session storage, passwords or tokens, and it never signs in.
- Diagnostics print URLs as origin and path only, so the one-time parameters of a sign-in URL never reach your terminal.
- Requests run one at a time with about 5 s between heavy requests. Failed requests are reported, not retried in a loop, and no data is invented.
- Remote debugging exposure: while the debug port is open, any process on your machine can control that Chrome profile, including its signed-in sessions. Keep the port on 127.0.0.1, use a dedicated profile, and close that Chrome when you are done. To reach Chrome on another machine, tunnel the port (`ssh -L 9222:127.0.0.1:9222 <remote>`) and keep the default host; a `--host` other than loopback prints a warning.
- POE adds every niche you open to the active account's recently viewed niches. If you manage several seller accounts, confirm the active account with `doctor` and pass the account options on every run.
- You are responsible for using this tool only as permitted by the agreements governing your Seller Central account.
- Amazon, Seller Central and Product Opportunity Explorer are trademarks of Amazon.com, Inc. or its affiliates. This project is not affiliated with, endorsed by or sponsored by Amazon.
- The software is provided under the MIT License, as is, without warranty of any kind.

## Troubleshooting

| Symptom or code | Cause and fix |
|---|---|
| `CDP_UNREACHABLE`, `ECONNREFUSED`, `fetch failed` | No Chrome is listening on the debug port. `doctor` prints it as `Chrome: not reachable (CDP_UNREACHABLE)`. Start Chrome with the Quick start command. |
| Chrome is open but still `CDP_UNREACHABLE` | Chrome was started on the default profile, or a Chrome already running with that profile swallowed the new launch. Quit Chrome and start it again with `--user-data-dir`. |
| `CDP_PORT_INVALID` | `--port` or `CDP_PORT` is not an integer from 1 to 65535. |
| `POE_RUN_IN_PROGRESS` | Another run uses the same Chrome endpoint. Wait for it, or use a second Chrome on another port. The message names the lock file; delete it only when no run is active, for example after a crash whose process id now belongs to another program. |
| `POE_MARKETPLACE_REQUIRED` | Data commands need `--marketplace cc`. |
| `POE_MARKETPLACE_UNKNOWN` | Unknown marketplace code. Use one of `us`, `de`, `it`, `es`, `fr`, `uk`, `nl`, `se`, `pl`, `ca`, `in`, `jp`. |
| `POE_ORIGIN_UNKNOWN` | `--origin` is not the https origin of a Seller Central domain for one of those codes, for example `http://`, a typo or another host. |
| `ORIGIN_MARKETPLACE_REGION_MISMATCH` | `--origin` is in another region than `--marketplace`, for example `.com` with `fr`. |
| `POE_ARGUMENT_INVALID` | An unknown, misspelled, repeated or empty option, an extra argument, a missing required option, `--top` that is not a positive integer, `--marketplace-label` or `--parent-account-name` without `--account-name`, `batch` with both `--queries` and `--query` or both `--top` and `--all`, or `doctor` with both `--quick` and `--origin`. The message names the argument. |
| `POE_LABEL_INVALID` | `--label` is not 1 to 64 letters, digits, `.`, `_` or `-` starting with a letter or digit. |
| `POE_OUT_DIR_INVALID` | The output folder cannot be created or written. |
| `POE_SIGNED_OUT` | This regional domain is not signed in. EU sign-in is per domain: signing in on `.com` does not cover `.de`. Sign in in the kept tab and re-run. |
| `POE_HUMAN_CHALLENGE` | CAPTCHA or one-time code. Complete it in the kept tab and re-run. |
| `POE_ACCOUNT_CHOOSER` | The session has no account selected. Pick one in the kept tab, or pass `--account-name` and `--marketplace-label`. |
| `POE_AUTHORIZATION_FAILED` | The account has no access to Product Opportunity Explorer. |
| `POE_NOT_READY` | POE did not load within 30 s. Look at the kept tab and re-run. `doctor` also prints this label for an error that carries no code, such as a CDP timeout; the text after the label names the actual cause. |
| `POE_ACCOUNT_CHECK_FAILED` | The active account did not match. Stderr shows `ACCOUNT MISMATCH`, `ACCOUNT CHECK FAILED`, `ACCOUNT SWITCH NOT ATTEMPTED`, `ACCOUNT RECOVERY FAILED` or `POST-SWITCH ACCOUNT CHECK FAILED`. Nothing was fetched. |
| `ACCOUNT_SWITCH_BLOCKED` | The account picker could not be used, for example because of a sign-in or challenge page. |
| `Timed out waiting for requested Seller Central account <name>` | Neither `--account-name` nor `--parent-account-name` appears in the picker within 30 s. Check the exact spelling of the picker entry. |
| `Timed out waiting for seller account <name> under <parent>` | The parent entry expanded, but the account did not appear under it within 30 s. |
| `ACCOUNT_SWITCH_ACCOUNT_MISSING`, `ACCOUNT_SWITCH_ACCOUNT_AMBIGUOUS` | The account label is in the picker page but not visible as an entry, for example collapsed under a parent entry that `--parent-account-name` did not name (`_MISSING`), or more than one visible entry matches it exactly (`_AMBIGUOUS`). |
| `ACCOUNT_SWITCH_PARENT_MISSING`, `ACCOUNT_SWITCH_PARENT_AMBIGUOUS` | Same for `--parent-account-name`. |
| `ACCOUNT_SWITCH_MARKETPLACE_MISSING`, `ACCOUNT_SWITCH_MARKETPLACE_AMBIGUOUS`, `ACCOUNT_SWITCH_MARKETPLACE_TIMEOUT` | The marketplace label is missing under that account, appears twice, or the list did not load within 30 s. Check the exact label in the picker. |
| `POE_CONTEXT_CHANGED` | The account, marketplace or page origin changed during the run, for example because someone switched accounts in another tab. The message names the field. A display name that renders differently does not trigger it while an account id still matches. The response was discarded. |
| `POE_CONTEXT_UNVERIFIED` | No account identity could be read from the page. |
| `POE_MARKETPLACE_MISMATCH` | The marketplace id the response reports (the niche, a search row or the merchant info) differs from `--marketplace` or is missing. The response was discarded. |
| `POE_NICHE_MISMATCH` | The niche id the response reports differs from the requested id or is missing. The response was discarded. |
| `POE_FETCH_FAILED` | The GraphQL read failed. The message says which case applies (see the next rows). |
| `POE_SEARCH_FAILED` | A keyword search in a batch failed. The batch stops. |
| `POE_FORMAT_INVALID` | The formatter rejected the capture: not an envelope, an error inside it, a missing section, an unknown kind or a bad `format-poe.mjs --date`. |
| `CDP ... timed out after ... ms`, `page evaluate threw: ...` | Chrome or the page stopped answering. These errors carry no code. Look at the kept tab, reload it and re-run. |
| `missing anti-csrftoken-a2z meta tag` | The page is not a loaded POE page. Open or reload Product Opportunity Explorer and retry. |
| `not authorized (401)` or `(403)` | The session expired or is on another account or marketplace. Sign in again and check the account. |
| `response was not JSON` | The request was redirected, usually to a sign-in page. Sign in again. |
| `getNiche returned no niche` | Wrong niche id, or the niche does not exist in that marketplace. |

## Maintenance when Amazon changes POE

POE's GraphQL API is undocumented and can change without notice. The POE query strings were last checked live on 2026-07-05. This release's code, including its trimmed `GetUserContext` query and the response marketplace and niche id checks, has not been run against live Seller Central yet. Typical symptoms are a `GraphQL error: Cannot query field ...` message or `niche payload missing required section`.

1. Rediscover the current requests. Run `node tools/discover-poe-endpoints.mjs` against your debug Chrome, label each tab with `label <name>` and click through a niche; it writes one NDJSON file per label. Or open DevTools > Network, filter on `graphql` and click through the niche tabs.
2. Copy the `operationName`, `variables` and query text verbatim into `fetch-poe.js`. Do not edit field lists by hand. The one exception is `GetUserContext`: keep only `partnerAccountId`, `merchantId`, `marketplaceSelection` and `__typename`, so no session value is requested. The trimmed `GetUserContext` query lives in both `fetch-poe.js` and `lib/sc-account.mjs` (the identity read); update both together. The tests pin both copies.
3. Update [references/poe-endpoints.md](references/poe-endpoints.md) with the date of the check.
4. Download the same niche with POE's own Products and Search Terms buttons, compare them with the tool's CSVs, and update [references/poe-gap-matrix.md](references/poe-gap-matrix.md).
5. Run `npm run check`.

Discovery captures contain account data. The discovery tool stores response bodies only for JSON, CSV and GraphQL responses (other types keep only their size), and it replaces the values of sensitive keys in bodies and query strings with `[redacted]`: keys containing `csrf`, `token`, `session`, `customerId`, `cookie`, `authorization`, `password`, `secret`, `openid`, `signature` or `credential` in any letter case (a customer id key matches only when spelled `customerId`, so `customer_id` does not), keys with `sso` at the start of a word, and the sign-in keys `code`, `state`, `nonce` and `arb`, which match only as whole keys (so `currencyCode` keeps its value). It also redacts sensitive meta and input tag values, script assignments, the value of name/value pairs with a sensitive name, and sensitive keys inside JSON stored as a string. Niche data and ids remain. Keep captures out of version control. When you open an issue, never paste request headers, account names or account ids.

## Development

```bash
npm run check        # self-test + test + lint + hygiene
npm test             # node --test on test/**/*.test.mjs
npm run self-test    # offline self-checks of run-poe.mjs and format-poe.mjs
```

Test fixtures must be synthetic. Use placeholders such as `Example Seller`, `AEXAMPLE000001` and `B000000001`, never real account names, ids or captured data.

## License

MIT. See [LICENSE](LICENSE).
