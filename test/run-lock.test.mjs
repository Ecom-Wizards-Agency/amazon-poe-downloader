import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireRunLock } from "../lib/run-lock.mjs";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poe-lock-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const lockPath = (dir, key, port) => path.join(dir, `amazon-poe-downloader-${key}-${port}.lock`);

test("a second acquire on the same endpoint throws POE_RUN_IN_PROGRESS", (t) => {
  const dir = tempDir(t);
  const release = acquireRunLock({ host: "127.0.0.1", port: 9222, dir });
  t.after(release);
  const body = JSON.parse(fs.readFileSync(lockPath(dir, "loopback", 9222), "utf8"));
  assert.equal(body.pid, process.pid);
  assert.ok(body.startedAt);
  assert.ok(Array.isArray(body.argv));
  assert.throws(
    () => acquireRunLock({ host: "127.0.0.1", port: 9222, dir }),
    (error) => error.code === "POE_RUN_IN_PROGRESS"
      && error.message === `another run (pid ${process.pid}) is using Chrome at 127.0.0.1:9222 (lock file ${lockPath(dir, "loopback", 9222)}; delete it only if no run is active)`,
  );
  const other = acquireRunLock({ host: "127.0.0.1", port: 9333, dir });
  other();
});

test("a stale lock is reclaimed", (t) => {
  const dir = tempDir(t);
  const file = lockPath(dir, "loopback", 9222);
  fs.writeFileSync(file, JSON.stringify({ pid: 999999, startedAt: "x", argv: [] }));
  const release = acquireRunLock({ host: "localhost", port: 9222, dir, isAlive: () => false });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, process.pid);
  release();
  assert.equal(fs.existsSync(file), false);
});

test("a live foreign holder blocks", (t) => {
  const dir = tempDir(t);
  const file = lockPath(dir, "loopback", 9222);
  fs.writeFileSync(file, JSON.stringify({ pid: 424242, startedAt: "x", argv: [] }));
  assert.throws(
    () => acquireRunLock({ host: "localhost", port: 9222, dir, isAlive: () => true }),
    { code: "POE_RUN_IN_PROGRESS", message: `another run (pid 424242) is using Chrome at localhost:9222 (lock file ${file}; delete it only if no run is active)` },
  );
  assert.equal(fs.existsSync(file), true);
});

test("release removes the lock file and is idempotent", (t) => {
  const dir = tempDir(t);
  const release = acquireRunLock({ host: "::1", port: 9222, dir });
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^amazon-poe-downloader-[A-Za-z0-9._-]+-9222\.lock$/);
  release();
  release();
  assert.deepEqual(fs.readdirSync(dir), []);
  const again = acquireRunLock({ host: "::1", port: 9222, dir });
  again();
});

test("every loopback spelling shares one lock", (t) => {
  const dir = tempDir(t);
  const release = acquireRunLock({ host: "localhost", port: 9222, dir });
  t.after(release);
  for (const host of ["127.0.0.1", "[::1]", "::1", "127.0.0.2"]) {
    assert.throws(() => acquireRunLock({ host, port: 9222, dir }), { code: "POE_RUN_IN_PROGRESS" });
  }
});

test("the lock file is readable by its owner only", { skip: process.platform === "win32" }, (t) => {
  const dir = tempDir(t);
  const release = acquireRunLock({ host: "127.0.0.1", port: 9222, dir });
  t.after(release);
  assert.equal(fs.statSync(lockPath(dir, "loopback", 9222)).mode & 0o777, 0o600);
});

test("a fresh lock that replaced a stale one during reclaim is kept", (t) => {
  const dir = tempDir(t);
  const file = lockPath(dir, "loopback", 9222);
  fs.writeFileSync(file, JSON.stringify({ pid: 999999, startedAt: "x", argv: [] }));
  // While this run judges pid 999999 stale, another run reclaims the lock first.
  const isAlive = (pid) => {
    if (pid === 999999) {
      fs.writeFileSync(file, JSON.stringify({ pid: 424242, startedAt: "y", argv: [] }));
      return false;
    }
    return pid === 424242;
  };
  assert.throws(() => acquireRunLock({ host: "127.0.0.1", port: 9222, dir, isAlive }),
    { code: "POE_RUN_IN_PROGRESS", pid: 424242 });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, 424242);
  assert.deepEqual(fs.readdirSync(dir), [path.basename(file)]);
});

test("a just-created lock without a readable pid counts as busy", (t) => {
  const dir = tempDir(t);
  const file = lockPath(dir, "loopback", 9222);
  fs.writeFileSync(file, "");
  assert.throws(
    () => acquireRunLock({ host: "127.0.0.1", port: 9222, dir, isAlive: () => false }),
    (error) => error.code === "POE_RUN_IN_PROGRESS",
  );
  assert.equal(fs.readFileSync(file, "utf8"), "");
});

test("an old lock without a readable pid is reclaimed", (t) => {
  const dir = tempDir(t);
  const file = lockPath(dir, "loopback", 9222);
  fs.writeFileSync(file, "");
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(file, old, old);
  const release = acquireRunLock({ host: "127.0.0.1", port: 9222, dir, isAlive: () => false });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, process.pid);
  release();
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("a stale lock is left alone while another run holds the reclaim guard", (t) => {
  const dir = tempDir(t);
  const file = lockPath(dir, "loopback", 9222);
  const stale = JSON.stringify({ pid: 999999, startedAt: "x", argv: [] });
  fs.writeFileSync(file, stale);
  fs.writeFileSync(`${file}.reclaim`, "424242");
  assert.throws(() => acquireRunLock({ host: "127.0.0.1", port: 9222, dir, isAlive: () => false }),
    { code: "POE_RUN_IN_PROGRESS" });
  assert.equal(fs.readFileSync(file, "utf8"), stale);
  assert.ok(fs.existsSync(`${file}.reclaim`), "a young guard belongs to a live reclaim");
});

test("a reclaim guard left by a crash is cleared and the stale lock reclaimed", (t) => {
  const dir = tempDir(t);
  const file = lockPath(dir, "loopback", 9222);
  fs.writeFileSync(file, JSON.stringify({ pid: 999999, startedAt: "x", argv: [] }));
  fs.writeFileSync(`${file}.reclaim`, "424242");
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(`${file}.reclaim`, old, old);
  const release = acquireRunLock({ host: "127.0.0.1", port: 9222, dir, isAlive: () => false });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, process.pid);
  release();
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("a lock replaced by a new file after the stale check is never removed", (t) => {
  const dir = tempDir(t);
  const file = lockPath(dir, "loopback", 9222);
  fs.writeFileSync(file, JSON.stringify({ pid: 999999, startedAt: "x", argv: [] }));
  // Another run reclaims the stale lock and links its own new file in its place.
  const isAlive = (pid) => {
    if (pid === 999999) {
      fs.rmSync(file);
      fs.writeFileSync(file, JSON.stringify({ pid: 424242, startedAt: "y", argv: [] }));
      return false;
    }
    return pid === 424242;
  };
  assert.throws(() => acquireRunLock({ host: "127.0.0.1", port: 9222, dir, isAlive }),
    { code: "POE_RUN_IN_PROGRESS", pid: 424242 });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, 424242);
  assert.deepEqual(fs.readdirSync(dir), [path.basename(file)]);
});

test("a lock naming this process's pid that this process does not hold is stale", (t) => {
  const dir = tempDir(t);
  const file = lockPath(dir, "loopback", 9222);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: "x", argv: [] }));
  const release = acquireRunLock({ host: "127.0.0.1", port: 9222, dir });
  const body = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(body.pid, process.pid);
  assert.notEqual(body.startedAt, "x", "the reused-pid lock was replaced");
  assert.throws(() => acquireRunLock({ host: "127.0.0.1", port: 9222, dir }), { code: "POE_RUN_IN_PROGRESS" });
  release();
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("without hard links a live lock that replaced a stale one survives the put-back", (t) => {
  const dir = tempDir(t);
  const file = lockPath(dir, "loopback", 9222);
  fs.writeFileSync(file, JSON.stringify({ pid: 999999, startedAt: "x", argv: [] }));
  t.mock.method(fs, "linkSync", () => {
    throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  });
  // While this run judges pid 999999 stale, another run replaces the lock.
  const isAlive = (pid) => {
    if (pid === 999999) {
      fs.rmSync(file);
      fs.writeFileSync(file, JSON.stringify({ pid: 424242, startedAt: "y", argv: [] }));
      return false;
    }
    return pid === 424242;
  };
  assert.throws(() => acquireRunLock({ host: "127.0.0.1", port: 9222, dir, isAlive }),
    { code: "POE_RUN_IN_PROGRESS", pid: 424242 });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, 424242);
  assert.deepEqual(fs.readdirSync(dir), [path.basename(file)]);
});
