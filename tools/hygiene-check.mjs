#!/usr/bin/env node
/**
 * Public-repo hygiene check.
 *
 * This repository is public. The things that must never reach it are, in
 * rough order of how easily they slip in: an absolute path into somebody's
 * home directory, a credential or session value copied from a browser, a real
 * seller account id or ASIN, an email address, a client name, and a whole
 * directory nobody meant to commit.
 *
 * What is scanned: every file git would publish, meaning tracked files plus
 * untracked files that are not gitignored (`git ls-files -co --exclude-standard`).
 * Including untracked files lets the check run before the first `git add`.
 * Without git the tree is walked instead, skipping .git, node_modules, _local
 * and the directory patterns in .gitignore.
 *
 * Patterns that would match this file are assembled from fragments, and this
 * file is exempt from the content rules, so the scanner never reports itself.
 *
 * Usage: node tools/hygiene-check.mjs   (exit 0 when clean, 1 on any finding)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CC_MP } from "../lib/marketplaces.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SELF = "tools/hygiene-check.mjs";

/** Anything bigger than this in a source repo is data, not authored text. */
const MAX_BYTES = 512 * 1024;

const BINARY_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz",
  ".woff", ".woff2", ".ttf", ".otf", ".xlsx", ".xlsm", ".docx",
];

/** Directories never scanned, whatever git says. */
const ALWAYS_SKIPPED_DIRS = [".git", "node_modules", "_local"];

// ---------------------------------------------------------------------------
// Rule patterns
// ---------------------------------------------------------------------------

/** Home-directory prefixes, built from fragments so this file has no literal match. */
const USER_PATH_PATTERNS = [
  new RegExp(`/${"Us"}${"ers"}/[A-Za-z0-9._-]+`, "g"),
  new RegExp(`/${"ho"}${"me"}/[a-z][a-z0-9._-]*`, "g"),
  new RegExp(`[A-Z]:\\\\${"Us"}${"ers"}\\\\[A-Za-z0-9._-]+`, "g"),
];

/** Credentials that announce themselves by prefix. */
const SECRET_PREFIX_PATTERNS = [
  { re: new RegExp(`\\b${"AK"}${"IA"}[0-9A-Z]{16}\\b`, "g"), what: "AWS access key id" },
  { re: new RegExp(`\\b${"gh"}${"p_"}[A-Za-z0-9]{30,}`, "g"), what: "GitHub token" },
  { re: new RegExp(`\\b${"github"}${"_pat_"}[A-Za-z0-9_]+`, "g"), what: "GitHub fine-grained token" },
  { re: new RegExp(`\\b${"s"}${"k-"}[A-Za-z0-9]{20,}`, "g"), what: "API secret key" },
  { re: new RegExp(`\\b${"xo"}${"x"}[abprs]-[A-Za-z0-9-]+`, "g"), what: "Slack token" },
  { re: new RegExp(`\\b${"At"}${"z"}[ar]\\|[A-Za-z0-9_.|-]+`, "g"), what: "Amazon LWA token" },
  { re: new RegExp(`-----${"BEGIN"} [A-Z ]*${"PRIVATE"} KEY-----`, "g"), what: "private key block" },
  { re: new RegExp(`\\b${"ey"}J[A-Za-z0-9_-]{10,}\\.${"ey"}J[A-Za-z0-9_-]{10,}`, "g"), what: "JWT" },
];

/** `password: "...."`, `apiKey = '....'` and similar. */
const SECRET_ASSIGNMENT = new RegExp(
  String.raw`\b(password|passwd|secret|token|api[_-]?key)["']?\s*[:=]\s*["']([^"'\n]{8,})["']`,
  "gi",
);

/** Assigned values that are obviously not a live credential. */
const PLACEHOLDER = /^(<|\$\{|process\.env)|(your|example|placeholder|changeme|redacted|fake|dummy|sample|fixture|xxx+|\.\.\.)/i;

/** Plain lowercase words such as "page-token" are test labels, not credentials. */
const READABLE_WORDS = /^[a-z]+(?:[-_ ][a-z]+)*$/;

/** Cookie and session value names from a logged-in Seller Central page. */
const SESSION_VALUE_NAMES = [
  "ubid" + "-",
  "sess-" + "at-" + "main",
  "at-" + "main",
  "session" + "-token",
];

/**
 * The Seller Central anti-forgery meta tag name followed directly by a quoted
 * value: `content="..."` in HTML, or `: "..."`, `= "..."`, `, "..."` in code.
 */
const CSRF_LITERAL = new RegExp(
  `${"anti-csrf"}${"token-a2z"}["'\\]]*\\s*(?:[:=,]|content\\s*=)\\s*['"\`]([A-Za-z0-9+/=_%.-]{20,})['"\`]`,
  "gi",
);

const HEX_ID = /\b[0-9a-f]{32,64}\b/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Public protocol constants that happen to look like ids. Each entry needs a
 * reason:
 * - the WebSocket handshake GUID from RFC 6455, section 1.3, used by the fake
 *   CDP server in the tests to compute Sec-WebSocket-Accept.
 */
const UUID_ALLOWED = new Set(["258eafa5-e914-47da-95ca-c5ab0dc85b11"]);

/**
 * Seller, merchant and marketplace ids share this shape. Case-sensitive. The
 * lookahead requires at least one digit: every real id carries one, and without
 * it plain upper-case words such as AUTHORIZATION would match.
 */
const ACCOUNT_ID = /\bA(?=[A-Z]*[0-9])[0-9A-Z]{11,15}\b/g;
const ACCOUNT_ID_ALLOWED = new Set([...Object.values(CC_MP), "AEXAMPLE" + "000001"]);

const ASIN = /\bB0[0-9A-Z]{8}\b/g;
const ASIN_ALLOWED = new Set(["B000000001", "B0XXXXXXXX"]);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

const SPACED_EM_DASH = new RegExp(` \u2014 `, "g");
const EM_DASH_EXTENSIONS = [".md", ".yaml", ".yml"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mask the middle so a finding can be printed in CI logs without leaking it. */
export function mask(value) {
  const flat = String(value).replace(/\s+/g, " ").trim();
  if (flat.length <= 8) return flat;
  if (flat.length <= 24) return `${flat.slice(0, 4)}...${flat.slice(-2)} (${flat.length} chars)`;
  return `${flat.slice(0, 10)}...${flat.slice(-4)} (${flat.length} chars)`;
}

function isBinaryPath(path) {
  const lower = path.toLowerCase();
  return BINARY_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function lineStarts(content) {
  const starts = [0];
  for (let i = 0; i < content.length; i += 1) if (content[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineAt(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-bounded where the term's own edges are word characters. */
function termPattern(term) {
  const lead = /^\w/.test(term) ? "\\b" : "";
  const trail = /\w$/.test(term) ? "\\b" : "";
  return new RegExp(`${lead}${escapeRegExp(term)}${trail}`, "gi");
}

// ---------------------------------------------------------------------------
// Content scan
// ---------------------------------------------------------------------------

/**
 * Scan file contents. `targets` is a list of { path, content } with
 * repo-relative, forward-slash paths. Returns findings of the shape
 * { rule, path, line, message, excerpt }.
 */
export function scanFiles(targets, { denylist = [], exempt = [SELF] } = {}) {
  const out = [];
  for (const { path, content } of targets) {
    if (exempt.includes(path)) continue;
    if (isBinaryPath(path) || content.includes("\0")) continue;
    scanContent(path, content, denylist, out);
  }
  return out;
}

function scanContent(path, content, denylist, out) {
  const starts = lineStarts(content);
  const lines = content.split("\n");
  const add = (rule, index, message, excerpt) => {
    out.push({ rule, path, line: lineAt(starts, index) + 1, message, excerpt });
  };
  const each = (re, fn) => {
    const pattern = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (const match of content.matchAll(pattern)) fn(match);
  };

  for (const re of USER_PATH_PATTERNS) {
    each(re, (m) => add("absolute-user-path", m.index,
      "absolute home-directory path. Use a repo-relative path or an environment variable.", mask(m[0])));
  }

  for (const { re, what } of SECRET_PREFIX_PATTERNS) {
    each(re, (m) => add("candidate-secret", m.index, `looks like a ${what}`, mask(m[0])));
  }
  each(SECRET_ASSIGNMENT, (m) => {
    const value = m[2];
    if (PLACEHOLDER.test(value) || READABLE_WORDS.test(value) || new Set(value).size <= 2) return;
    add("candidate-secret", m.index, `credential-shaped assignment to "${m[1]}"`, mask(value));
  });

  // Longest names first, so "sess-at-main" is reported once and not again as "at-main".
  const covered = [];
  for (const name of [...SESSION_VALUE_NAMES].sort((a, b) => b.length - a.length)) {
    each(termPattern(name), (m) => {
      const end = m.index + m[0].length;
      if (covered.some(([s, e]) => m.index < e && end > s)) return;
      covered.push([m.index, end]);
      add("session-value-names", m.index,
        "browser session or cookie value name. Keep session values out of the repo.", m[0]);
    });
  }

  each(CSRF_LITERAL, (m) => {
    if (PLACEHOLDER.test(m[1]) || READABLE_WORDS.test(m[1])) return;
    add("csrf-literal", m.index, "anti-forgery token followed by a literal value", mask(m[1]));
  });

  each(HEX_ID, (m) => add("hex-id", m.index, "long hex identifier", mask(m[0])));
  each(UUID, (m) => {
    if (UUID_ALLOWED.has(m[0].toLowerCase())) return;
    add("uuid", m.index, "UUID", mask(m[0]));
  });

  each(ACCOUNT_ID, (m) => {
    if (ACCOUNT_ID_ALLOWED.has(m[0])) return;
    add("amazon-account-id", m.index,
      "looks like a seller, merchant or marketplace id. Use AEXAMPLE000001 or a public marketplace id.", mask(m[0]));
  });

  each(ASIN, (m) => {
    if (ASIN_ALLOWED.has(m[0])) return;
    add("asin", m.index, "looks like a real ASIN. Use B000000001 or B0XXXXXXXX.", mask(m[0]));
  });

  each(EMAIL, (m) => add("email", m.index, "email address", mask(m[0])));

  if (EM_DASH_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext))) {
    each(SPACED_EM_DASH, (m) => {
      const line = lines[lineAt(starts, m.index)];
      add("spaced-em-dash", m.index, "spaced em-dash. Rewrite the sentence.", line.trim().slice(0, 60));
    });
  }

  // The excerpt names the entry number, never the matched text: the denylist
  // is private, and hygiene output can end up in shared logs.
  denylist.forEach((raw, index) => {
    const term = raw.trim();
    if (!term) return;
    each(termPattern(term), (m) => add("denylisted-term", m.index,
      "term from _local/hygiene-denylist.txt", `entry ${index + 1} (comments and blank lines not counted)`));
  });
}

// ---------------------------------------------------------------------------
// Directory rule
// ---------------------------------------------------------------------------

/**
 * A top-level directory that is neither tracked nor ignored. Input is
 * `git ls-files --others --exclude-standard --directory`, which collapses a
 * wholly untracked directory into one `name/` entry. Deeper entries mean the
 * directory is already partly tracked, which is an ordinary uncommitted change.
 */
export function scanTopLevelDirs(untrackedEntries) {
  const dirs = new Set();
  for (const entry of untrackedEntries) {
    const trimmed = entry.trim();
    if (/^[^/]+\/$/.test(trimmed)) dirs.add(trimmed);
  }
  return [...dirs].sort().map((dir) => ({
    rule: "untracked-top-level-dir",
    path: dir,
    line: 0,
    message: "top-level directory is neither tracked nor ignored. Commit it or add it to .gitignore.",
    excerpt: dir,
  }));
}

/** One term per line, `#` comments, deduplicated case-insensitively. */
export function parseDenylist(content) {
  const seen = new Set();
  const terms = [];
  for (const line of content.split("\n")) {
    const term = line.trim();
    if (!term || term.startsWith("#")) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

export function formatFindings(findings) {
  return findings
    .map((f) => `${f.path}:${f.line}  [${f.rule}] ${f.message}\n    ${f.excerpt}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// File listing
// ---------------------------------------------------------------------------

function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
  });
}

function gitAvailable() {
  try {
    return git(["rev-parse", "--show-toplevel"]).trim() !== "";
  } catch {
    return false;
  }
}

function splitZ(output) {
  return output.split("\0").filter((p) => p !== "");
}

function skipped(path) {
  return ALWAYS_SKIPPED_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`));
}

/** Directory patterns from .gitignore that a plain walk can honour. */
function ignoredDirPatterns() {
  const file = join(ROOT, ".gitignore");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.endsWith("/"))
    .map((line) => new RegExp(`^${escapeRegExp(line.slice(0, -1)).replace(/\\\*/g, "[^/]*")}$`));
}

function walk(dir, patterns, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = relative(ROOT, abs).split(sep).join("/");
    if (entry.isDirectory()) {
      if (ALWAYS_SKIPPED_DIRS.includes(entry.name)) continue;
      if (patterns.some((re) => re.test(entry.name))) continue;
      walk(abs, patterns, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function loadTargets(paths) {
  const targets = [];
  for (const path of paths) {
    const abs = join(ROOT, path);
    try {
      const stat = statSync(abs);
      if (!stat.isFile() || stat.size > MAX_BYTES) continue;
      targets.push({ path, content: readFileSync(abs, "utf8") });
    } catch {
      // A listed path that cannot be read now (deleted, broken symlink) is not a hygiene finding.
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  let denylist = [];
  let denylistNote;
  const denylistPath = join(ROOT, "_local", "hygiene-denylist.txt");
  if (existsSync(denylistPath)) {
    denylist = parseDenylist(readFileSync(denylistPath, "utf8"));
    denylistNote = `denylist: ${denylist.length} term(s) from _local/hygiene-denylist.txt`;
  } else {
    denylistNote = "WARNING: _local/hygiene-denylist.txt not found, denylisted-term check skipped";
  }

  let paths;
  let untracked = [];
  let dirNote = "";
  if (gitAvailable()) {
    paths = splitZ(git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]));
    untracked = splitZ(git(["ls-files", "-z", "--others", "--exclude-standard", "--directory", "--no-empty-directory"]));
  } else {
    paths = walk(ROOT, ignoredDirPatterns(), []);
    dirNote = "WARNING: git unavailable, walked the tree and skipped the untracked-top-level-dir check";
  }
  paths = [...new Set(paths)].filter((p) => !skipped(p)).sort();

  const targets = loadTargets(paths);
  const findings = [...scanFiles(targets, { denylist }), ...scanTopLevelDirs(untracked)];

  process.stdout.write(`hygiene-check: ${denylistNote}\n`);
  if (dirNote) process.stdout.write(`hygiene-check: ${dirNote}\n`);

  if (findings.length === 0) {
    process.stdout.write(`hygiene-check: clean (${targets.length} of ${paths.length} files scanned)\n`);
    return 0;
  }
  process.stderr.write(`${formatFindings(findings)}\n`);
  process.stderr.write(`hygiene-check: ${findings.length} finding(s) in ${targets.length} scanned files\n`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
