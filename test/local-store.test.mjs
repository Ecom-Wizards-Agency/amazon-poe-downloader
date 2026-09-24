import { test, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateLabel, resolveOutDir, prepareStore, publishFiles } from "../lib/local-store.mjs";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poe-store-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const sha1 = (value) => crypto.createHash("sha1").update(value).digest("hex");
const tmpLeftovers = (dir) => fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));

test("first publish writes, identical re-publish reports existing without duplicates", (t) => {
  const { root } = prepareStore(path.join(tempDir(t), "out"));
  const files = [{ name: "a.csv", content: "x,y\n1,2\n" }, { name: "b.json", content: Buffer.from("{}") }];
  const first = publishFiles(files, { root });
  assert.deepEqual(first.artifacts.map((a) => a.status), ["written", "written"]);
  assert.equal(first.artifacts[0].sha1, sha1("x,y\n1,2\n"));
  assert.equal(first.artifacts[0].bytes, 8);
  assert.equal(first.artifacts[0].stored_name, "a.csv");
  assert.equal(first.artifacts[0].path, path.join(root, "a.csv"));

  const second = publishFiles(files, { root });
  assert.deepEqual(second.artifacts.map((a) => a.status), ["existing", "existing"]);
  assert.deepEqual(fs.readdirSync(root).sort(), ["a.csv", "b.json"]);
});

test("accepts { name, bytes }", (t) => {
  const { root } = prepareStore(tempDir(t));
  const receipt = publishFiles([{ name: "c.txt", bytes: new Uint8Array([104, 105]) }], { root });
  assert.equal(fs.readFileSync(path.join(root, "c.txt"), "utf8"), "hi");
  assert.equal(receipt.artifacts[0].bytes, 2);
});

test("different bytes under the same name go to the content-addressed name", (t) => {
  const { root } = prepareStore(tempDir(t));
  publishFiles([{ name: "a.csv", content: "old" }], { root });
  const receipt = publishFiles([{ name: "a.csv", content: "new" }], { root });
  const expected = `${sha1("new").slice(0, 12)}_a.csv`;
  assert.equal(receipt.artifacts[0].stored_name, expected);
  assert.equal(receipt.artifacts[0].status, "written");
  assert.equal(fs.readFileSync(path.join(root, "a.csv"), "utf8"), "old");
  assert.equal(fs.readFileSync(path.join(root, expected), "utf8"), "new");

  const again = publishFiles([{ name: "a.csv", content: "new" }], { root });
  assert.equal(again.artifacts[0].status, "existing");
  assert.equal(again.artifacts[0].stored_name, expected);
});

test("throws when both candidates hold different bytes", (t) => {
  const { root } = prepareStore(tempDir(t));
  fs.writeFileSync(path.join(root, "a.csv"), "one");
  fs.writeFileSync(path.join(root, `${sha1("two").slice(0, 12)}_a.csv`), "three");
  assert.throws(() => publishFiles([{ name: "a.csv", content: "two" }], { root }), /Conflicting content at .*; not overwritten/);
  assert.equal(fs.readFileSync(path.join(root, "a.csv"), "utf8"), "one");
});

test("rejects empty file lists and unsafe basenames", (t) => {
  const { root } = prepareStore(tempDir(t));
  assert.throws(() => publishFiles([], { root }), /No POE files to publish/);
  for (const name of ["", ".", "..", "a/b", "a\\b", "../x"]) {
    assert.throws(() => publishFiles([{ name, content: "x" }], { root }), /Invalid POE basename/, name);
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

test("prepareStore rejects a regular file path", (t) => {
  const file = path.join(tempDir(t), "plain.txt");
  fs.writeFileSync(file, "x");
  assert.throws(() => prepareStore(file), { code: "POE_OUT_DIR_INVALID" });
  assert.throws(() => prepareStore(path.join(file, "child")), { code: "POE_OUT_DIR_INVALID" });
});

test("validateLabel and resolveOutDir", () => {
  assert.equal(validateLabel("run-2024.01_a"), "run-2024.01_a");
  for (const bad of ["..", ".", "a/b", "a\\b", "", ".hidden", "-x", "x".repeat(65), 5]) {
    assert.throws(() => validateLabel(bad), { code: "POE_LABEL_INVALID" }, String(bad));
  }
  const cwd = path.join(os.tmpdir(), "poe-cwd");
  assert.equal(resolveOutDir({ env: {}, cwd }), path.join(cwd, "poe-output"));
  assert.equal(resolveOutDir({ env: { POE_OUT_DIR: "envdir" }, cwd }), path.join(cwd, "envdir"));
  assert.equal(resolveOutDir({ outDir: "flag", env: { POE_OUT_DIR: "envdir" }, cwd }), path.join(cwd, "flag"));
  assert.equal(resolveOutDir({ outDir: "flag", label: "run1", env: {}, cwd }), path.join(cwd, "flag", "run1"));
  assert.throws(() => resolveOutDir({ label: "../up", env: {}, cwd }), { code: "POE_LABEL_INVALID" });
});

test("no temporary files remain, including after a forced write failure", (t) => {
  const { root } = prepareStore(tempDir(t));
  publishFiles([{ name: "ok.csv", content: "1" }], { root });
  assert.deepEqual(tmpLeftovers(root), []);

  const failing = mock.method(fs, "linkSync", () => {
    const error = new Error("simulated disk failure");
    error.code = "EIO";
    throw error;
  });
  t.after(() => failing.mock.restore());
  assert.throws(() => publishFiles([{ name: "bad.csv", content: "2" }], { root }), /simulated disk failure/);
  failing.mock.restore();
  assert.deepEqual(tmpLeftovers(root), []);
  assert.equal(fs.existsSync(path.join(root, "bad.csv")), false);
});

test("falls back to exclusive copy when hard links are unsupported", (t) => {
  const { root } = prepareStore(tempDir(t));
  const noLinks = mock.method(fs, "linkSync", () => {
    const error = new Error("links unsupported");
    error.code = "EPERM";
    throw error;
  });
  t.after(() => noLinks.mock.restore());
  const receipt = publishFiles([{ name: "copy.csv", content: "abc" }], { root });
  noLinks.mock.restore();
  assert.equal(receipt.artifacts[0].status, "written");
  assert.equal(fs.readFileSync(path.join(root, "copy.csv"), "utf8"), "abc");
  assert.deepEqual(tmpLeftovers(root), []);
});

test("receipt keys are exact", (t) => {
  const { root } = prepareStore(tempDir(t));
  const receipt = publishFiles([{ name: "k.csv", content: "k" }], { root });
  assert.deepEqual(Object.keys(receipt).sort(), ["artifacts", "output_folder", "status"]);
  assert.equal(receipt.output_folder, root);
  assert.equal(receipt.status, "stored_verified");
  assert.deepEqual(Object.keys(receipt.artifacts[0]).sort(), ["bytes", "name", "path", "sha1", "status", "stored_name"]);
});

test("a failure partway through a set reports the files already stored", (t) => {
  const { root } = prepareStore(tempDir(t));
  // A directory under the second name makes that file fail to store.
  fs.mkdirSync(path.join(root, "b.json"));
  const files = [{ name: "a.csv", content: "x\n" }, { name: "b.json", content: "{}" }, { name: "c.csv", content: "y\n" }];
  assert.throws(() => publishFiles(files, { root }), (error) => {
    assert.ok(Array.isArray(error.artifacts));
    assert.deepEqual(error.artifacts.map((a) => [a.stored_name, a.status]), [["a.csv", "written"]]);
    return true;
  });
  assert.equal(fs.existsSync(path.join(root, "c.csv")), false);
});
