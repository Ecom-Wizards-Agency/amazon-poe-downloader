import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatEnvelope } from "../format-poe.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, "format-poe.mjs");
const SCHEMA = "amazon-poe-downloader.envelope.v1";

function searchEnvelope() {
  return {
    schemaVersion: SCHEMA, kind: "search", marketplace: "ATVPDKIKX0DER",
    capturedAt: "2026-07-05T12:00:00Z", url: "https://sellercentral.amazon.com/opportunity-explorer/explore/search",
    query: "example query",
    niches: [{
      nicheId: "n1", nicheTitle: "example niche", currency: "USD",
      nicheSummary: {
        searchVolumeT360: 1000, searchVolumeGrowthT360: 0.1, searchVolumeT90: 300, searchVolumeGrowthT90: -0.05,
        minimumUnitsSoldT360: 10, maximumUnitsSoldT360: 20, minimumUnitsSoldT90: 1, maximumUnitsSoldT90: 2,
        returnRateT360: 0.01, avgPrice: 9.99, minimumPrice: 5, maximumPrice: 15, productCount: 3,
      },
      topSearchTermMetrics: [{ searchTerm: "example query" }],
    }],
  };
}

function assertInvalid(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, "POE_FORMAT_INVALID");
    assert.match(error.message, /^format-poe: /);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

test("--self-test exits 0", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--self-test"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /all assertions passed/);
});

test("formatEnvelope refuses an error envelope", () => {
  assertInvalid(() => formatEnvelope({ ...searchEnvelope(), error: "not authorized (401)" }), /capture contains an error/);
});

test("formatEnvelope refuses a wrong schema id", () => {
  assertInvalid(() => formatEnvelope({ ...searchEnvelope(), schemaVersion: "something-else.v1" }), /is not an amazon-poe-downloader\.envelope\.v1 envelope/);
  assertInvalid(() => formatEnvelope(null));
});

test("formatEnvelope refuses a niche missing required sections", () => {
  const env = {
    schemaVersion: SCHEMA, kind: "niche", marketplace: "ATVPDKIKX0DER", capturedAt: "2026-07-05T12:00:00Z",
    nicheId: "n1", niche: { nicheTitle: "example niche", asinMetrics: [], nicheSummary: {} },
  };
  assertInvalid(() => formatEnvelope(env), /missing required section 'searchTermMetrics'/);
  assertInvalid(() => formatEnvelope({ ...env, niche: null }), /no \.niche payload/);
});

test("formatEnvelope writes a supplied account into the overview", () => {
  const env = {
    schemaVersion: SCHEMA, kind: "niche", marketplace: "ATVPDKIKX0DER", capturedAt: "2026-07-05T12:00:00Z",
    nicheId: "n1", niche: { nicheTitle: "example niche", asinMetrics: [], searchTermMetrics: [], nicheSummary: {} },
  };
  const account = { displayName: "Example Seller United States", partnerAccountId: "PARTNER_A", sessionMarketplaceId: "ATVPDKIKX0DER" };
  const overview = (files) => JSON.parse(files.find((f) => f.name.endsWith("_overview.json")).content);
  assert.deepEqual(overview(formatEnvelope(env, { account })).account, account);
  assert.equal(overview(formatEnvelope(env)).account, null);
});

test("--stdin stores the related-niches pair and prints a verified receipt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "format-poe-test-"));
  try {
    const r = spawnSync(process.execPath, [SCRIPT, "--stdin", "--out-dir", dir], {
      input: JSON.stringify(searchEnvelope()), encoding: "utf8", env: { ...process.env, POE_OUT_DIR: "" },
    });
    assert.equal(r.status, 0, r.stderr);
    const receipt = JSON.parse(r.stdout);
    assert.equal(receipt.schema_version, 1);
    assert.equal(receipt.complete, true);
    assert.equal(receipt.status, "stored_verified");
    assert.equal(receipt.output_folder, path.resolve(dir));
    assert.equal(receipt.artifacts.length, 2);
    assert.deepEqual(receipt.artifacts.map((a) => a.name).sort(), [
      "2026-07-05_poe_us_example-query_related-niches.csv",
      "2026-07-05_poe_us_example-query_related-niches.json",
    ]);
    for (const artifact of receipt.artifacts) {
      assert.equal(artifact.status, "written");
      const bytes = fs.readFileSync(artifact.path);
      assert.equal(crypto.createHash("sha1").update(bytes).digest("hex"), artifact.sha1);
      assert.equal(bytes.length, artifact.bytes);
    }
    const json = JSON.parse(fs.readFileSync(path.join(dir, "2026-07-05_poe_us_example-query_related-niches.json"), "utf8"));
    assert.equal(json.schemaVersion, "amazon-poe-downloader.related-niches.v1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--stdin with an error envelope exits 1 and writes nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "format-poe-test-"));
  try {
    const r = spawnSync(process.execPath, [SCRIPT, "--stdin", "--out-dir", dir], {
      input: JSON.stringify({ ...searchEnvelope(), error: "boom" }), encoding: "utf8",
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /capture contains an error/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a symlinked entry point still runs as the CLI", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "format-poe-link-"));
  try {
    const link = path.join(dir, "format-poe");
    try {
      fs.symlinkSync(SCRIPT, link);
    } catch (error) {
      // Windows needs Developer Mode or an elevated shell for symlinks.
      if (process.platform === "win32" && (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("creating symlinks is not permitted on this Windows account");
        return;
      }
      throw error;
    }
    const r = spawnSync(process.execPath, [link, "--self-test"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /all assertions passed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a niche title without Latin letters or digits names its files by niche id", () => {
  const files = formatEnvelope({
    schemaVersion: SCHEMA, kind: "niche", marketplace: "A1VC38T7YXB528", capturedAt: "2026-07-05T12:00:00Z",
    nicheId: "abc123", niche: { nicheId: "abc123", nicheTitle: "デスクランプ", asinMetrics: [], searchTermMetrics: [], nicheSummary: {} },
  }, {});
  assert.ok(files.every((file) => file.name.includes("jp-niche-abc123")), files.map((file) => file.name).join(", "));
});

test("the format-poe CLI rejects unknown options and accepts --name=value", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "format-poe-test-"));
  try {
    const bad = spawnSync(process.execPath, [SCRIPT, "--stdin", "--outdir", dir], {
      input: JSON.stringify(searchEnvelope()), encoding: "utf8", cwd: dir,
    });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /POE_ARGUMENT_INVALID: unknown option --outdir/);
    assert.deepEqual(fs.readdirSync(dir), []);
    const good = spawnSync(process.execPath, [SCRIPT, "--stdin", `--out-dir=${dir}`], {
      input: JSON.stringify(searchEnvelope()), encoding: "utf8", env: { ...process.env, POE_OUT_DIR: "" },
    });
    assert.equal(good.status, 0, good.stderr);
    assert.equal(JSON.parse(good.stdout).output_folder, path.resolve(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a store failure after some files prints an incomplete receipt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "format-poe-test-"));
  try {
    // Occupy both names the CSV could take with other bytes, so only the JSON is stored.
    const csv = formatEnvelope(searchEnvelope(), {}).find((file) => file.name.endsWith(".csv"));
    const hash = crypto.createHash("sha1").update(Buffer.from(csv.content)).digest("hex");
    fs.writeFileSync(path.join(dir, csv.name), "other bytes");
    fs.writeFileSync(path.join(dir, `${hash.slice(0, 12)}_${csv.name}`), "other bytes");
    const r = spawnSync(process.execPath, [SCRIPT, "--stdin", "--out-dir", dir], {
      input: JSON.stringify(searchEnvelope()), encoding: "utf8", env: { ...process.env, POE_OUT_DIR: "" },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Conflicting content/);
    const receipt = JSON.parse(r.stdout);
    assert.equal(receipt.status, "incomplete");
    assert.equal(receipt.complete, false);
    assert.deepEqual(receipt.artifacts.map((a) => a.name), ["2026-07-05_poe_us_example-query_related-niches.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
