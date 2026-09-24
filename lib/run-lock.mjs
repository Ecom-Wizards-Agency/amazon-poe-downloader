// One POE run per Chrome endpoint.
//
// Two runs driving the same Chrome tab at once would navigate over each
// other, so each run takes an exclusive lock file keyed by host and port.
// Every loopback spelling (localhost, 127.x.x.x, ::1) shares one key. A lock
// left behind by a process that no longer exists is reclaimed under a separate
// reclaim guard file. Nothing is ever deleted by path after a check: the guard
// holder renames the lock to a unique tombstone name, re-reads the tombstone
// and deletes it only when it is the same file (same inode, modification time
// and pid) it judged stale. Any other file is linked back under the lock name
// (renamed back where hard links are unsupported); if that name was taken
// again, the tombstone is kept and the run stops with POE_RUN_IN_PROGRESS.
// A crashed guard is cleared the same way. A new lock is linked into place
// with its full body where the file system supports hard links; otherwise it
// is created exclusively and then written, and an unreadable lock younger than
// 5 s is never reclaimed. A lock that names this process's own pid but that
// this process does not hold (a pid reused after a crash, for example PID 1 in
// a container) is stale.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    // EPERM means the process exists but belongs to another user.
    return true;
  }
}

/** Lock-file key for a host: every loopback spelling maps to "loopback". */
export function lockHostKey(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return "loopback";
  return h.replace(/[^a-z0-9.-]/g, "_") || "host";
}

function readPid(file) {
  try { return Number(JSON.parse(fs.readFileSync(file, "utf8")).pid); }
  catch { return null; }
}

// Lock files this process holds, so its own pid in a lock it does not hold
// can be told apart from a live lock of its own.
const held = new Set();

/** Identity, body and pid of a lock or guard file, read from one open file, or null. */
function readLock(file) {
  let fd;
  try { fd = fs.openSync(file, "r"); } catch { return null; }
  try {
    const { dev, ino, mtimeMs } = fs.fstatSync(fd);
    const text = fs.readFileSync(fd, "utf8");
    let pid = null;
    try { pid = Number(JSON.parse(text).pid); } catch { pid = null; }
    return { dev, ino, mtimeMs, text, pid: Number.isInteger(pid) && pid > 0 ? pid : null };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

const sameFile = (a, b) => Boolean(a && b) && a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs;

const sameLock = (a, b) => Boolean(a && b) && a.dev === b.dev && a.ino === b.ino
  && a.mtimeMs === b.mtimeMs && a.pid === b.pid;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Hard links are the atomic create: the lock appears with its full body or
// not at all. These codes mean the file system cannot link, so fall back to an
// exclusive create, whose empty-file window readLock() treats as busy.
const LINK_FALLBACK_CODES = new Set(["EPERM", "ENOTSUP", "EXDEV", "ENOSYS"]);
// An unreadable lock younger than this may still be receiving its body.
const YOUNG_LOCK_MS = 5000;
// A reclaim takes milliseconds; a guard older than this was left by a crash.
const STALE_GUARD_MS = 10000;

function createLock(file, body) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, body, { flag: "wx", mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    if (!LINK_FALLBACK_CODES.has(error.code)) throw error;
    try {
      fs.writeFileSync(file, body, { flag: "wx", mode: 0o600 });
      return true;
    } catch (writeError) {
      if (writeError.code === "EEXIST") return false;
      throw writeError;
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Delete `target` only if it is still the file `isExpected` accepts. The file
 * is first renamed to a unique tombstone, so the check and the delete concern
 * the same file. A file that turns out to be another one is linked back under
 * its name. Returns true when the expected file was deleted.
 */
function removeIfSame(target, isExpected) {
  const tomb = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tomb`;
  try { fs.renameSync(target, tomb); } catch { return false; } // gone already
  const moved = readLock(tomb);
  if (isExpected(moved)) {
    fs.rmSync(tomb, { force: true });
    return true;
  }
  // Not the judged file: put it back. A tombstone that is not the judged file
  // is never deleted. Without hard links it is renamed back when the name is
  // free. When another file took the name in the meantime, both files stay
  // and this run reports the endpoint as busy.
  try {
    fs.linkSync(tomb, target);
    fs.rmSync(tomb, { force: true });
    return false;
  } catch (error) {
    if (error.code !== "EEXIST" && !LINK_FALLBACK_CODES.has(error.code)) throw error;
    if (error.code !== "EEXIST" && !fs.existsSync(target)) {
      fs.renameSync(tomb, target);
      return false;
    }
  }
  throw Object.assign(new Error(`another run took ${target} while a stale lock was being reclaimed (its previous file is kept as ${tomb}; delete either only if no run is active)`),
    { code: "POE_RUN_IN_PROGRESS", pid: moved?.pid ?? null, lockFile: target });
}

/**
 * Remove the lock only if it is still the exact file judged stale. Returns
 * true when the caller should try to create the lock again, false when the
 * guard is held by another run.
 */
function reclaimStale(file, judged) {
  const guard = `${file}.reclaim`;
  const token = `${process.pid}.${randomBytes(8).toString("hex")}`;
  try {
    fs.writeFileSync(guard, JSON.stringify({ token }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const seen = readLock(guard);
    if (seen && Date.now() - seen.mtimeMs > STALE_GUARD_MS) removeIfSame(guard, (moved) => sameFile(moved, seen));
    return false;
  }
  try {
    removeIfSame(file, (moved) => sameLock(moved, judged));
    return true;
  } finally {
    const body = JSON.stringify({ token });
    removeIfSame(guard, (moved) => Boolean(moved) && moved.text === body);
  }
}

function busyError(pid, host, port, file) {
  const busy = new Error(`another run (pid ${pid ?? "unknown"}) is using Chrome at ${host}:${port} (lock file ${file}; delete it only if no run is active)`);
  busy.code = "POE_RUN_IN_PROGRESS";
  busy.pid = pid;
  busy.lockFile = file;
  return busy;
}

/** Acquire the run lock for host:port. Returns release(). */
export function acquireRunLock({ host = "127.0.0.1", port = 9222, dir = os.tmpdir(), isAlive = defaultIsAlive } = {}) {
  const file = path.join(dir, `amazon-poe-downloader-${lockHostKey(host)}-${String(port).replace(/[^0-9]/g, "_")}.lock`);
  // The lock body names the command line (which can hold account names), so
  // only the owner may read it.
  const body = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), argv: process.argv.slice(2) });

  let acquired = false;
  for (let attempt = 0; attempt < 5 && !acquired; attempt += 1) {
    if (createLock(file, body)) {
      acquired = true;
      break;
    }
    const judged = readLock(file);
    if (!judged) continue; // removed in between: try to create it again
    // Its own pid in a lock this process does not hold is a reused pid.
    const ownStale = judged.pid === process.pid && !held.has(file);
    if (judged.pid && !ownStale && isAlive(judged.pid)) throw busyError(judged.pid, host, port, file);
    // An unreadable lock that was just created may belong to a run that is
    // still writing it (exclusive-create fallback only): never reclaim it.
    if (!judged.pid && Date.now() - judged.mtimeMs < YOUNG_LOCK_MS) throw busyError(null, host, port, file);
    if (!reclaimStale(file, judged)) sleepSync(25 * (attempt + 1));
  }
  if (!acquired) throw busyError(readPid(file), host, port, file);

  held.add(file);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    held.delete(file);
    process.removeListener("exit", release);
    if (readPid(file) !== process.pid) return;
    try { fs.unlinkSync(file); } catch { /* already removed */ }
  };
  process.on("exit", release);
  return release;
}
