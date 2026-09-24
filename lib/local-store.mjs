// Local output store for POE captures.
//
// Files are written into one output directory without ever overwriting
// different bytes. A name that already holds identical content is reported as
// "existing"; a name that holds different content falls back to a
// content-addressed name (<sha1 prefix>_<name>). Every write goes through a
// temporary file that is hard-linked into place, so a crash never leaves a
// half-written file under the final name.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LINK_FALLBACK_CODES = new Set(["EPERM", "ENOTSUP", "EXDEV", "ENOSYS"]);
const MAX_RACE_RETRIES = 5;

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha1(buffer) {
  return crypto.createHash("sha1").update(buffer).digest("hex");
}

/** Validate a run label used as an output subfolder name. */
export function validateLabel(label) {
  if (typeof label !== "string" || label === "." || label === ".." || !LABEL_RE.test(label)) {
    throw codedError(
      `Invalid label ${JSON.stringify(label)}: use 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit.`,
      "POE_LABEL_INVALID",
    );
  }
  return label;
}

/** Resolve the output directory: --out-dir, then POE_OUT_DIR, then ./poe-output, plus an optional label. */
export function resolveOutDir({ outDir, label, env = process.env, cwd = process.cwd() } = {}) {
  const base = path.resolve(cwd, outDir || env.POE_OUT_DIR || "poe-output");
  if (label === undefined || label === null || label === "") return base;
  return path.join(base, validateLabel(label));
}

/** Create the output directory if needed and confirm it is a writable directory. */
export function prepareStore(dir) {
  if (typeof dir !== "string" || !dir) throw codedError("Output directory is required", "POE_OUT_DIR_INVALID");
  const root = path.resolve(dir);
  try {
    fs.mkdirSync(root, { recursive: true });
    if (!fs.statSync(root).isDirectory()) throw new Error("not a directory");
    fs.accessSync(root, fs.constants.W_OK);
  } catch (cause) {
    const error = codedError(`Output directory is not a writable directory: ${root} (${cause.code || cause.message})`, "POE_OUT_DIR_INVALID");
    error.cause = cause;
    throw error;
  }
  return { root };
}

function validBasename(name) {
  return typeof name === "string" && name !== "" && name !== "." && name !== ".."
    && !/[\\/]/.test(name) && !name.includes("\0") && path.basename(name) === name;
}

function toBuffer(file) {
  const value = file.content !== undefined ? file.content : file.bytes;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new Error(`POE file ${file.name} has no string or Buffer content`);
}

function readHash(target) {
  try { return sha1(fs.readFileSync(target)); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

/** Write content to dest without clobbering. Returns false when dest appeared meanwhile. */
function writeNoClobber(root, name, dest, content) {
  const tmp = path.join(root, `.${name}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, "wx");
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    try {
      fs.linkSync(tmp, dest);
    } catch (error) {
      if (error.code === "EEXIST") return false;
      if (!LINK_FALLBACK_CODES.has(error.code)) throw error;
      try { fs.copyFileSync(tmp, dest, fs.constants.COPYFILE_EXCL); }
      catch (copyError) { if (copyError.code === "EEXIST") return false; throw copyError; }
    }
    return true;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    try { fs.unlinkSync(tmp); } catch { /* never created or already gone */ }
  }
}

/**
 * Store in-memory formatter output under root and return a verified receipt.
 * files: [{ name, content }] or [{ name, bytes }] with Buffer or string data.
 * When a file fails partway through the set, the thrown error carries
 * `artifacts`: the files of this set already stored and verified.
 */
export function publishFiles(files, { root } = {}) {
  if (!Array.isArray(files) || !files.length) throw new Error("No POE files to publish");
  if (typeof root !== "string" || !root) throw codedError("publishFiles needs a prepared root directory", "POE_OUT_DIR_INVALID");
  const artifacts = [];
  try {
    storeEach(files, root, artifacts);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.artifacts = artifacts;
    throw failure;
  }
  return { output_folder: root, status: "stored_verified", artifacts };
}

function storeEach(files, root, artifacts) {
  for (const file of files) {
    if (!file || !validBasename(file.name)) throw new Error(`Invalid POE basename: ${JSON.stringify(file && file.name)}`);
    const content = toBuffer(file);
    const hash = sha1(content);
    const candidates = [file.name, `${hash.slice(0, 12)}_${file.name}`];
    let artifact = null;
    for (let attempt = 0; attempt <= MAX_RACE_RETRIES && !artifact; attempt += 1) {
      let raced = false;
      for (const storedName of candidates) {
        const dest = path.join(root, storedName);
        const prior = readHash(dest);
        if (prior === hash) {
          artifact = { name: file.name, stored_name: storedName, path: dest, sha1: hash, bytes: content.length, status: "existing" };
          break;
        }
        if (prior !== null) continue;
        if (!writeNoClobber(root, storedName, dest, content)) { raced = true; break; }
        const written = readHash(dest);
        if (written !== hash) throw new Error(`Checksum mismatch after write: ${dest}`);
        artifact = { name: file.name, stored_name: storedName, path: dest, sha1: hash, bytes: content.length, status: "written" };
        break;
      }
      if (!artifact && !raced) {
        throw new Error(`Conflicting content at ${path.join(root, candidates[1])}; not overwritten`);
      }
    }
    if (!artifact) throw new Error(`Could not store ${file.name}: destination kept changing during write`);
    artifacts.push(artifact);
  }
}
