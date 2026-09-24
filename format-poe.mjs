#!/usr/bin/env node
/*
 * Local formatter for fetch-poe.js captures (amazon-poe-downloader.envelope.v1).
 * Deterministic, no network.
 *
 *   node format-poe.mjs --stdin [--out-dir DIR] [--label NAME] [--date YYYY-MM-DD]
 *   node format-poe.mjs --self-test
 *
 * --stdin reads one envelope from stdin and writes the files below into
 * --out-dir (default: POE_OUT_DIR, then ./poe-output), inside the optional
 * --label subfolder. Existing files are never overwritten.
 *
 * kind=niche  →  <date>_<cc>-<slug>_NicheDetailsProductsTab.csv      (EN canonical native layout)
 *                <date>_<cc>-<slug>_NicheDetailsSearchTermsTab.csv   (EN canonical native layout)
 *                <date>_poe_<cc>-<slug>_customer-review-insights.{json,csv}   (positive + negative, sentiment-labeled)
 *                <date>_poe_<cc>-<slug>_returns.{json,csv}
 *                <date>_poe_<cc>-<slug>_overview.json                (canonical keys + Overview tab text lines)
 *                <date>_poe_<cc>-<slug>_niche-full.json              (raw envelope passthrough)
 * kind=search →  <date>_poe_<cc>_<query-slug>_related-niches.{json,csv}   (amazon-poe-downloader.related-niches.v1)
 * kind=context|merchant-niches  →  <date>_poe_<cc>_<kind>.json    (raw envelope passthrough)
 *
 * CSV layout notes (verified against native UI exports):
 * - The UI builds its CSVs client-side with LOCALIZED headers; we emit the EN
 *   canonical layout so output is locale-independent and matches the native
 *   Opportunity Explorer CSV export (BOM + 3 preamble lines + blank + header),
 *   so anything that reads the native export reads these files too.
 * - Numbers are floored (negatives away from zero) with trailing zeros dropped,
 *   exactly like the UI export: shares/growth to 4 decimals, prices to 2,
 *   counts to integers.
 * - Known immaterial deviation: the UI's "Average Customer Rating" column shows a
 *   higher-precision rating (e.g. 4.59) than the API's customerRating field (4.6);
 *   we emit the API value.
 * - The UI's Search-Terms "Click Share (Past 360 days)" column actually uses the
 *   short-window `clickShare` field, not clickShareT360 (verified). We replicate
 *   that bug-for-bug for parity.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
// obfuscatedMarketplaceId → country code (filename use). Fallback: raw id lowercased.
import { MP_CC } from "./lib/marketplaces.mjs";
import { prepareStore, publishFiles, resolveOutDir } from "./lib/local-store.mjs";
import { parseOptions } from "./lib/args.mjs";

const ENVELOPE_SCHEMA = "amazon-poe-downloader.envelope.v1";

const CUR_SYM = { USD: "$", EUR: "€", GBP: "£", PLN: "zł", SEK: "kr", JPY: "¥", CAD: "$" };

// ------------------------------------------------------------------ helpers

export function trunc(v, decimals) {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (decimals === 0) return String(Math.trunc(n));
  const f = 10 ** decimals;
  return (Math.trunc(n * f) / f).toFixed(decimals).replace(new RegExp(`0{0,${decimals - 1}}$`), (m) => m).replace(/\.$/, "");
}

// UI CSV number rule (verified cell-by-cell against native exports): the page
// floors to N decimals and stringifies, so trailing zeros drop ("0.01", not
// "0.0100") and negatives floor AWAY from zero (-0.07799 -> "-0.078").
export function floorStr(v, decimals) {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const f = 10 ** decimals;
  // toPrecision guards float artifacts (0.067*10000 = 669.9999…)
  return String(Math.floor(Number((n * f).toPrecision(12))) / f);
}

// Fixed-decimals display variant (prices in overview/related cells: "$25.25").
export function truncFixed(v, decimals) {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const f = 10 ** decimals;
  return (Math.trunc(n * f) / f).toFixed(decimals);
}

export function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

function csvRow(cells) { return cells.map(csvCell).join(","); }

export function euDate(iso) {
  // "2026-01-10T00:00:00Z" -> "10.1.2026" (matches the native export preamble)
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  if (!m) return "";
  return `${Number(m[3])}.${Number(m[2])}.${m[1]}`;
}

export function slugify(s) {
  return String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "unknown";
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function withCommas(v) {
  const n = num(v);
  return n === null ? "" : Math.trunc(n).toLocaleString("en-US");
}

function pct(v, decimals = 2) {
  const n = num(v);
  return n === null ? "" : `${(n * 100).toFixed(decimals)}%`;
}

// Invalid input throws; the CLI turns the error into stderr output and exit 1.
function fail(msg, keys) {
  throw Object.assign(new Error(`format-poe: ${msg}`), { code: "POE_FORMAT_INVALID", keys });
}

// ------------------------------------------------------------------ niche

const PRODUCTS_HEADER = (cur) =>
  `Product Name,ASIN,Brand,Category,Launch date,Niche Click Count (Past 360 days),Click Share (past 360 days),Average Selling Price (past 360 days) (${cur}),Total Ratings,Average Customer Rating,Average BSR,Buyable Offer Average 1P+3P (past 360 days)`;

const SEARCH_TERMS_HEADER =
  "Search term,Search Volume (Past 360 days),Search Volume Growth (Past 90 days),Search Volume Growth (Past 180 days),Click Share (Past 360 days),Search Conversion Rate (Past 360 days),Top Clicked Product 1 (Title),Top Clicked Product 1 (Asin),Top Clicked Product 2 (Title),Top Clicked Product 2 (Asin),Top Clicked Product 3 (Title),Top Clicked Product 3 (Asin)";

function preamble(nicheTitle, tabLabel, lastUpdatedISO) {
  return `﻿Niche Name: ${nicheTitle}\nNiche Details - ${tabLabel}\nLast updated on ${euDate(lastUpdatedISO)}\n\n`;
}

export function productsCsv(niche) {
  const rows = niche.asinMetrics || [];
  const cur = niche.currency || "USD";
  let out = preamble(niche.nicheTitle, "Products Tab", niche.lastUpdatedTimeISO8601) + PRODUCTS_HEADER(cur) + "\n";
  for (const a of rows) {
    out += csvRow([
      a.asinTitle, a.asin, a.brand, a.category, a.launchDate,
      trunc(a.clickCountT360, 0), floorStr(a.clickShareT360, 4), floorStr(a.avgPriceT360, 2),
      a.totalReviews, a.customerRating, trunc(a.bestSellersRanking, 0), trunc(a.avgSellerVendorCountT360, 0),
    ]) + "\n";
  }
  return out;
}

export function searchTermsCsv(niche) {
  const rows = niche.searchTermMetrics || [];
  let out = preamble(niche.nicheTitle, "Search Terms Tab", niche.lastUpdatedTimeISO8601) + SEARCH_TERMS_HEADER + "\n";
  for (const t of rows) {
    const top = t.topClickedProducts || [];
    out += csvRow([
      t.searchTerm, trunc(t.searchVolumeT360, 0), floorStr(t.searchVolumeQoq, 4), floorStr(t.searchVolumeGrowthT180, 4),
      floorStr(t.clickShare, 4), floorStr(t.searchConversionRateT360, 4),
      top[0]?.asinTitle ?? "", top[0]?.asin ?? "", top[1]?.asinTitle ?? "", top[1]?.asin ?? "", top[2]?.asinTitle ?? "", top[2]?.asin ?? "",
    ]) + "\n";
  }
  return out;
}

export function criOutputs(niche) {
  const pdr = niche.nichePdr || {};
  const pos = pdr.positiveCustomerReviewInsights || [];
  const neg = pdr.negativeCustomerReviewInsights || [];
  const topics = pdr.pdrTopics || [];
  const json = {
    schemaVersion: "amazon-poe-downloader.cri.v1",
    nicheTitle: niche.nicheTitle,
    lastUpdated: pdr.lastUpdatedTimeISO8601 || niche.lastUpdatedTimeISO8601 || null,
    positive: pos.map((t) => ({ topic: t.topic, percentOfMentions: t.percentOfMentions, snippets: t.verbatims || [] })),
    negative: neg.map((t) => ({ topic: t.topic, percentOfMentions: t.percentOfMentions, snippets: t.verbatims || [] })),
    productStarRatingImpact: pdr.productStarRatingImpact || [],
    topics: topics.map((t) => ({
      name: t.name,
      positive: t.positiveReviewInsights ? { percentOfMentions: t.positiveReviewInsights.percentOfMentions, snippets: t.positiveReviewInsights.verbatims || [], trends: t.positiveReviewInsights.trends || [] } : null,
      negative: t.negativeReviewInsights ? { percentOfMentions: t.negativeReviewInsights.percentOfMentions, snippets: t.negativeReviewInsights.verbatims || [], trends: t.negativeReviewInsights.trends || [] } : null,
      starRatingImpact: t.starRatingImpact || null,
      subTopics: (t.subTopics || []).map((s) => ({
        name: s.name,
        positive: s.positiveReviewInsights ? { percentOfMentions: s.positiveReviewInsights.percentOfMentions, snippets: s.positiveReviewInsights.verbatims || [] } : null,
        negative: s.negativeReviewInsights ? { percentOfMentions: s.negativeReviewInsights.percentOfMentions, snippets: s.negativeReviewInsights.verbatims || [] } : null,
      })),
    })),
  };

  let csv = "﻿Topic,Subtopic,Sentiment,% Mentions,Review Snippets\n";
  for (const [list, sentiment] of [[pos, "positive"], [neg, "negative"]]) {
    for (const t of list) {
      csv += csvRow([t.topic, "", sentiment, t.percentOfMentions, (t.verbatims || []).join(" | ")]) + "\n";
    }
  }
  for (const t of topics) {
    for (const s of t.subTopics || []) {
      if (s.positiveReviewInsights?.percentOfMentions != null) {
        csv += csvRow([t.name, s.name, "positive", s.positiveReviewInsights.percentOfMentions, (s.positiveReviewInsights.verbatims || []).join(" | ")]) + "\n";
      }
      if (s.negativeReviewInsights?.percentOfMentions != null) {
        csv += csvRow([t.name, s.name, "negative", s.negativeReviewInsights.percentOfMentions, (s.negativeReviewInsights.verbatims || []).join(" | ")]) + "\n";
      }
    }
  }
  return { json, csv };
}

export function returnsOutputs(niche) {
  const topics = (niche.nichePdr || {}).pdrTopics || [];
  const withReturns = topics
    .filter((t) => t.returnsInsights && t.returnsInsights.percentOfMentions != null)
    .sort((a, b) => b.returnsInsights.percentOfMentions - a.returnsInsights.percentOfMentions);
  const notExposed = withReturns.length === 0;
  const json = {
    schemaVersion: "amazon-poe-downloader.returns.v1",
    nicheTitle: niche.nicheTitle,
    returnRateT360: (niche.nicheSummary || {}).returnRateT360 ?? null,
    notExposed,
    topics: withReturns.map((t) => ({
      topic: t.name,
      percentOfMentions: t.returnsInsights.percentOfMentions,
      trends: t.returnsInsights.trends || [],
    })),
  };
  let csv = "﻿Topic,% Mentions (returns, past 6 months)\n";
  if (notExposed) csv += csvRow(["(returns insights not exposed for this niche)", ""]) + "\n";
  for (const t of json.topics) csv += csvRow([t.topic, t.percentOfMentions]) + "\n";
  return { json, csv };
}

// account: optional { displayName, partnerAccountId, sessionMarketplaceId }
// supplied by the caller that verified which seller account the capture came
// from. sessionMarketplaceId is the session's selected marketplace; the data's
// marketplace is the overview's `marketplace`.
export function overviewJson(env, { account } = {}) {
  const niche = env.niche;
  const s = niche.nicheSummary || {};
  const cur = CUR_SYM[niche.currency] || niche.currency || "";
  // label-then-value with plain whitespace, using the label text of the native
  // Overview tab (no colon; one space separator), so a simple
  // "label\s+value" pattern reads each metric.
  const textLines = [
    `Search Volume (Past 360 days) ${withCommas(s.searchVolumeT360)}`,
    `Search volume growth (Past 180 days) ${pct(s.searchVolumeGrowthT180)}`,
    `No. of top clicked products ${(niche.asinMetrics || []).length || s.productCount || ""}`,
    `Average price (Past 360 days) ${cur}${truncFixed(s.avgPriceT360 ?? s.avgPrice, 2)}`,
    `Range of average units sold (Past 360 days) ${withCommas(s.minimumAverageUnitsSoldT360)} - ${withCommas(s.maximumAverageUnitsSoldT360)}`,
    `Return Rate (Past 360 days) ${pct(s.returnRateT360)}`,
    `Last updated on ${euDate(niche.lastUpdatedTimeISO8601)}`,
  ];
  return {
    schemaVersion: "amazon-poe-downloader.overview.v1",
    account: account || env.account || null,
    marketplace: env.marketplace,
    nicheId: env.nicheId,
    nicheTitle: niche.nicheTitle,
    capturedAt: env.capturedAt,
    currency: niche.currency,
    lastUpdated: niche.lastUpdatedTimeISO8601,
    summary: s,
    launchPotential: niche.launchPotential || null,
    textLines,
    // `text` is the same lines as one newline-joined string
    text: textLines.join("\n"),
  };
}

// ------------------------------------------------------------------ search

export function relatedNichesOutputs(env) {
  const niches = env.niches || [];
  const relatedNiches = niches.map((n) => {
    const s = n.nicheSummary || {};
    const cur = CUR_SYM[n.currency] || n.currency || "";
    const keywords = (n.topSearchTermMetrics || []).map((t) => t.searchTerm).join(", ");
    // 13-cell row in the column order of the Opportunity Explorer search
    // results grid; cell 1 is an empty placeholder column.
    const cells = [
      n.nicheTitle, "", keywords, String(s.productCount ?? ""),
      withCommas(s.searchVolumeT360), pct(s.searchVolumeGrowthT360),
      withCommas(s.searchVolumeT90), pct(s.searchVolumeGrowthT90),
      `${withCommas(s.minimumUnitsSoldT360)} - ${withCommas(s.maximumUnitsSoldT360)}`,
      `${withCommas(s.minimumUnitsSoldT90)} - ${withCommas(s.maximumUnitsSoldT90)}`,
      pct(s.returnRateT360), `${cur}${truncFixed(s.avgPrice ?? s.avgPriceT360, 2)}`,
      `${cur}${truncFixed(s.minimumPrice, 2)} - ${cur}${truncFixed(s.maximumPrice, 2)}`,
    ];
    return {
      niche: n.nicheTitle,
      href: `/opportunity-explorer/explore/niche/${n.nicheId}`,
      nicheId: n.nicheId,
      cells,
      summary: s,
      keywords: (n.topSearchTermMetrics || []).map((t) => t.searchTerm),
    };
  });
  const json = {
    schemaVersion: "amazon-poe-downloader.related-niches.v1",
    capturedAt: env.capturedAt,
    marketplace: env.marketplace,
    query: env.query,
    relatedNiches,
  };
  let csv = "﻿Niche,Keywords,Top Products,Search Volume (360d),SV Growth (360d),Search Volume (90d),SV Growth (90d),Units Sold (360d),Units Sold (90d),Return Rate,Avg Price,Price Range,Niche ID\n";
  for (const r of relatedNiches) {
    csv += csvRow([r.cells[0], r.cells[2], r.cells[3], r.cells[4], r.cells[5], r.cells[6], r.cells[7], r.cells[8], r.cells[9], r.cells[10], r.cells[11], r.cells[12], r.nicheId]) + "\n";
  }
  return { json, csv };
}

// ------------------------------------------------------------------ driver

// Returns [{ name, content }] in memory; nothing is written here.
export function formatEnvelope(env, { date, account } = {}) {
  if (!env || typeof env !== "object" || env.schemaVersion !== ENVELOPE_SCHEMA) {
    fail(`input is not an ${ENVELOPE_SCHEMA} envelope (schemaVersion=${env && env.schemaVersion})`, env && typeof env === "object" ? Object.keys(env) : undefined);
  }
  if (env.error) fail(`capture contains an error, refusing to format: ${env.error}`);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`--date must be YYYY-MM-DD (got ${JSON.stringify(date)})`);
  const cc = MP_CC[env.marketplace] || String(env.marketplace || "xx").toLowerCase();
  const d = date || (env.capturedAt || "").slice(0, 10) || "undated";
  const files = [];

  if (env.kind === "niche") {
    const niche = env.niche;
    if (!niche) fail("kind=niche but no .niche payload", Object.keys(env));
    for (const req of ["asinMetrics", "searchTermMetrics", "nicheSummary"]) {
      if (!niche[req]) fail(`niche payload missing required section '${req}'`, Object.keys(niche));
    }
    // A title with no Latin letters or digits (Japanese, for example) slugs to
    // "unknown"; the niche id keeps such files apart by name.
    let slug = slugify(niche.nicheTitle);
    const id = niche.nicheId || env.nicheId;
    if (slug === "unknown" && id) slug = `niche-${slugify(id)}`;
    const base = `${d}_${cc}-${slug}`;
    const cri = criOutputs(niche);
    const ret = returnsOutputs(niche);
    files.push(
      { name: `${base}_NicheDetailsProductsTab.csv`, content: productsCsv(niche) },
      { name: `${base}_NicheDetailsSearchTermsTab.csv`, content: searchTermsCsv(niche) },
      { name: `${d}_poe_${cc}-${slug}_customer-review-insights.json`, content: JSON.stringify(cri.json, null, 1) },
      { name: `${d}_poe_${cc}-${slug}_customer-review-insights.csv`, content: cri.csv },
      { name: `${d}_poe_${cc}-${slug}_returns.json`, content: JSON.stringify(ret.json, null, 1) },
      { name: `${d}_poe_${cc}-${slug}_returns.csv`, content: ret.csv },
      { name: `${d}_poe_${cc}-${slug}_overview.json`, content: JSON.stringify(overviewJson(env, { account }), null, 1) },
      { name: `${d}_poe_${cc}-${slug}_niche-full.json`, content: JSON.stringify(env, null, 1) },
    );
  } else if (env.kind === "search") {
    const rel = relatedNichesOutputs(env);
    const qslug = slugify(env.query);
    files.push(
      { name: `${d}_poe_${cc}_${qslug}_related-niches.json`, content: JSON.stringify(rel.json, null, 1) },
      { name: `${d}_poe_${cc}_${qslug}_related-niches.csv`, content: rel.csv },
    );
  } else if (env.kind === "merchant-niches" || env.kind === "context") {
    files.push({ name: `${d}_poe_${cc}_${env.kind}.json`, content: JSON.stringify(env, null, 1) });
  } else {
    fail(`unknown envelope kind '${env.kind}'`);
  }

  return files;
}

// ------------------------------------------------------------------ self-test

function selfTest() {
  const env = {
    schemaVersion: "amazon-poe-downloader.envelope.v1", kind: "niche", marketplace: "ATVPDKIKX0DER",
    capturedAt: "2026-01-15T12:00:00Z", nicheId: "abc123", url: "https://sellercentral.amazon.com/x",
    niche: {
      nicheTitle: "test niche", currency: "USD", lastUpdatedTimeISO8601: "2026-01-10T00:00:00Z",
      nicheSummary: {
        searchVolumeT360: 1234567, searchVolumeGrowthT180: 0.1234, avgPriceT360: 9.999,
        minimumAverageUnitsSoldT360: 40000, maximumAverageUnitsSoldT360: 50000, returnRateT360: 0.0005, productCount: 10,
      },
      asinMetrics: [{
        asin: "B000000001", asinTitle: 'A "quoted" product', brand: "Example Brand", category: "Cat/Sub",
        launchDate: "2020-01-01", clickCountT360: 1000.0, clickShareT360: 0.12345678, avgPriceT360: 12.349,
        totalReviews: "1000", customerRating: "4.5", bestSellersRanking: "100.5000", avgSellerVendorCountT360: 3.0,
      }],
      searchTermMetrics: [{
        searchTerm: "test term", searchVolumeT360: 1000000.0, searchVolumeQoq: 0.123456, searchVolumeGrowthT180: 0.234567,
        clickShare: 0.345678, searchConversionRateT360: 0.456789,
        topClickedProducts: [{ asin: "B0A", asinTitle: "T1" }, { asin: "B0B", asinTitle: "T2" }],
      }],
      trendsMetrics: [],
      nichePdr: {
        positiveCustomerReviewInsights: [{ topic: "Quality-Overall", percentOfMentions: 10.5, verbatims: ["good", "nice"] }],
        negativeCustomerReviewInsights: [{ topic: "Advertised Vs Actual", percentOfMentions: 2.5, verbatims: ["bad"] }],
        productStarRatingImpact: [],
        pdrTopics: [
          { name: "Example Topic", returnsInsights: { percentOfMentions: 3.4, trends: [] }, subTopics: [{ name: "Overall", positiveReviewInsights: { percentOfMentions: 1.1, verbatims: ["ok"] } }] },
          { name: "NoReturns", returnsInsights: null, subTopics: [] },
        ],
      },
    },
  };

  const assert = (cond, msg) => { if (!cond) { console.error("SELF-TEST FAIL:", msg); process.exit(1); } };

  // native-CSV number rule (verified against live UI exports)
  assert(floorStr(-0.07799, 4) === "-0.078", `floorStr negative: ${floorStr(-0.07799, 4)}`);
  assert(floorStr(0.0100004, 4) === "0.01", `floorStr trailing zeros: ${floorStr(0.0100004, 4)}`);
  assert(floorStr(0.067, 4) === "0.067", `floorStr float artifact: ${floorStr(0.067, 4)}`);
  assert(floorStr(0.123456, 4) === "0.1234", `floorStr positive: ${floorStr(0.123456, 4)}`);
  assert(floorStr(12.349, 2) === "12.34", `floorStr price: ${floorStr(12.349, 2)}`);

  const files = formatEnvelope(env, {});
  const byName = Object.fromEntries(files.map((f) => [f.name.replace(/^.*?_(?=NicheDetails|poe)|^\d{4}-\d{2}-\d{2}_/, ""), f]));
  const get = (frag) => files.find((f) => f.name.includes(frag));

  const prod = get("NicheDetailsProductsTab.csv").content;
  const prodLines = prod.split("\n");
  assert(prod.startsWith("﻿Niche Name: test niche"), "products preamble line 1");
  assert(prodLines[1] === "Niche Details - Products Tab", "products preamble line 2");
  assert(prodLines[2] === "Last updated on 10.1.2026", "products preamble date");
  assert(prodLines[3] === "", "products blank line 4");
  assert(prodLines[4] === PRODUCTS_HEADER("USD"), "products header");
  assert(prodLines[5] === '"A ""quoted"" product","B000000001","Example Brand","Cat/Sub","2020-01-01","1000","0.1234","12.34","1000","4.5","100","3"', `products row: ${prodLines[5]}`);

  const st = get("NicheDetailsSearchTermsTab.csv").content;
  const stLines = st.split("\n");
  assert(stLines[4] === SEARCH_TERMS_HEADER, "search terms header");
  assert(stLines[5] === '"test term","1000000","0.1234","0.2345","0.3456","0.4567","T1","B0A","T2","B0B","",""', `search terms row: ${stLines[5]}`);

  const cri = JSON.parse(get("customer-review-insights.json").content);
  assert(cri.positive.length === 1 && cri.negative.length === 1, "cri pos/neg counts");
  assert(cri.positive[0].snippets.length === 2, "cri snippets inline");
  const criCsv = get("customer-review-insights.csv").content;
  assert(criCsv.includes('"Quality-Overall","","positive","10.5","good | nice"'), "cri csv positive row");
  assert(criCsv.includes('"Advertised Vs Actual","","negative","2.5","bad"'), "cri csv negative row");
  assert(criCsv.includes('"Example Topic","Overall","positive","1.1","ok"'), "cri csv subtopic row");

  const ret = JSON.parse(get("returns.json").content);
  assert(ret.notExposed === false && ret.topics.length === 1 && ret.topics[0].topic === "Example Topic", "returns topics");
  const retNo = returnsOutputs({ nichePdr: { pdrTopics: [] }, nicheSummary: {} });
  assert(retNo.json.notExposed === true && retNo.csv.includes("not exposed"), "returns not-exposed");

  const ov = JSON.parse(get("overview.json").content);
  assert(ov.textLines[0] === "Search Volume (Past 360 days) 1,234,567", "overview SV line");
  assert(ov.textLines[1] === "Search volume growth (Past 180 days) 12.34%", "overview growth line");
  assert(ov.textLines[4] === "Range of average units sold (Past 360 days) 40,000 - 50,000", "overview units line");
  assert(ov.textLines[5] === "Return Rate (Past 360 days) 0.05%", "overview return rate line");

  const searchEnv = {
    schemaVersion: "amazon-poe-downloader.envelope.v1", kind: "search", marketplace: "ATVPDKIKX0DER",
    capturedAt: "2026-01-15T12:00:00Z", query: "example query",
    niches: [{
      nicheId: "n1", nicheTitle: "example niche", currency: "USD",
      nicheSummary: {
        searchVolumeT360: 1000000, searchVolumeGrowthT360: -0.1234, searchVolumeT90: 250000, searchVolumeGrowthT90: -0.05,
        minimumUnitsSoldT360: 100000, maximumUnitsSoldT360: 200000, minimumUnitsSoldT90: 10000, maximumUnitsSoldT90: 20000,
        returnRateT360: 0.001, avgPrice: 25.25, minimumPrice: 10, maximumPrice: 40, productCount: 20,
      },
      topSearchTermMetrics: [{ searchTerm: "example query" }, { searchTerm: "example" }],
    }],
  };
  const rel = JSON.parse(formatEnvelope(searchEnv, {}).find((f) => f.name.includes("related-niches.json")).content);
  assert(rel.schemaVersion === "amazon-poe-downloader.related-niches.v1", "related schema");
  assert(rel.relatedNiches[0].cells.length === 13, "related 13 cells");
  assert(rel.relatedNiches[0].cells[4] === "1,000,000" && rel.relatedNiches[0].cells[5] === "-12.34%", `related SV cells: ${rel.relatedNiches[0].cells}`);
  assert(rel.relatedNiches[0].cells[8] === "100,000 - 200,000", "related units cell");
  assert(rel.relatedNiches[0].cells[11] === "$25.25", `related avg price cell: ${rel.relatedNiches[0].cells}`);

  // error contract: an envelope that carries an error is refused
  let refused = false;
  try { formatEnvelope({ ...searchEnv, error: "example failure" }, {}); } catch (_) { refused = true; }
  assert(refused, "an envelope with an error must be refused");
  console.log("format-poe self-test: all assertions passed (products/search-terms/cri/returns/overview/related).");
}

// ------------------------------------------------------------------ main

const USAGE = "usage: format-poe.mjs --stdin [--out-dir DIR] [--label NAME] [--date YYYY-MM-DD] | --self-test";

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    // realpath so a symlinked bin entry still counts as a direct run
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

// Exit only once stdout has been written: process.exit() drops what a pipe
// has not taken yet (a receipt past 64 KiB).
function exitAfterWrite(text, code) {
  process.exitCode = code;
  if (text === null) process.exit(code);
  else process.stdout.write(text + "\n", () => process.exit(code));
}

if (isMainModule()) {
  let root = null;
  try {
    // Unknown, repeated or empty options are rejected (POE_ARGUMENT_INVALID).
    const { values, flags } = parseOptions(process.argv.slice(2),
      { values: ["out-dir", "label", "date"], flags: ["stdin", "self-test"] }, { context: "format-poe.mjs", hint: USAGE });
    const opt = (name) => values.get(name) ?? null;
    if (flags.has("self-test")) {
      if (flags.has("stdin") || values.size) throw Object.assign(new Error(`--self-test takes no other option. ${USAGE}`), { code: "POE_ARGUMENT_INVALID" });
      selfTest();
      process.exit(0);
    }
    if (!flags.has("stdin")) { console.error(USAGE); process.exit(1); }
    const env = JSON.parse(fs.readFileSync(0, "utf8"));
    const files = formatEnvelope(env, { date: opt("date") });
    ({ root } = prepareStore(resolveOutDir({ outDir: opt("out-dir"), label: opt("label") })));
    const receipt = publishFiles(files, { root });
    console.log(JSON.stringify({ schema_version: 1, complete: true, ...receipt }));
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error(error && error.code ? `${error.code}: ${message}` : message);
    // Files stored before a store failure are still listed, marked incomplete.
    const stored = Array.isArray(error && error.artifacts) ? error.artifacts : null;
    exitAfterWrite(stored && root ? JSON.stringify({ schema_version: 1, complete: false, status: "incomplete",
      output_folder: root, artifacts: stored }) : null, 1);
  }
}
