// Option parsing and tab selection of tools/discover-poe-endpoints.mjs. The
// tool is spawned as a real child process against a fake Chrome.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeCdp } from "./helpers/fake-cdp.mjs";

const TOOL = fileURLToPath(new URL("../tools/discover-poe-endpoints.mjs", import.meta.url));

function runTool(t, args) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "poe-discover-test-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const key of ["CDP_PORT", "CDP_HOST", "CDP_DEBUG"]) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TOOL, ...args], { cwd, env, timeout: 15000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.end();
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr, cwd }));
  });
}

test("a misspelled option stops the discovery tool before Chrome is contacted", async (t) => {
  const fake = await startFakeCdp({ targets: [] });
  t.after(() => fake.close());
  const result = await runTool(t, ["--expect-acount", "PARTNER_A", "--port", String(fake.port)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /POE_ARGUMENT_INVALID: unknown option --expect-acount/);
  assert.equal(fake.sent.length, 0);
  assert.deepEqual(fs.readdirSync(result.cwd), []);
});

test("--target on a tab outside the known Seller Central origins is refused before attaching", async (t) => {
  const fake = await startFakeCdp({ targets: [{ id: "LOOKALIKE", url: "https://sellercentral.amazon.evil.example/opportunity-explorer" }] });
  t.after(() => fake.close());
  const result = await runTool(t, ["--target", "LOOKALIKE", "--port", String(fake.port)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not on a known Seller Central origin/);
  assert.equal(fake.sent.some((call) => call.method === "Runtime.evaluate"), false);
  assert.deepEqual(fs.readdirSync(result.cwd), []);
});
