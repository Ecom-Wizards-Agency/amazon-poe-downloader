#!/usr/bin/env node
/*
 * POE endpoint discovery logger: records the Opportunity Explorer page's own
 * network traffic while you click through a niche, so the undocumented API
 * behind each POE tab can be documented.
 *
 * Attaches read-only to one Seller Central tab of a Chrome started with
 * --remote-debugging-port and streams same-origin JSON/CSV exchanges as NDJSON
 * records, one file per UI-tab label.
 *
 * SAFETY
 *   Observes traffic the page itself generates in your session. Apart from one
 *   read-only account identity check when it attaches (GetUserContext, plus a
 *   same-origin GET /home on pages without the anti-csrftoken-a2z meta tag),
 *   it sends no requests, never navigates, never logs in, and never reads
 *   cookies, local/session storage or tokens. Request headers are WHITELISTED
 *   (content-type, accept, x-amz-target); the CSRF header values are written
 *   as "[redacted]" and cookie/authorization headers are never written.
 *   Response bodies are kept only for JSON, CSV and GraphQL responses; any
 *   other type (HTML pages included) is recorded with its size and a null
 *   body. Request bodies, kept response bodies and URL query strings pass
 *   through lib/redact.mjs before they are written: the value of every key
 *   that names a CSRF value, token, session, customer id, cookie,
 *   authorization, password, secret or sign-in parameter becomes
 *   "[redacted]", at any depth, and so do sensitive meta and input tag values
 *   and unquoted script assignments. Bodies are redacted before the 4 KB cut.
 *   Key names match by substring, so a harmless key such as tokenCount or
 *   sessionCount is redacted too, and JSON stored inside a string value is
 *   written back compactly. The redaction errs on the side of removing data.
 *   Printed URLs show only origin and path. The tab is never closed: quitting
 *   only detaches.
 *
 *   Captures still contain account data (niche data, niche ids, request
 *   variables). Keep them out of version control and share only a sanitized
 *   summary.
 *
 * USAGE
 *   node tools/discover-poe-endpoints.mjs [--target <tab id>] [--out DIR]
 *     [--evidence DIR] [--expect-account NAME_OR_ID] [--all-hosts]
 *     [--port N] [--host H]
 *
 *   Without --target the single open Seller Central tab is used; with several
 *   open, their ids are listed and the tool exits. Only a tab on a known
 *   Seller Central https origin is accepted, with or without --target. An
 *   unknown, repeated or empty option stops the tool (POE_ARGUMENT_INVALID).
 *
 *   Interactive commands (stdin) while clicking through the UI:
 *     label <name>   tag subsequent records with this UI tab (e.g. label cri-positive)
 *     shot <name>    save a PNG screenshot of the attached tab to --evidence
 *     note <text>    append a free-text note record to the current label file
 *     tabs           re-list open Seller Central tabs
 *     quit           detach and exit (the tab stays open)
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Session, createCdpEndpoint } from "../lib/cdp.mjs";
import { readIdentity, accountMatches } from "../lib/sc-account.mjs";
import { REDACTED, displayUrl, redactText, redactUrl } from "../lib/redact.mjs";
import { ccForOrigin } from "../lib/marketplaces.mjs";
import { parseOptions } from "../lib/args.mjs";

const BODY_CAP = 4096; // characters of redacted response body kept per record

// A misspelled option (for example --expect-acount) must never silently turn
// off the account check, so unknown options stop the tool.
let options;
try {
  options = parseOptions(process.argv.slice(2),
    { values: ["target", "out", "evidence", "expect-account", "port", "host"], flags: ["all-hosts"] },
    { context: "discover-poe-endpoints.mjs", hint: "See the USAGE block at the top of the file." });
} catch (error) {
  console.error(`${error.code}: ${error.message}`);
  process.exit(1);
}
const arg = (name, dflt) => options.values.get(name) ?? dflt;
const flag = (name) => options.flags.has(name);

const OUT_DIR = path.resolve(arg("out", `poe-endpoint-capture-${new Date().toISOString().slice(0, 10)}`));
const EVIDENCE_DIR = path.resolve(arg("evidence", OUT_DIR));
const ALL_HOSTS = flag("all-hosts");

function endpoint() {
  const host = arg("host", null) || process.env.CDP_HOST || "127.0.0.1";
  const raw = String(arg("port", null) || process.env.CDP_PORT || 9222);
  const port = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error(`invalid Chrome debug port ${JSON.stringify(raw)}: use an integer from 1 to 65535`), { code: "CDP_PORT_INVALID" });
  }
  return createCdpEndpoint({ host, port });
}

// Only headers that document the API contract. Never cookie/authorization.
const HEADER_WHITELIST = new Set([
  "content-type", "accept", "anti-csrftoken-a2z", "x-amz-target", "x-api-csrf-token",
]);
// Whitelisted because their presence is part of the contract; their values are
// per-session anti-forgery tokens and are never written.
const REDACTED_HEADERS = new Set(["anti-csrftoken-a2z", "x-api-csrf-token"]);

function pickHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const name = k.toLowerCase();
    if (HEADER_WHITELIST.has(name)) out[name] = REDACTED_HEADERS.has(name) ? REDACTED : v;
  }
  return out;
}

function interesting(url, mimeType, resourceType) {
  if (!/sellercentral\.amazon\./.test(url) && !ALL_HOSTS) return false;
  if (/\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map)(\?|$)/.test(url)) return false;
  if (resourceType && !["XHR", "Fetch", "Document", "Other"].includes(resourceType)) return false;
  const mt = (mimeType || "").toLowerCase();
  return mt.includes("json") || mt.includes("csv") || mt.includes("graphql") ||
         mt.includes("text/plain") || mt === "" || resourceType === "XHR" || resourceType === "Fetch";
}

// Response bodies are stored only for these types; HTML and script bodies can
// embed session values in forms the key-based redaction cannot see.
function keepsBody(mimeType) {
  const mt = String(mimeType || "").toLowerCase();
  return mt.includes("json") || mt.includes("csv") || mt.includes("graphql");
}

// Only the known Seller Central https origins (lib/marketplaces.mjs), never a
// lookalike host: the identity check sends credentialed requests to the tab's
// own origin.
const isSellerCentral = (url) => ccForOrigin(String(url || "")) !== null;

function listTabs(pages) {
  for (const p of pages) console.error(`  ${p.id}  ${displayUrl(p.url).slice(0, 110)}`);
}

async function pickTab(cdp) {
  const pages = await cdp.listPages();
  const target = arg("target", null);
  if (target) {
    const tab = pages.find((p) => p.id === target);
    if (!tab) {
      console.error(`No tab with id ${target}. Open tabs:`);
      listTabs(pages);
      process.exit(1);
    }
    if (!isSellerCentral(tab.url)) {
      console.error(`Tab ${target} is not on a known Seller Central origin (${displayUrl(tab.url).slice(0, 110)}); refusing to attach.`);
      process.exit(1);
    }
    return tab;
  }
  const sc = pages.filter((p) => isSellerCentral(p.url));
  if (sc.length === 1) return sc[0];
  if (!sc.length) {
    console.error("No Seller Central tab found. Open Seller Central (ideally the Opportunity Explorer) in the debug Chrome and retry. Open tabs:");
    listTabs(pages);
  } else {
    console.error(`${sc.length} Seller Central tabs are open; pick one with --target <id>:`);
    listTabs(sc);
  }
  process.exit(1);
}

let session = null;

async function main() {
  const cdp = endpoint();
  await cdp.version();
  const tab = await pickTab(cdp);
  if (!tab.webSocketDebuggerUrl) throw new Error(`tab ${tab.id} has no webSocketDebuggerUrl (is DevTools already attached to it?)`);
  session = await Session.open(tab.webSocketDebuggerUrl);
  console.error(`Attached read-only to ${tab.id} ${displayUrl(tab.url).slice(0, 100)}`);

  const identity = (await readIdentity(session, { timeoutMs: 30000 })) || {};
  console.error(`Account: ${identity.displayName || identity.partnerAccountId || "(unresolved)"}`
    + `${identity.partnerAccountId ? ` [partnerAccountId=${identity.partnerAccountId}]` : ""}`
    + `${identity.marketplace ? ` marketplace=${identity.marketplace}` : ""}${identity.err ? ` (${identity.err})` : ""}`);
  const expectAccount = arg("expect-account", null);
  if (expectAccount && !accountMatches(identity, expectAccount)) {
    throw new Error(`ACCOUNT MISMATCH: expected "${expectAccount}" but the tab shows "${identity.displayName || identity.partnerAccountId || "unknown"}"`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  console.error(`WARNING: captures in ${OUT_DIR} contain account data. Do not commit or share them; document the endpoints from a sanitized summary.`);

  await session.send("Network.enable", { maxTotalBufferSize: 100 * 1024 * 1024, maxResourceBufferSize: 20 * 1024 * 1024 });
  await session.send("Page.enable");

  let label = "unlabeled";
  const reqs = new Map(); // requestId -> partial record
  const streams = new Map(); // label -> write stream

  let closing = false; // set on quit; late network records are dropped
  function out(rec) {
    if (closing) return;
    if (!streams.has(rec.label)) {
      streams.set(rec.label, fs.createWriteStream(path.join(OUT_DIR, `${rec.label}.ndjson`), { flags: "a" }));
    }
    streams.get(rec.label).write(JSON.stringify(rec) + "\n");
  }

  session.subscribe("Network.requestWillBeSent", (p) => {
    const r = p.request || {};
    if (!/sellercentral\.amazon\./.test(r.url) && !ALL_HOSTS) return;
    reqs.set(p.requestId, {
      ts: new Date().toISOString(), label,
      method: r.method, url: redactUrl(r.url),
      resourceType: p.type || "",
      requestHeaders: pickHeaders(r.headers),
      postData: r.postData ? redactText(r.postData) : null,
      hasPostData: !!r.hasPostData,
    });
  });

  session.subscribe("Network.responseReceived", (p) => {
    const rec = reqs.get(p.requestId);
    if (!rec) return;
    rec.status = p.response?.status;
    rec.mimeType = p.response?.mimeType || "";
    rec.responseHeaders = pickHeaders(p.response?.headers || {});
  });

  session.subscribe("Network.loadingFinished", async (p) => {
    const rec = reqs.get(p.requestId);
    reqs.delete(p.requestId);
    if (!rec) return;
    rec.mimeType = rec.mimeType || ""; // responseReceived may never have arrived
    if (!interesting(rec.url, rec.mimeType, rec.resourceType)) return;
    if (rec.hasPostData && !rec.postData) {
      try { rec.postData = redactText((await session.send("Network.getRequestPostData", { requestId: p.requestId })).postData); }
      catch (_) { /* body evicted; keep the record anyway */ }
    }
    try {
      const b = await session.send("Network.getResponseBody", { requestId: p.requestId });
      const text = b.base64Encoded ? Buffer.from(b.body, "base64").toString("utf8") : b.body;
      rec.responseBodyBytes = Buffer.byteLength(text);
      rec.responseBodyFirst4KB = keepsBody(rec.mimeType) ? redactText(text).slice(0, BODY_CAP) : null;
    } catch (_) {
      rec.responseBodyBytes = null;
      rec.responseBodyFirst4KB = null; // body evicted or non-retrievable (e.g. download)
    }
    if (closing) return;
    try {
      out(rec);
      console.log(`  [${rec.label}] ${rec.method} ${rec.status} ${rec.mimeType.padEnd(24).slice(0, 24)} ${displayUrl(rec.url).slice(0, 100)}`);
    } catch (e) { console.error("capture write failed:", e.message); }
  });

  // Downloads (native CSV export button) surface here even when no fetch is visible.
  session.subscribe("Page.downloadWillBegin", (p) => {
    out({ ts: new Date().toISOString(), label, event: "downloadWillBegin", url: redactUrl(p.url), suggestedFilename: p.suggestedFilename });
    console.log(`  [${label}] DOWNLOAD ${p.suggestedFilename || ""} ${displayUrl(p.url).slice(0, 100)}`);
  });

  console.log(`\nLogging same-origin JSON/CSV traffic to ${OUT_DIR}/<label>.ndjson`);
  console.log(`Commands: label <name> | shot <name> | note <text> | tabs | quit\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "poe> " });
  rl.prompt();
  // Commands run one at a time, in order, so "quit" never overtakes a
  // screenshot or note that is still being written.
  let queue = Promise.resolve();
  async function handle(line) {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const restStr = rest.join(" ");
    try {
      if (cmd === "quit" || cmd === "q") { rl.close(); return; }
      else if (cmd === "label" && restStr) { label = restStr.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"); console.log(`label = ${label}`); }
      else if (cmd === "shot" && restStr) {
        if (!/^[a-zA-Z0-9_-]+$/.test(restStr)) throw new Error("shot name must use letters, digits, '_' or '-'");
        const shot = await session.send("Page.captureScreenshot", { format: "png" });
        const file = path.join(EVIDENCE_DIR, `${new Date().toISOString().slice(0, 10)}_poe_${restStr}.png`);
        fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
        console.log(`saved ${file}`);
      }
      else if (cmd === "note" && restStr) { out({ ts: new Date().toISOString(), label, event: "note", text: restStr }); console.log("noted"); }
      else if (cmd === "tabs") { (await cdp.listPages()).filter((p) => isSellerCentral(p.url)).forEach((p) => console.log(`  ${p.id}  ${displayUrl(p.url).slice(0, 110)}`)); }
      else if (cmd) console.log("commands: label <name> | shot <name> | note <text> | tabs | quit");
    } catch (e) { console.error("command failed:", e.message); }
    rl.prompt();
  }
  rl.on("line", (line) => { queue = queue.then(() => handle(line)); });
  rl.on("close", async () => {
    await queue;
    closing = true;
    await Promise.all([...streams.values()].map((s) => new Promise((resolve) => s.end(resolve))));
    session.close(); // detach only; the tab stays open
    console.log(`\nDone. Captures in ${OUT_DIR}`);
    process.exit(0);
  });
}

main().catch((e) => {
  if (session) session.close();
  console.error(e.code ? `${e.code}: ${e.message}` : e.message);
  process.exit(1);
});
