// End-to-end account and context gates of run-poe.mjs against a scripted fake
// Chrome (test/helpers/fake-cdp.mjs). The runner is spawned as a real child
// process; only the browser is fake.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startFakeCdp } from "./helpers/fake-cdp.mjs";

const RUN = fileURLToPath(new URL("../run-poe.mjs", import.meta.url));
const MARKETPLACE = "ATVPDKIKX0DER";
const TARGET = "POE_TAB";

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "poe-context-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The run lock lives in os.tmpdir() of the child, so point it into the root.
  const lockDir = join(root, "tmp");
  mkdirSync(lockDir);
  return { root, lockDir, outDir: join(root, "out") };
}

function runCli(args, { cwd, lockDir, timeout = 15000 }) {
  const env = { ...process.env, TMPDIR: lockDir, TEMP: lockDir, TMP: lockDir };
  for (const key of ["CDP_PORT", "CDP_HOST", "CDP_DEBUG", "POE_OUT_DIR"]) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUN, ...args], { cwd, timeout, env });
    let output = "";
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { output += chunk; stdout += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, output, stdout, stderr }));
  });
}

const listFiles = (dir) => (existsSync(dir) ? readdirSync(dir) : []);

async function scenario(t, drift, { marketplace = "us", origin = "https://sellercentral.amazon.com",
  requestedId = MARKETPLACE, identityMarketplace = MARKETPLACE,
  accountName = null, expectedPartnerId = null, initialDisplayName = "Example Seller",
  initialPartnerId = "PARTNER_A", switchDisplayName = "Example Seller",
  switchMarketplace = identityMarketplace, expectedFetches = null,
  reportedId = requestedId, fetchError = null, prepareOut = null, extraArgs = [], expectAccount = "PARTNER_A" } = {}) {
  const { root, lockDir, outDir } = tempRoot(t);
  if (prepareOut) prepareOut(outDir);
  const identity = { displayName: initialDisplayName, merchantId: "SELLER_A",
    partnerAccountId: initialPartnerId, marketplace: identityMarketplace, err: null };
  const envelope = { schemaVersion: "amazon-poe-downloader.envelope.v1", kind: "search", marketplace: requestedId,
    capturedAt: "2026-09-09T00:00:00Z", query: "test query",
    niches: [{ nicheTitle: "Verified fixture niche", nicheId: "NICHE1", obfuscatedMarketplaceId: reportedId, nicheSummary: {} }],
    ...(fetchError ? { error: fetchError } : {}) };
  let switchClicks = 0;
  let actualOrigin = origin;
  let fetches = 0;
  let identityReads = 0;
  let identityReadsAfterFetch = 0;
  const settleBudgets = [];
  const fake = await startFakeCdp({ targets: [], onCreateTarget: ({ url }) => ({
    id: TARGET, url, behavior: { results: {
      "Input.dispatchMouseEvent": ({ type }) => {
        if (type === "mouseReleased") {
          switchClicks++;
          identity.displayName = switchDisplayName;
          identity.partnerAccountId = "PARTNER_A";
          identity.marketplace = switchMarketplace;
        }
        return {};
      },
      "Runtime.evaluate": ({ expression = "" }) => {
        if (expression.includes("return await fetchPoeSearch(")) {
          fetches++;
          if (drift === "origin") actualOrigin = "https://sellercentral.amazon.de";
          if (drift === "missing-origin") actualOrigin = null;
          if (drift === "account") identity.merchantId = "SELLER_B";
          if (drift === "partner") identity.partnerAccountId = "PARTNER_B";
          // The account header renders its text differently after the fetch.
          if (drift === "display-name") identity.displayName = "Example Seller / United States";
          if (drift === "marketplace") identity.marketplace = "A1PA6795UKMFR9";
          return { result: { value: envelope } };
        }
        if (accountName && expression.includes("getBoundingClientRect")) {
          return { result: { value: { x: 20, y: 20, count: 1, current: false } } };
        }
        if (accountName && !expression.includes("chooserButtonCount")
            && (expression.includes("full-page-account-switcher-account-details") || expression.includes("!location.pathname"))) {
          return { result: { value: true } };
        }
        if (expression === "location.href") return { result: { value: actualOrigin === null ? null : actualOrigin + "/opportunity-explorer" } };
        if (expression.includes("GetUserContext")) {
          identityReads++;
          settleBudgets.push(Number((/var settleMs = (\d+);/.exec(expression) || [])[1]));
          if (drift === "baseline" && identityReads === 2) identity.partnerAccountId = "PARTNER_B";
          if (fetches) identityReadsAfterFetch++;
          return { result: { value: { ...identity } } };
        }
        if (expression.includes("readyState")) return { result: { value: true } };
        if (expression.includes("chooserButtonCount")) return { result: { value: {
          url: origin + "/opportunity-explorer", csrfMeta: true,
          chooserButtonCount: 0, title: "Opportunity Explorer",
        } } };
        return { result: { value: null } };
      },
    } },
  }) });
  t.after(() => fake.close());
  const result = await runCli(["search", "--query", "test query",
    "--marketplace", marketplace, "--origin", origin, ...(expectAccount ? ["--expect-account", expectAccount] : []),
    "--port", String(fake.port), "--host", "127.0.0.1", "--out-dir", outDir, "--verbose",
    ...(accountName ? ["--account-name", accountName, "--marketplace-label", "United States"] : []),
    ...(expectedPartnerId ? ["--expected-partner-account-id", expectedPartnerId] : []), ...extraArgs], { cwd: root, lockDir });
  assert.equal(result.signal, null, `CLI must finish within its budget: ${result.output}`);
  assert.equal(fetches, expectedFetches ?? (drift === "baseline" || switchDisplayName === "Wrong Seller" ? 0 : 1), result.output);
  return { ...result, outDir, files: listFiles(outDir), identityReadsAfterFetch, switchClicks, settleBudgets,
    tabClosed: fake.closed.includes(TARGET), created: fake.sent.some((c) => c.method === "Target.createTarget") };
}

function assertStored(result) {
  assert.equal(result.code, 0, result.output);
  assert.equal(result.files.length, 3, "formatted JSON, CSV and verbose envelope are stored");
  const receipt = JSON.parse(result.stdout.trim().split("\n").pop());
  assert.equal(receipt.status, "stored_verified");
  assert.equal(receipt.complete, true);
  assert.deepEqual(Object.keys(receipt).sort(), ["artifacts", "captures", "complete", "output_folder", "schema_version", "status"]);
  assert.equal(receipt.output_folder, result.outDir);
  assert.equal(receipt.artifacts.length, 3);
  for (const artifact of receipt.artifacts) {
    const bytes = readFileSync(join(result.outDir, artifact.stored_name));
    assert.equal(createHash("sha1").update(bytes).digest("hex"), artifact.sha1, artifact.name);
  }
  assert.ok(result.files.some((name) => readFileSync(join(result.outDir, name), "utf8").includes("NICHE1")));
  assert.equal(result.tabClosed, true, "a successful run closes its own tab");
  return receipt;
}

function assertRejected(result, pattern = /POE_CONTEXT_CHANGED/) {
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, pattern);
  assert.equal(result.files.length, 0, "no rejected response is formatted or stored");
  assert.equal(result.tabClosed, false, "a rejected run keeps its tab for inspection");
  assert.match(result.stderr, new RegExp(`Kept tab ${TARGET} `));
}

test("POE accepts a response only while account, marketplace and origin remain stable", async (t) => {
  const result = await scenario(t, null);
  assertStored(result);
  assert.equal(result.identityReadsAfterFetch, 1, "identity is rechecked after the fetch");
});

for (const drift of ["account", "marketplace"]) {
  test(`POE rejects ${drift} drift during fetch before storing any response`, async (t) => {
    const result = await scenario(t, drift);
    assertRejected(result);
    assert.equal(result.identityReadsAfterFetch, 1);
  });
}

test("a display name that renders differently after the fetch is accepted while the ids match", async (t) => {
  const result = await scenario(t, "display-name");
  assertStored(result);
  assert.equal(result.identityReadsAfterFetch, 1);
  // Preflight and baseline wait for the account header; the rechecks do not.
  assert.deepEqual(result.settleBudgets, [10000, 10000, 0, 0, 0]);
});

test("a partnerAccountId that changes during the fetch is rejected even when merchantId matches", async (t) => {
  const result = await scenario(t, "partner");
  assertRejected(result, /POE_CONTEXT_CHANGED: partnerAccountId changed/);
});

test("POE revalidates the requested account when establishing its baseline", async (t) => {
  const result = await scenario(t, "baseline");
  assertRejected(result, /POE_CONTEXT_(?:CHANGED|UNVERIFIED)|ACCOUNT MISMATCH/);
});

test("POE reads France through a Germany session in the same region", async (t) => {
  const result = await scenario(t, null, { marketplace: "fr", origin: "https://sellercentral.amazon.de",
    requestedId: "A13V1IB3VIYZZH", identityMarketplace: "A1PA6795UKMFR9" });
  assertStored(result);
});

test("POE rejects a response that reports another marketplace than the one requested", async (t) => {
  const result = await scenario(t, null, { reportedId: "A1PA6795UKMFR9" });
  assertRejected(result, /POE_MARKETPLACE_MISMATCH: the search response reports marketplace A1PA6795UKMFR9, requested ATVPDKIKX0DER/);
});

test("POE rejects a response row that reports no marketplace", async (t) => {
  const result = await scenario(t, null, { reportedId: null });
  assertRejected(result, /POE_MARKETPLACE_MISMATCH: the search response reports marketplace \(none\)/);
});

test("a failed fetch keeps the run's tab and stores nothing", async (t) => {
  const result = await scenario(t, null, { fetchError: "not authorized (403): session logged out or wrong account/marketplace" });
  assertRejected(result, /POE_FETCH_FAILED: POE fetch failed: not authorized \(403\)/);
});

test("a store failure partway through a file set lists the files already stored", async (t) => {
  const blocked = "2026-09-09_poe_us_test-query_related-niches.csv";
  const result = await scenario(t, null, { prepareOut: (outDir) => mkdirSync(join(outDir, blocked), { recursive: true }) });
  assert.equal(result.code, 1, result.output);
  const receipt = JSON.parse(result.stdout.trim().split("\n").pop());
  assert.equal(receipt.status, "incomplete");
  assert.equal(receipt.complete, false);
  assert.deepEqual(receipt.artifacts.map((a) => a.stored_name), ["2026-09-09_poe_us_test-query_related-niches.json"]);
  for (const artifact of receipt.artifacts) {
    assert.equal(createHash("sha1").update(readFileSync(join(result.outDir, artifact.stored_name))).digest("hex"), artifact.sha1);
  }
  assert.equal(result.tabClosed, false, "a failed run keeps its tab");
});

test("a batch with a failed niche keeps its tab and prints an incomplete receipt", async (t) => {
  const { root, lockDir, outDir } = tempRoot(t);
  const identity = { displayName: "Example Seller", merchantId: "SELLER_A", partnerAccountId: "PARTNER_A",
    marketplace: MARKETPLACE, err: null };
  const fake = await startFakeCdp({ targets: [], onCreateTarget: ({ url }) => ({ id: TARGET, url, behavior: { results: {
    "Runtime.evaluate": ({ expression = "" }) => {
      if (expression.includes("return await fetchPoeSearch(")) {
        return { result: { value: { schemaVersion: "amazon-poe-downloader.envelope.v1", kind: "search",
          marketplace: MARKETPLACE, capturedAt: "2026-09-09T00:00:00Z", query: "test query",
          niches: [{ nicheTitle: "Fixture niche", nicheId: "NICHE1", obfuscatedMarketplaceId: MARKETPLACE, nicheSummary: {} }] } } };
      }
      if (expression.includes("return await fetchPoeNiche(")) {
        return { result: { value: { schemaVersion: "amazon-poe-downloader.envelope.v1", kind: "niche",
          marketplace: MARKETPLACE, capturedAt: "2026-09-09T00:00:00Z", nicheId: "NICHE1", niche: null,
          error: "getNiche returned no niche (wrong nicheId or marketplace?)" } } };
      }
      if (expression === "location.href") return { result: { value: "https://sellercentral.amazon.com/opportunity-explorer" } };
      if (expression.includes("GetUserContext")) return { result: { value: { ...identity } } };
      if (expression.includes("readyState")) return { result: { value: true } };
      return { result: { value: null } };
    },
  } } }) });
  t.after(() => fake.close());
  const result = await runCli(["batch", "--queries", "test query", "--top", "1", "--marketplace", "us",
    "--expect-account", "PARTNER_A", "--port", String(fake.port), "--host", "127.0.0.1",
    "--out-dir", outDir], { cwd: root, lockDir, timeout: 30000 });
  assert.equal(result.code, 1, result.output);
  const receipt = JSON.parse(result.stdout.trim().split("\n").pop());
  assert.equal(receipt.status, "incomplete");
  assert.equal(receipt.complete, false);
  assert.equal(receipt.failed.length, 1);
  assert.equal(receipt.failed[0].id, "NICHE1");
  assert.equal(listFiles(outDir).length, 2, "the related-niches pair of the search is kept");
  assert.equal(fake.closed.includes(TARGET), false, "a batch with failed niches keeps its tab");
  assert.match(result.stderr, new RegExp(`Kept tab ${TARGET} `));
});

test("a signed-out tab is reported without the sign-in query string", async (t) => {
  const { root, lockDir, outDir } = tempRoot(t);
  const signIn = "https://sellercentral.amazon.com/ap/signin?openid.return_to=x&ssoResponse=FAKE-SSO-VALUE";
  let tab = null;
  const fake = await startFakeCdp({ targets: [], onCreateTarget: ({ url }) => {
    tab = { id: TARGET, url, behavior: { results: {
      "Runtime.evaluate": ({ expression = "" }) => {
        if (expression === "location.href") return { result: { value: signIn } };
        if (expression.includes("GetUserContext")) {
          tab.url = signIn;
          return { result: { value: { displayName: null, merchantId: null, partnerAccountId: null,
            marketplace: null, err: "not signed in" } } };
        }
        if (expression.includes("readyState")) return { result: { value: true } };
        return { result: { value: null } };
      },
    } } };
    return tab;
  } });
  t.after(() => fake.close());
  const result = await runCli(["search", "--query", "test query", "--marketplace", "us",
    "--expect-account", "PARTNER_A", "--port", String(fake.port), "--host", "127.0.0.1",
    "--out-dir", outDir], { cwd: root, lockDir });
  assert.equal(result.code, 1, result.output);
  assert.match(result.stderr, /POE_ACCOUNT_CHECK_FAILED/);
  assert.match(result.stderr, new RegExp(`Kept tab ${TARGET} \\(https://sellercentral\\.amazon\\.com/ap/signin\\)`));
  assert.doesNotMatch(result.output, /openid|ssoResponse|FAKE-SSO/);
  assert.equal(listFiles(outDir).length, 0);
});

test("POE rejects an unannounced cross-region redirect before storing a response", async (t) => {
  const result = await scenario(t, "origin");
  assertRejected(result, /POE_CONTEXT_CHANGED: origin changed/);
});

test("POE protects a fetched response when its current origin cannot be observed", async (t) => {
  const result = await scenario(t, "missing-origin");
  assertRejected(result, /POE_CONTEXT_CHANGED: origin changed or became unavailable \(none\)/);
});

test("structured POE name forces an exact selection when a similar seller is active", async (t) => {
  const result = await scenario(t, null, { accountName: "Example Seller", initialDisplayName: "Example Seller Plus" });
  assertStored(result);
  assert.ok(result.switchClicks >= 2, "a similar display name cannot bypass the account picker");
});

test("structured POE expected partner ID requires equality before skipping selection", async (t) => {
  const result = await scenario(t, null, { accountName: "Example Seller", expectedPartnerId: "PARTNER_A",
    initialPartnerId: "PARTNER_A_MORE" });
  assertStored(result);
  assert.ok(result.switchClicks >= 2, "a prefix match is not verified identity");
});

test("structured POE rejects a different observed seller after picker completion", async (t) => {
  const result = await scenario(t, null, { accountName: "Example Seller", initialDisplayName: "Example Seller Plus",
    switchDisplayName: "Wrong Seller" });
  assertRejected(result, /POST-SWITCH ACCOUNT CHECK FAILED/);
});

test("a header name with the marketplace suffix verifies without an account switch when marketplaceSelection is missing", async (t) => {
  const result = await scenario(t, null, { accountName: "Example Brand", initialDisplayName: "Example Brand United States",
    identityMarketplace: null });
  assertStored(result);
  assert.equal(result.switchClicks, 0);
});

test("structured POE recovers the requested marketplace before the first fetch", async (t) => {
  const result = await scenario(t, null, { accountName: "Example Brand", initialDisplayName: "Example Brand Canada",
    identityMarketplace: "A2EUQ1WTGCTBG2", switchDisplayName: "Example Brand United States", switchMarketplace: MARKETPLACE });
  assertStored(result);
  assert.ok(result.switchClicks >= 2);
});

test("a wrong marketplace after picker completion blocks POE and storage", async (t) => {
  const result = await scenario(t, null, { accountName: "Example Brand", initialDisplayName: "Example Brand United States",
    identityMarketplace: "A2EUQ1WTGCTBG2", switchDisplayName: "Example Brand United States", expectedFetches: 0 });
  assertRejected(result, /POST-SWITCH ACCOUNT CHECK FAILED/);
});

test("a marketplace from another region than --origin fails before any CDP command", async (t) => {
  const { root, lockDir, outDir } = tempRoot(t);
  const fake = await startFakeCdp({ targets: [] });
  t.after(() => fake.close());
  const result = await runCli(["search", "--query", "test query", "--marketplace", "fr",
    "--origin", "https://sellercentral.amazon.com", "--port", String(fake.port), "--host", "127.0.0.1",
    "--out-dir", outDir], { cwd: root, lockDir });
  assert.equal(result.code, 1, result.output);
  assert.match(result.stderr, /ORIGIN_MARKETPLACE_REGION_MISMATCH/);
  assert.equal(fake.sent.length, 0);
  assert.equal(listFiles(outDir).length, 0);
});

test("a run lock held by a live process stops the run before any CDP command", async (t) => {
  const { root, lockDir, outDir } = tempRoot(t);
  const fake = await startFakeCdp({ targets: [] });
  t.after(() => fake.close());
  writeFileSync(join(lockDir, `amazon-poe-downloader-loopback-${fake.port}.lock`),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), argv: [] }));
  const result = await runCli(["search", "--query", "test query", "--marketplace", "us",
    "--port", String(fake.port), "--host", "127.0.0.1", "--out-dir", outDir], { cwd: root, lockDir });
  assert.equal(result.code, 1, result.output);
  assert.match(result.stderr, /POE_RUN_IN_PROGRESS/);
  assert.equal(fake.sent.length, 0);
  assert.equal(listFiles(outDir).length, 0);
});

test("an unreachable debug port exits 1 with the Chrome launch hint", async (t) => {
  const { root, lockDir, outDir } = tempRoot(t);
  const port = await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port: free } = server.address();
      server.close(() => resolve(free));
    });
  });
  const result = await runCli(["search", "--query", "test query", "--marketplace", "us",
    "--port", String(port), "--host", "127.0.0.1", "--out-dir", outDir], { cwd: root, lockDir });
  assert.equal(result.code, 1, result.output);
  assert.match(result.stderr, /CDP_UNREACHABLE/);
  assert.match(result.stderr, /--remote-debugging-port=/);
  assert.equal(listFiles(outDir).length, 0);
});

test("Ctrl+C during a run reports the kept tab, exits 130 and releases the lock", { skip: process.platform === "win32" }, async (t) => {
  const { root, lockDir, outDir } = tempRoot(t);
  // The created tab never becomes ready, so the run is still waiting when interrupted.
  const fake = await startFakeCdp({ targets: [] });
  t.after(() => fake.close());
  const env = { ...process.env, TMPDIR: lockDir, TEMP: lockDir, TMP: lockDir };
  for (const key of ["CDP_PORT", "CDP_HOST", "CDP_DEBUG", "POE_OUT_DIR"]) delete env[key];
  const child = spawn(process.execPath, [RUN, "search", "--query", "test query", "--marketplace", "us",
    "--port", String(fake.port), "--host", "127.0.0.1", "--out-dir", outDir], { cwd: root, env, timeout: 15000 });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lockFile = join(lockDir, `amazon-poe-downloader-loopback-${fake.port}.lock`);
  const deadline = Date.now() + 10000;
  while (!(existsSync(lockFile) && /Target\.createTarget/.test(JSON.stringify(fake.sent))) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  child.kill("SIGINT");
  const code = await new Promise((resolve) => child.on("close", (exitCode) => resolve(exitCode)));
  assert.equal(code, 130, stderr);
  assert.match(stderr, /Interrupted by SIGINT\. Kept tab \S+ for inspection\./);
  assert.equal(existsSync(lockFile), false);
  assert.equal(listFiles(outDir).length, 0);
});

test("the --name=value form of an account option is checked like the spaced form", async (t) => {
  const result = await scenario(t, null, { extraArgs: ["--expected-partner-account-id=OTHER_ACCOUNT"], expectedFetches: 0 });
  assertRejected(result, /ACCOUNT MISMATCH: --expected-partner-account-id expects "OTHER_ACCOUNT"/);
  assert.match(result.stderr, /POE_ACCOUNT_CHECK_FAILED/);
});

test("--expect-account is checked even when --expected-partner-account-id matches", async (t) => {
  const result = await scenario(t, null, { expectedPartnerId: "PARTNER_A", expectAccount: "Other Seller",
    expectedFetches: 0 });
  assertRejected(result, /ACCOUNT MISMATCH: --expect-account expects "Other Seller"/);
});

for (const [name, args, pattern] of [
  ["a misspelled account option", ["--expected-partner-acount-id", "OTHER_ACCOUNT"], /unknown option --expected-partner-acount-id for search/],
  ["an option of another command", ["--niche-id", "NICHE1"], /unknown option --niche-id for search/],
  ["a stray argument", ["extra"], /unexpected argument "extra" for search/],
  ["a repeated option", ["--marketplace", "de"], /--marketplace is given more than once/],
  ["an empty account option", ["--account-name="], /--account-name needs a value/],
  ["a value for a flag", ["--verbose=yes"], /--verbose takes no value/],
]) {
  test(`${name} stops the run before the output folder, the lock or Chrome`, async (t) => {
    const { root, lockDir, outDir } = tempRoot(t);
    const fake = await startFakeCdp({ targets: [] });
    t.after(() => fake.close());
    const result = await runCli(["search", "--query", "test query", "--marketplace", "us",
      "--port", String(fake.port), "--host", "127.0.0.1", "--out-dir", outDir, ...args], { cwd: root, lockDir });
    assert.equal(result.code, 1, result.output);
    assert.match(result.stderr, /POE_ARGUMENT_INVALID/);
    assert.match(result.stderr, pattern);
    assert.equal(fake.sent.length, 0, "no CDP command, in particular no Target.createTarget");
    assert.equal(existsSync(outDir), false);
    assert.deepEqual(listFiles(lockDir), []);
    assert.equal(result.stdout, "");
  });
}

function batchFake(t, { nicheResult }) {
  const identity = { displayName: "Example Seller", merchantId: "SELLER_A", partnerAccountId: "PARTNER_A",
    marketplace: MARKETPLACE, err: null };
  const nicheCalls = [];
  return startFakeCdp({ targets: [], onCreateTarget: ({ url }) => ({ id: TARGET, url, behavior: { results: {
    "Runtime.evaluate": ({ expression = "" }) => {
      if (expression.includes("return await fetchPoeSearch(")) {
        return { result: { value: { schemaVersion: "amazon-poe-downloader.envelope.v1", kind: "search",
          marketplace: MARKETPLACE, capturedAt: "2026-09-09T00:00:00Z", query: "test query",
          niches: ["NICHE1", "NICHE2", "NICHE3"].map((nicheId) => ({ nicheTitle: `Fixture ${nicheId}`, nicheId,
            obfuscatedMarketplaceId: MARKETPLACE, nicheSummary: {} })) } } };
      }
      const niche = /return await fetchPoeNiche\((\{.*?\})\)/.exec(expression);
      if (niche) {
        const { nicheId } = JSON.parse(niche[1]);
        nicheCalls.push(nicheId);
        return { result: { value: nicheResult(nicheId) } };
      }
      if (expression === "location.href") return { result: { value: "https://sellercentral.amazon.com/opportunity-explorer" } };
      if (expression.includes("GetUserContext")) return { result: { value: { ...identity } } };
      if (expression.includes("readyState")) return { result: { value: true } };
      return { result: { value: null } };
    },
  } } }) }).then((fake) => { t.after(() => fake.close()); return { fake, nicheCalls }; });
}

test("a rejected niche response stops the batch and the receipt lists failed and pending niches", async (t) => {
  const { root, lockDir, outDir } = tempRoot(t);
  const { fake, nicheCalls } = await batchFake(t, { nicheResult: (nicheId) => ({
    schemaVersion: "amazon-poe-downloader.envelope.v1", kind: "niche", marketplace: MARKETPLACE,
    capturedAt: "2026-09-09T00:00:00Z", nicheId, niche: { nicheId, nicheTitle: `Fixture ${nicheId}`,
      obfuscatedMarketplaceId: "A1PA6795UKMFR9" } }) });
  const result = await runCli(["batch", "--niche-ids", "NICHE7,NICHE8", "--marketplace", "us",
    "--expect-account", "PARTNER_A", "--port", String(fake.port), "--host", "127.0.0.1",
    "--out-dir", outDir], { cwd: root, lockDir, timeout: 30000 });
  assert.equal(result.code, 1, result.output);
  assert.match(result.stderr, /POE_MARKETPLACE_MISMATCH/);
  assert.deepEqual(nicheCalls, ["NICHE7"]);
  const receipt = JSON.parse(result.stdout.trim().split("\n").pop());
  assert.equal(receipt.status, "incomplete");
  assert.deepEqual(receipt.artifacts, []);
  assert.deepEqual(receipt.failed.map((entry) => entry.id), ["NICHE7"]);
  assert.match(receipt.failed[0].error, /^POE_MARKETPLACE_MISMATCH: /);
  assert.deepEqual(receipt.pending.map((entry) => entry.id), ["NICHE8"]);
  assert.equal(listFiles(outDir).length, 0);
  assert.equal(fake.closed.includes(TARGET), false);
});

test("--top limits search niches only; explicit --niche-ids are always downloaded", async (t) => {
  const { root, lockDir, outDir } = tempRoot(t);
  const { fake, nicheCalls } = await batchFake(t, { nicheResult: (nicheId) => ({
    schemaVersion: "amazon-poe-downloader.envelope.v1", kind: "niche", marketplace: MARKETPLACE,
    capturedAt: "2026-09-09T00:00:00Z", nicheId, niche: null, error: "getNiche returned no niche (wrong nicheId or marketplace?)" }) });
  const result = await runCli(["batch", "--queries", "test query", "--niche-ids", "NICHE3,NICHE9", "--top", "1",
    "--marketplace", "us", "--expect-account", "PARTNER_A", "--port", String(fake.port), "--host", "127.0.0.1",
    "--out-dir", outDir], { cwd: root, lockDir, timeout: 60000 });
  assert.equal(result.code, 1, result.output);
  assert.deepEqual(nicheCalls, ["NICHE1", "NICHE3", "NICHE9"]);
  const receipt = JSON.parse(result.stdout.trim().split("\n").pop());
  assert.deepEqual(receipt.failed.map((entry) => entry.id), ["NICHE1", "NICHE3", "NICHE9"]);
  assert.equal(receipt.pending, undefined);
});

test("a niche response for another niche id stops the batch with POE_NICHE_MISMATCH", async (t) => {
  const { root, lockDir, outDir } = tempRoot(t);
  const { fake, nicheCalls } = await batchFake(t, { nicheResult: () => ({
    schemaVersion: "amazon-poe-downloader.envelope.v1", kind: "niche", marketplace: MARKETPLACE,
    capturedAt: "2026-09-09T00:00:00Z", nicheId: "NICHE7", niche: { nicheId: "NICHE_OTHER", nicheTitle: "Fixture other",
      obfuscatedMarketplaceId: MARKETPLACE, asinMetrics: [], searchTermMetrics: [], nicheSummary: {} } }) });
  const result = await runCli(["batch", "--niche-ids", "NICHE7", "--marketplace", "us",
    "--expect-account", "PARTNER_A", "--port", String(fake.port), "--host", "127.0.0.1",
    "--out-dir", outDir], { cwd: root, lockDir, timeout: 30000 });
  assert.equal(result.code, 1, result.output);
  assert.match(result.stderr, /POE_NICHE_MISMATCH: the niche response reports niche NICHE_OTHER, requested NICHE7/);
  assert.deepEqual(nicheCalls, ["NICHE7"]);
  const receipt = JSON.parse(result.stdout.trim().split("\n").pop());
  assert.deepEqual(receipt.failed.map((entry) => entry.id), ["NICHE7"]);
  assert.equal(listFiles(outDir).length, 0);
});

test("an incomplete receipt larger than a pipe buffer arrives whole on the failure path", async (t) => {
  const { root, lockDir, outDir } = tempRoot(t);
  const { fake } = await batchFake(t, { nicheResult: (nicheId) => ({
    schemaVersion: "amazon-poe-downloader.envelope.v1", kind: "niche", marketplace: MARKETPLACE,
    capturedAt: "2026-09-09T00:00:00Z", nicheId, niche: { nicheId, nicheTitle: `Fixture ${nicheId}`,
      obfuscatedMarketplaceId: "A1PA6795UKMFR9" } }) });
  // The first niche is rejected, so every other id stays pending: about 150 KB of receipt.
  const ids = Array.from({ length: 3000 }, (_, i) => `NICHE${String(i).padStart(25, "0")}`);
  const result = await runCli(["batch", "--niche-ids", ids.join(","), "--marketplace", "us",
    "--expect-account", "PARTNER_A", "--port", String(fake.port), "--host", "127.0.0.1",
    "--out-dir", outDir], { cwd: root, lockDir, timeout: 30000 });
  assert.equal(result.code, 1, result.stderr);
  assert.ok(Buffer.byteLength(result.stdout) > 65536, `receipt is only ${Buffer.byteLength(result.stdout)} bytes`);
  const receipt = JSON.parse(result.stdout.trim().split("\n").pop());
  assert.equal(receipt.status, "incomplete");
  assert.equal(receipt.failed.length, 1);
  assert.equal(receipt.pending.length, ids.length - 1);
});
