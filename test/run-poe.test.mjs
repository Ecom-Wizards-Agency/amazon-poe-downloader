// CLI surface of run-poe.mjs that needs no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeCdp } from "./helpers/fake-cdp.mjs";

const RUN = fileURLToPath(new URL("../run-poe.mjs", import.meta.url));

function run(t, args) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "poe-cli-test-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const env = { ...process.env, TMPDIR: cwd, TEMP: cwd, TMP: cwd };
  for (const key of ["CDP_PORT", "CDP_HOST", "CDP_DEBUG", "POE_OUT_DIR"]) delete env[key];
  const result = spawnSync(process.execPath, [RUN, ...args], { cwd, env, encoding: "utf8", timeout: 15000 });
  return { ...result, cwd };
}

test("self-test exits 0", (t) => {
  const result = run(t, ["self-test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /run-poe self-test: (\d+)\/\1 passed/);
});

for (const args of [["--help"], ["help"]]) {
  test(`${args[0]} prints usage to stdout and exits 0`, (t) => {
    const result = run(t, args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /doctor/);
    assert.match(result.stdout, /--marketplace cc/);
    assert.equal(result.stderr, "");
  });
}

test("an unknown command prints usage to stderr and exits 1", (t) => {
  const result = run(t, ["frobnicate"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage: run-poe\.mjs/);
});

for (const port of ["abc", "70000", "0"]) {
  test(`--port ${port} is rejected with exit 1`, (t) => {
    const result = run(t, ["doctor", "--port", port]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /CDP_PORT_INVALID/);
  });
}

test("a data command without --marketplace exits 1 before touching the output folder", (t) => {
  const result = run(t, ["search", "--query", "test query", "--port", "1"]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /POE_MARKETPLACE_REQUIRED/);
  assert.equal(fs.existsSync(path.join(result.cwd, "poe-output")), false);
});

test("an unknown marketplace code exits 1", (t) => {
  const result = run(t, ["niche", "--niche-id", "N1", "--marketplace", "zz", "--port", "1"]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /POE_MARKETPLACE_UNKNOWN/);
});

test("a non-loopback host prints a tunnel warning", (t) => {
  const result = run(t, ["search", "--query", "q", "--host", "192.0.2.10", "--port", "9"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /WARNING: Chrome DevTools at 192\.0\.2\.10:9 is not on this machine/);
  assert.match(result.stderr, /SSH tunnel/);
});

function runAsync(t, args) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "poe-cli-test-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const env = { ...process.env, TMPDIR: cwd, TEMP: cwd, TMP: cwd };
  for (const key of ["CDP_PORT", "CDP_HOST", "CDP_DEBUG", "POE_OUT_DIR"]) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUN, ...args], { cwd, env, timeout: 15000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function doctorFake(t, { userTabSignedOut = false } = {}) {
  const userResults = { "Runtime.evaluate": ({ expression = "" }) => {
    if (userTabSignedOut && expression.includes("chooserButtonCount")) return { result: { value: { url: "https://sellercentral.amazon.de/ap/signin", csrfMeta: false, chooserButtonCount: 0, title: "Amazon Sign-In" } } };
    return results["Runtime.evaluate"]({ expression });
  } };
  const results = { "Runtime.evaluate": ({ expression = "" }) => {
    if (expression.includes("chooserButtonCount")) return { result: { value: { url: "https://sellercentral.amazon.de/opportunity-explorer", csrfMeta: true, chooserButtonCount: 0, title: "Opportunity Explorer" } } };
    if (expression.includes("GetUserContext")) return { result: { value: { displayName: "Example Seller", partnerAccountId: "PARTNER_A", merchantId: "SELLER_A", marketplace: "A1PA6795UKMFR9", err: null } } };
    if (expression.includes("readyState")) return { result: { value: true } };
    return { result: { value: null } };
  } };
  let created = 0;
  const fake = await startFakeCdp({
    targets: [{ id: "USER_TAB", url: "https://sellercentral.amazon.de/opportunity-explorer", behavior: { results: userResults } }],
    onCreateTarget: ({ url }) => ({ id: created++ ? `DOCTOR_TAB_${created}` : "DOCTOR_TAB", url, behavior: { results } }),
  });
  t.after(() => fake.close());
  return fake;
}

for (const [cc, status, verdict, closed] of [["de", 0, /Marketplace: match/, ["DOCTOR_TAB"]], ["fr", 0, /Marketplace: same region \(eu\)/, ["DOCTOR_TAB"]],
  ["us", 1, /Marketplace: WRONG REGION/, ["DOCTOR_TAB", "DOCTOR_TAB_2"]]]) {
  test(`doctor --marketplace ${cc} reports the region verdict and leaves the user's tab open`, async (t) => {
    const fake = await doctorFake(t);
    const result = await runAsync(t, ["doctor", "--port", String(fake.port), "--marketplace", cc]);
    assert.equal(result.status, status, result.stdout + result.stderr);
    assert.match(result.stdout, /Chrome: FakeChrome\/1\.0 \(protocol 1\.3\)/);
    assert.match(result.stdout, /Login: OK/);
    assert.match(result.stdout, /POE https:\/\/sellercentral\.amazon\.de: ready/);
    assert.match(result.stdout, /Active account: Example Seller \[partnerAccountId=PARTNER_A\] marketplace=A1PA6795UKMFR9 \(de\)/);
    assert.match(result.stdout, verdict);
    // us has no open tab in its region, so doctor also checks its own domain.
    assert.deepEqual(fake.closed, closed);
  });
}

test("doctor checks a fresh tab when the open Seller Central tab is signed out", async (t) => {
  const fake = await doctorFake(t, { userTabSignedOut: true });
  const result = await runAsync(t, ["doctor", "--port", String(fake.port), "--marketplace", "de"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Login: NOT signed in/);
  assert.match(result.stdout, /checking a fresh Opportunity Explorer tab/);
  assert.match(result.stdout, /POE https:\/\/sellercentral\.amazon\.de: ready/);
  assert.match(result.stdout, /Doctor: ready\./);
});

test("doctor --quick still stops at a signed-out open tab", async (t) => {
  const fake = await doctorFake(t, { userTabSignedOut: true });
  const result = await runAsync(t, ["doctor", "--quick", "--port", String(fake.port), "--marketplace", "de"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Login: NOT signed in/);
  assert.deepEqual(fake.closed, []);
});

test("doctor with no Seller Central tab and no marketplace tells the user what to open", async (t) => {
  const fake = await startFakeCdp({ targets: [{ id: "OTHER", url: "https://example.com/" }] });
  t.after(() => fake.close());
  const result = await runAsync(t, ["doctor", "--port", String(fake.port)]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /No Seller Central tab is open/);
  assert.match(result.stdout, /opportunity-explorer/);
  assert.equal(fake.sent.length, 0);
});

test("doctor --quick with --marketplace and no Seller Central tab does not claim to check an origin", async (t) => {
  const fake = await startFakeCdp({ targets: [{ id: "OTHER", url: "https://example.com/" }] });
  t.after(() => fake.close());
  const result = await runAsync(t, ["doctor", "--quick", "--marketplace", "us", "--port", String(fake.port)]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /No Seller Central tab is open\./);
  assert.doesNotMatch(result.stdout, /checking \S+ directly/);
  assert.match(result.stdout, /Login: not verified/);
  assert.equal(fake.sent.length, 0, "--quick opens no tab");
});

test("the SKILL.md commands block is the exact help text", (t) => {
  const result = run(t, ["help"]);
  const skill = fs.readFileSync(fileURLToPath(new URL("../SKILL.md", import.meta.url)), "utf8");
  const block = /## Commands\n\n```text\n([\s\S]*?)```/.exec(skill);
  assert.ok(block, "SKILL.md has a Commands text block");
  assert.equal(block[1].replace(/\r\n/g, "\n"), result.stdout.replace(/\r\n/g, "\n"));
});

test("doctor on an unreachable port prints the launch hint", async (t) => {
  const fake = await startFakeCdp({ targets: [] });
  const { port } = fake;
  await fake.close();
  const result = await runAsync(t, ["doctor", "--port", String(port)]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Chrome: not reachable \(CDP_UNREACHABLE\)/);
  assert.match(result.stdout, /--remote-debugging-port=/);
});

test("doctor --quick with --origin is rejected before Chrome is contacted", async (t) => {
  const fake = await startFakeCdp({ targets: [] });
  t.after(() => fake.close());
  const result = await runAsync(t, ["doctor", "--quick", "--origin", "https://sellercentral.amazon.de", "--port", String(fake.port)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /POE_ARGUMENT_INVALID/);
  assert.equal(fake.sent.length, 0);
});

test("doctor fails fast when the debug port accepts connections but never answers", async (t) => {
  const net = await import("node:net");
  const sockets = new Set();
  const server = net.createServer((socket) => { sockets.add(socket); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const started = Date.now();
  const result = await runAsync(t, ["doctor", "--port", String(server.address().port)]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /Chrome: not reachable/);
  assert.ok(Date.now() - started < 14000, "a stalled endpoint fails within the HTTP timeout");
});

for (const [name, args, pattern] of [
  ["niche without --niche-id", ["niche", "--marketplace", "us"], /--niche-id is required for niche/],
  ["search without --query", ["search", "--marketplace", "us"], /--query is required for search/],
  ["batch without keywords or niche ids", ["batch", "--marketplace", "us"], /batch needs --queries/],
  ["--marketplace-label without --account-name", ["search", "--query", "q", "--marketplace", "us", "--marketplace-label", "United States"], /--marketplace-label only steers the account picker/],
  ["--parent-account-name without --account-name", ["niche", "--niche-id", "N1", "--marketplace", "us", "--parent-account-name", "Example Parent"], /--parent-account-name only steers the account picker/],
  ["batch with both --queries and --query", ["batch", "--queries", "desk lamp,floor lamp", "--query", "desk lamp", "--marketplace", "us"], /batch takes --queries or --query, not both/],
  ["batch with both --top and --all", ["batch", "--queries", "desk lamp", "--top", "5", "--all", "--marketplace", "us"], /--top and --all both limit the search niches/],
]) {
  test(`${name} is rejected with POE_ARGUMENT_INVALID before the output folder`, (t) => {
    const result = run(t, [...args, "--port", "1"]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /^POE_ARGUMENT_INVALID: /m);
    assert.match(result.stderr, pattern);
    assert.doesNotMatch(result.stderr, /usage: run-poe\.mjs/);
    assert.equal(result.stdout, "");
    assert.equal(fs.existsSync(path.join(result.cwd, "poe-output")), false);
  });
}
