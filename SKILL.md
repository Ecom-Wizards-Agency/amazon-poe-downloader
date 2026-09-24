---
name: amazon-poe-downloader
description: "Download Amazon Product Opportunity Explorer (POE) niche data from the user's own signed-in Seller Central session into local CSV and JSON files: products, search terms, review insights, returns, trends and related niches."
license: MIT
---

# Amazon POE Downloader

Browser: CDP (a Chrome window started with remote debugging and signed in to Seller Central). Fallback: run fetch-poe.js in the DevTools console of an Opportunity Explorer page and pipe the result into format-poe.mjs.

## What it does

Downloads raw Product Opportunity Explorer data and writes it to a local folder. It does not score niches, rank opportunities or make recommendations.

## Preconditions

- Node 22 or newer. No npm install is needed.
- Chrome running with `--remote-debugging-port` on a dedicated profile (default `127.0.0.1:9222`), signed in to each Seller Central regional domain that will be used (for example `sellercentral.amazon.com` and `sellercentral.amazon.de` are separate sign-ins).
- The seller account has access to Product Opportunity Explorer.
- `<skill-dir>` below means the folder containing this file. Run `node <skill-dir>/run-poe.mjs` from the user's working directory so `./poe-output` lands there.
- If Chrome is unreachable (`CDP_UNREACHABLE`; `doctor` prints `Chrome: not reachable (CDP_UNREACHABLE)`), ask the user to start it with the command in the README Quick start. Never start Chrome yourself on the user's default profile.

## Account safety

POE adds every niche you open to the active account's recently viewed niches. A user who manages several seller accounts must confirm the account before any download.

1. Run `doctor --marketplace <cc>` before the first data command in a session. Show the user the printed `Active account` line (account name, partnerAccountId, marketplace) and get confirmation. `doctor` exits 0 when ready and 1 when not ready. With `--quick` it judges only the open tabs and exits 2 when they could not be probed conclusively (`Login: INDETERMINATE`).
2. Pass `--account-name`, `--expected-partner-account-id`, `--marketplace-label` and `--marketplace` on every data command, plus `--parent-account-name` when the picker groups accounts under a parent entry.

What the runner does with those options:

- It reads the active account (name from the page header, partnerAccountId, merchantId and marketplace from `GetUserContext`) and prints it on stderr before any data request.
- `--account-name`, `--expected-partner-account-id` and `--expect-account` are checked against the active account. `--expected-partner-account-id` must match exactly. `--account-name` must equal the header name alone, or the header name followed by the marketplace label with a space or ` / ` between them (`Example Seller United States` or `Example Seller / United States`). With `--account-name`, the session marketplace must also match `--marketplace`; without it, the session marketplace is not compared before the fetch. `--marketplace-label` and `--parent-account-name` steer the picker and are rejected without `--account-name` (`POE_ARGUMENT_INVALID`).
- Without any account option it prints a NOTE and downloads from whatever account is active. Do not run it that way for a multi-account user.
- On a mismatch it switches only when `--account-name` and `--marketplace-label` are both given: it opens Seller Central's account picker in its own tab, expands the parent entry if given, selects the account and marketplace with real mouse clicks, returns to POE and checks the identity again. The clicks bring the run's tab to the front of its Chrome window. Tell the user before a run that may switch, because the switch changes the active account of their Seller Central session in that Chrome profile.
- Otherwise, or when the picker is ambiguous or the post-switch check fails, it fetches nothing and exits with `POE_ACCOUNT_CHECK_FAILED`, keeping the tab open.
- Before Chrome is contacted, a data command's `--origin` must be a known Seller Central https origin (`POE_ORIGIN_UNKNOWN`) in the same region as `--marketplace` (`ORIGIN_MARKETPLACE_REGION_MISMATCH`). `doctor` reports another region as `Marketplace: WRONG REGION` instead.
- Once POE is ready, it reads a baseline identity, giving the account header up to 10 s to render; a header that never renders leaves the name empty rather than guessed from another page element. It re-reads the account and the tab's origin before and after every request and discards a response when the account or the session marketplace (`GetUserContext` `marketplaceSelection`) changed or the origin is no longer the exact origin the run opened (`POE_CONTEXT_CHANGED`). The ids (merchantId, partnerAccountId) and the marketplace are compared exactly; the display name is compared only when no strong id is available, because it comes from the page and can render late. A field that could not be read for the baseline (for example a missing `marketplaceSelection`) is not compared; the response marketplace check below still covers the data.
- It then requires the marketplace id the response itself reports to equal `--marketplace`: `niche.obfuscatedMarketplaceId` for `niche`, every returned row for `search` and `batch`, the merchant info for `merchant-niches` (not yet confirmed live; if every `merchant-niches` run fails with marketplace `(none)`, report that as a contract difference). A different or missing id discards the response (`POE_MARKETPLACE_MISMATCH`). A niche response must also report the requested niche id (`POE_NICHE_MISMATCH`). An empty search result or an empty merchant-niches result has nothing to compare.
- A run that fails once its tab has started loading Seller Central (account check, failed fetch, rejected response, batch with failed niches) keeps the tab open for inspection. Diagnostics print URLs as origin and path only.

Never handle credentials, two-step verification, CAPTCHA, cookies or browser storage. The user signs in and completes challenges.

## Commands

```text
usage: run-poe.mjs <command> [options]

commands:
  doctor [--origin URL | --quick] [--marketplace cc]
                         check Chrome, the Seller Central login, the POE page and the active account
  niche --niche-id ID    download one niche in full (products, search terms, review insights, returns, overview)
  search --query KW      download the related-niches grid for one keyword
  batch --queries "a,b" [--niche-ids id1,id2] [--top N=15 | --all]
                         search each keyword, then download every kept niche in full
                         (--query KW works in place of --queries, not together with it)
  merchant-niches        download the niches POE lists for the active account
  self-test              run the offline self-checks
  help                   print this help

Data commands are niche, search, batch and merchant-niches. Options take their
value as the next argument or after "=", as in --marketplace=us; unknown,
repeated or empty options are rejected with POE_ARGUMENT_INVALID.

options for doctor and the data commands:
  --marketplace cc       required for data commands: us, de, it, es, fr, uk, nl, se, pl, ca, in, jp
  --origin URL           Seller Central origin override (default: derived from --marketplace)
  --port N               Chrome debug port (default: CDP_PORT or 9222)
  --host H               Chrome debug host (default: CDP_HOST or 127.0.0.1)
  --keep-tab             keep the run's tab open after a successful run

options for the data commands only:
  --out-dir DIR          output folder (default: POE_OUT_DIR or ./poe-output)
  --label NAME           optional subfolder inside the output folder
  --verbose              also store the raw capture envelope

account options (data commands only):
  --account-name NAME                seller account name as shown in the account picker
  --expected-partner-account-id ID   partnerAccountId that must match exactly
  --parent-account-name NAME         parent entry to expand in the picker, when applicable
  --marketplace-label LABEL          marketplace label in the picker, e.g. "United States"
  --expect-account TEXT              loose check: name or id the active account must contain or be contained in

--account-name, --expected-partner-account-id and --expect-account are
checked against the active account before any data request.
--marketplace-label and --parent-account-name only steer the account picker
and are rejected without --account-name. A mismatch is switched through the
account picker only when --account-name and --marketplace-label are both
given; otherwise the run stops before fetching.

Output: files in the output folder plus one JSON receipt on stdout.
Environment: CDP_PORT, CDP_HOST, CDP_DEBUG=1 (log every protocol call), POE_OUT_DIR.
```

This block is the output of `node <skill-dir>/run-poe.mjs help`. Niche ids come from the `Niche ID` column of a search CSV or from a URL `/opportunity-explorer/explore/niche/<nicheId>`. Ask the user before `--all` or a batch of more than 25 niches: each niche takes about 5 s plus response time. `--top` limits the search niches only; every `--niche-ids` entry is downloaded. `batch` takes `--queries` or `--query`, not both, and `--top` or `--all`, not both (`POE_ARGUMENT_INVALID`). Options take their value as the next argument or after `=` (`--marketplace=us`); an unknown, repeated, empty or missing required option stops the run with `POE_ARGUMENT_INVALID` before Chrome is touched, so fix the spelling instead of dropping the option. To read another marketplace of the same region through one sign-in without switching, pass `--origin` (for example `--origin https://sellercentral.amazon.de --marketplace fr`) and leave out `--account-name`; pin the account with `--expected-partner-account-id`. With `--account-name` the session marketplace must equal `--marketplace`, so pass the target marketplace's picker label (for example `--marketplace-label "France"`): the runner then switches the session's marketplace through the picker. Tell the user before such a run.

## Outputs

Files go to `--out-dir` (default `POE_OUT_DIR`, then `./poe-output`), inside the optional `--label` subfolder. Existing files are never overwritten.

- `niche`: Products and Search Terms CSVs, customer review insights JSON and CSV, returns JSON and CSV, overview JSON, full niche JSON (includes the weekly `trendsMetrics`).
- `search`: related-niches JSON and CSV for the keyword.
- `batch`: one related-niches pair per keyword plus the `niche` files for each kept niche.
- `merchant-niches`: one merchant-niches JSON.
- `--verbose` adds the raw capture envelope.

Stdout carries one JSON receipt when at least one file was stored, including files stored before a later failure (`status` is then `incomplete`), and for every `batch` that reached its niche downloads, even when all of them failed or the batch stopped (`artifacts` can then be empty). Any other failed run prints none (the message, with its code where one applies, is on stderr and the exit code is non-zero). A failed niche download is skipped; a rejected niche response, a CDP timeout or an interrupt stops the batch. Report to the user: the output folder (`output_folder`), the file list, the account and marketplace, the capture date (`captures[].captured_at`), POE's `lastUpdated` date (`captures[].last_updated`), any `failed` batch niches and any `pending` niches the batch did not finish.

## Safety rules

- Only same-origin, read-only GraphQL reads in the user's own session, plus a same-origin `GET /home` for the account identity on pages without the meta tag. Nothing in the account is created, edited or deleted. Two effects remain: POE lists every opened niche in the active account's recently viewed niches, and a run with `--account-name` and `--marketplace-label` may switch the session's selected account and marketplace through the picker.
- The only added header is the value of the page's own `anti-csrftoken-a2z` meta tag, the anti-forgery value the page itself sends. It is not a cookie or credential.
- Never read cookies, local or session storage, passwords or tokens. Never sign in for the user.
- Requests run one at a time, with about 5 s between heavy data requests. Never run commands in parallel against the same Chrome.
- No retry loops and no invented data. A failed request is reported, not guessed around.
- Keep downloaded data private to the user and their team.

## Stop points

Stop and tell the user when:

- Seller Central is signed out, shows a sign-in or challenge page, or the account chooser cannot be resolved.
- The account or marketplace does not match, or the picker is ambiguous.
- Any command exits with an error code. Report it; do not loop.
- The next step would change anything Amazon can see (listings, images, catalog, ads). That is out of scope.
- The data would be shared outside the user's team.
- A fix would mean editing this tool's scripts during a live run, unless the user asked for that.

## Troubleshooting

| Code | Meaning and next step |
|---|---|
| `CDP_UNREACHABLE` | No Chrome debug endpoint. User starts Chrome with the README command. |
| `CDP_PORT_INVALID` | `--port` or `CDP_PORT` is not an integer from 1 to 65535. |
| `POE_RUN_IN_PROGRESS` | Another run holds this Chrome endpoint. Wait for it to finish. The message names the lock file; ask the user before deleting it. |
| `POE_MARKETPLACE_REQUIRED`, `POE_MARKETPLACE_UNKNOWN` | Pass a known `--marketplace` code. |
| `POE_ORIGIN_UNKNOWN` | `--origin` is not a known Seller Central https origin. |
| `ORIGIN_MARKETPLACE_REGION_MISMATCH` | `--origin` belongs to another region than `--marketplace`. |
| `POE_ARGUMENT_INVALID`, `POE_LABEL_INVALID`, `POE_OUT_DIR_INVALID` | Fix the option the message names (spelling, repeated, empty or missing option, extra argument, a picker option without `--account-name`, `--top`, `--label` or `--out-dir`), or drop `--quick` or `--origin` from `doctor`, `--queries` or `--query` from `batch`, or `--top` or `--all` from `batch`. |
| `POE_SIGNED_OUT`, `POE_HUMAN_CHALLENGE` | User signs in or completes the challenge in the kept tab, then re-run. |
| `POE_ACCOUNT_CHOOSER` | No account selected. User picks one, or pass the account options. |
| `POE_AUTHORIZATION_FAILED` | This account has no POE access. |
| `POE_NOT_READY` | POE did not load within 30 s. Check the kept tab. `doctor` also prints this label for an error without a code, such as a CDP timeout; the text after it names the cause. |
| `POE_ACCOUNT_CHECK_FAILED` | Account did not verify; stderr says why. Nothing was fetched. |
| `Timed out waiting for requested Seller Central account <name>` | Neither the account name nor the parent name appears in the picker. Confirm the exact spelling with the user. |
| `ACCOUNT_SWITCH_BLOCKED`, `ACCOUNT_SWITCH_ACCOUNT_*`, `ACCOUNT_SWITCH_PARENT_*`, `ACCOUNT_SWITCH_MARKETPLACE_*` | The entry is not one visible picker entry (`_MISSING`), matches more than once (`_AMBIGUOUS`) or did not load in time (`_TIMEOUT`). Confirm exact picker labels with the user. |
| `POE_CONTEXT_CHANGED`, `POE_CONTEXT_UNVERIFIED` | Account, marketplace or origin changed mid-run, or no identity was readable. Re-run doctor. |
| `POE_MARKETPLACE_MISMATCH`, `POE_NICHE_MISMATCH` | The marketplace id or niche id the response reports is missing or differs from the request. Nothing from that response was stored. |
| `POE_FETCH_FAILED`, `POE_SEARCH_FAILED` | The GraphQL read failed (401/403, sign-in redirect, missing meta tag, unknown niche id, changed API). |
| `POE_FORMAT_INVALID` | The formatter rejected the capture. If it names a missing section, the API changed; see README Maintenance. |

## References

- references/poe-endpoints.md: the GraphQL operations and fields the tool uses
- references/poe-gap-matrix.md: what POE shows against what the tool captures
- references/manual-export-fallback.md: manual export steps when remote debugging is not available
- README.md: install, flags, output layout and maintenance
