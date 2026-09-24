#!/usr/bin/env node
/**
 * Documentation lint.
 *
 * Keeps the skill manifest, the agent metadata and the prose docs honest
 * against the code they describe. Every check prints one line per problem and
 * the script exits 1 when any check fails. Warnings never fail the run.
 *
 * Files considered: tracked files plus untracked files that are not gitignored
 * (`git ls-files -co --exclude-standard`), or a plain tree walk when git is
 * unavailable.
 *
 * Checks:
 *   1  SKILL.md frontmatter: allowed keys, name, one-line quoted description
 *   2  SKILL.md has exactly one "Browser:" line, and it says "Browser: CDP"
 *   3  agents/openai.yaml interface fields and the default prompt's skill token
 *   4  no spaced em-dash in .md, .yaml or .yml prose
 *   5  the interactive-question tool name appears in no file except this one
 *   6  relative links (including #heading anchors in .md targets) and
 *      backticked repo paths in .md files resolve
 *   7  run-poe.mjs commands and --flags in README.md and SKILL.md match --help
 *   8  UPPER_SNAKE codes in README.md, SKILL.md and references/*.md exist in code
 *   9  schema ids and output filename suffixes in docs exist in code
 *  10  package.json version equals the newest version heading in CHANGELOG.md
 *
 * Usage: node tools/lint-docs.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SELF = "tools/lint-docs.mjs";
const SKILL_NAME = "amazon-poe-downloader";

/** Built from fragments so the literal name exists nowhere in the repo. */
const QUESTION_TOOL = ["Ask", "User", "Question"].join("");
const EM_DASH = "\u2014";

/** Top-level directories whose backticked paths must resolve. */
const KNOWN_TOP_DIRS = ["lib/", "tools/", "test/", "references/", "agents/", ".github/"];

/**
 * Flags documented for programs other than run-poe.mjs. Each entry needs a reason.
 * - --remote-debugging-port, --user-data-dir: Chrome launch flags.
 * - --test: the Node.js test runner.
 * - --help: run-poe.mjs accepts it as an alias of the help command.
 * Flags that format-poe.mjs and tools/discover-poe-endpoints.mjs mention in
 * their own source are added at run time.
 */
const EXTERNAL_FLAGS = new Set(["--remote-debugging-port", "--user-data-dir", "--test", "--help"]);

/**
 * UPPER_SNAKE tokens that docs may use without the code containing them
 * literally. Each entry needs a reason.
 * - The ACCOUNT_SWITCH_<KIND>_<REASON> codes: lib/account-selection.mjs builds
 *   them at run time in pickerSelectionError() from a template string. They are
 *   accepted only while that template is still present in the code.
 */
const CODE_TOKEN_ALLOWLIST = new Set([
  "ACCOUNT_SWITCH_ACCOUNT_AMBIGUOUS",
  "ACCOUNT_SWITCH_ACCOUNT_MISSING",
  "ACCOUNT_SWITCH_PARENT_AMBIGUOUS",
  "ACCOUNT_SWITCH_PARENT_MISSING",
  "ACCOUNT_SWITCH_MARKETPLACE_AMBIGUOUS",
  "ACCOUNT_SWITCH_MARKETPLACE_MISSING",
  "ACCOUNT_SWITCH_MARKETPLACE_TIMEOUT",
]);
const DYNAMIC_CODE_TEMPLATE = "ACCOUNT_SWITCH_${";

const CODE_FILES_FOR_TOKENS = ["run-poe.mjs", "format-poe.mjs", "fetch-poe.js"];
const CODE_FILES_FOR_OUTPUTS = ["format-poe.mjs", "fetch-poe.js", "run-poe.mjs"];

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const errors = [];
const warnings = [];

function fail(check, where, message) {
  errors.push(`[${check}] ${where}: ${message}`);
}

function warn(check, where, message) {
  warnings.push(`[${check}] ${where}: ${message}`);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function listFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
    });
    return [...new Set(out.split("\0").filter(Boolean))]
      .filter((p) => !p.startsWith("_local/") && existsSync(join(ROOT, p)))
      .sort();
  } catch {
    return walk(ROOT, []).sort();
  }
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if ([".git", "node_modules", "_local", "poe-output"].includes(entry.name)) continue;
    if (entry.name.startsWith("poe-endpoint-capture-")) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (entry.isFile()) out.push(relative(ROOT, abs).split(sep).join("/"));
  }
  return out;
}

function read(path) {
  return readFileSync(join(ROOT, path), "utf8");
}

function readIfExists(path) {
  return existsSync(join(ROOT, path)) ? read(path) : null;
}

function exists(path) {
  return existsSync(join(ROOT, path));
}

// ---------------------------------------------------------------------------
// Markdown helpers
// ---------------------------------------------------------------------------

/** Replace fenced code blocks with blank lines so line numbers stay stable. */
function stripFences(text) {
  const lines = text.split("\n");
  let fence = null;
  return lines.map((line) => {
    const open = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
      return "";
    }
    if (open) {
      fence = open[1];
      return "";
    }
    return line;
  }).join("\n");
}

/** Fenced code block bodies, each as { line, text } with 1-based line numbers. */
function fencedBlocks(text) {
  const out = [];
  let fence = null;
  text.split("\n").forEach((line, i) => {
    const open = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
      else out.push({ line: i + 1, text: line });
      return;
    }
    if (open) fence = open[1];
  });
  return out;
}

const INLINE_CODE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;

/** Inline code spans outside fenced blocks, each as { line, text }. */
function inlineSpans(text) {
  const out = [];
  stripFences(text).split("\n").forEach((line, i) => {
    for (const m of line.matchAll(INLINE_CODE)) out.push({ line: i + 1, text: m[2].trim() });
  });
  return out;
}

function stripCode(text) {
  return stripFences(text)
    .split("\n")
    .map((line) => line.replace(INLINE_CODE, ""))
    .join("\n");
}

/** GitHub-style heading anchors of a Markdown document, duplicates suffixed -1, -2. */
function headingSlugs(text) {
  const slugs = new Set();
  const seen = new Map();
  for (const line of stripFences(text).split("\n")) {
    const m = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (!m) continue;
    const base = m[1].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-");
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    slugs.add(n ? `${base}-${n}` : base);
  }
  return slugs;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

/** A YAML scalar that must be quoted. Returns the string, or null when unquoted or malformed. */
function quotedScalar(raw) {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    const inner = value.slice(1, -1);
    if (/(^|[^'])'([^']|$)/.test(inner)) return null;
    return inner.replace(/''/g, "'");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check 1 and 2: SKILL.md
// ---------------------------------------------------------------------------

const ALLOWED_FRONTMATTER_KEYS = new Set(["name", "description", "license"]);

function checkSkill(skill) {
  if (skill === null) {
    fail(1, "SKILL.md", "file is missing");
    fail(2, "SKILL.md", "file is missing");
    return;
  }
  const lines = skill.split("\n");
  if (lines[0].trim() !== "---") {
    fail(1, "SKILL.md:1", "frontmatter must start with a --- line");
  } else {
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    if (end < 0) {
      fail(1, "SKILL.md", "frontmatter has no closing --- line");
    } else {
      checkFrontmatter(lines.slice(1, end));
    }
  }

  const browserLines = lines
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /^Browser: /.test(line));
  if (browserLines.length !== 1 || !/^Browser: CDP\b/.test(browserLines[0].line)) {
    const at = browserLines.map(({ n }) => n).join(", ") || "none";
    fail(2, "SKILL.md", `expected exactly one "Browser: CDP" line, found ${browserLines.length} "Browser:" line(s) (lines: ${at})`);
  }
}

function checkFrontmatter(fm) {
  const keys = new Map();
  let current = null;
  fm.forEach((line, i) => {
    const n = i + 2;
    if (line.trim() === "" || line.trim().startsWith("#")) return;
    const top = line.match(/^([A-Za-z_][\w-]*):(.*)$/);
    if (top) {
      current = top[1];
      if (keys.has(current)) fail(1, `SKILL.md:${n}`, `duplicate frontmatter key "${current}"`);
      keys.set(current, { value: top[2], line: n, continued: false });
      return;
    }
    if (/^\s+\S/.test(line) && current) {
      keys.get(current).continued = true;
      return;
    }
    fail(1, `SKILL.md:${n}`, `unexpected frontmatter line: ${line.trim().slice(0, 60)}`);
  });

  for (const key of keys.keys()) {
    if (!ALLOWED_FRONTMATTER_KEYS.has(key)) {
      fail(1, `SKILL.md:${keys.get(key).line}`, `frontmatter key "${key}" is not allowed (allowed: ${[...ALLOWED_FRONTMATTER_KEYS].join(", ")})`);
    }
  }

  const name = keys.get("name");
  if (!name) {
    fail(1, "SKILL.md", "frontmatter has no name");
  } else {
    const raw = name.value.trim();
    const value = quotedScalar(raw) ?? raw;
    if (name.continued) fail(1, `SKILL.md:${name.line}`, "name must be one line");
    if (value !== SKILL_NAME) fail(1, `SKILL.md:${name.line}`, `name must be "${SKILL_NAME}", found "${value}"`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value.length > 64) {
      fail(1, `SKILL.md:${name.line}`, "name must be lowercase-kebab, at most 64 characters");
    }
    const folder = basename(ROOT);
    if (folder !== value) warn(1, "SKILL.md", `repo folder is "${folder}", skill name is "${value}"`);
  }

  const desc = keys.get("description");
  if (!desc) {
    fail(1, "SKILL.md", "frontmatter has no description");
  } else {
    const value = quotedScalar(desc.value);
    if (desc.continued) fail(1, `SKILL.md:${desc.line}`, "description must be one line");
    if (value === null) {
      fail(1, `SKILL.md:${desc.line}`, "description must be a quoted string");
    } else {
      if (!value.trim()) fail(1, `SKILL.md:${desc.line}`, "description is empty");
      if (value.length >= 300) fail(1, `SKILL.md:${desc.line}`, `description is ${value.length} characters; it must stay under 300`);
      if (/[<>]/.test(value)) fail(1, `SKILL.md:${desc.line}`, "description must not contain < or >");
    }
  }
}

// ---------------------------------------------------------------------------
// Check 3: agents/openai.yaml
// ---------------------------------------------------------------------------

function checkOpenAiYaml(yaml) {
  const where = "agents/openai.yaml";
  if (yaml === null) {
    fail(3, where, "file is missing");
    return;
  }
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => /^interface:\s*$/.test(line));
  if (start < 0) {
    fail(3, where, "no top-level interface: block");
    return;
  }
  const fields = new Map();
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) break;
    const m = line.match(/^\s+([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) fields.set(m[1], { raw: m[2], line: i + 1 });
  }

  const get = (key) => {
    const field = fields.get(key);
    if (!field) {
      fail(3, where, `interface.${key} is missing`);
      return null;
    }
    const value = quotedScalar(field.raw);
    if (value === null) {
      fail(3, `${where}:${field.line}`, `interface.${key} must be a quoted string`);
      return null;
    }
    if (!value.trim()) {
      fail(3, `${where}:${field.line}`, `interface.${key} is empty`);
      return null;
    }
    return { value, line: field.line };
  };

  get("display_name");
  const short = get("short_description");
  if (short && (short.value.length < 25 || short.value.length > 64)) {
    fail(3, `${where}:${short.line}`, `short_description is ${short.value.length} characters, expected 25 to 64`);
  }
  const prompt = get("default_prompt");
  if (prompt) {
    const tokens = [...prompt.value.matchAll(/\$[A-Za-z0-9_-]+/g)].map((m) => m[0]);
    if (tokens.length !== 1 || tokens[0] !== `$${SKILL_NAME}`) {
      fail(3, `${where}:${prompt.line}`, `default_prompt must contain exactly one $token, "$${SKILL_NAME}", found: ${tokens.join(", ") || "none"}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Check 4: spaced em-dash
// ---------------------------------------------------------------------------

function checkEmDash(files) {
  const spaced = new RegExp(`[ \\t]${EM_DASH}[ \\t]`, "g");
  for (const path of files.filter((p) => /\.(md|ya?ml)$/i.test(p))) {
    const text = stripCode(read(path));
    for (const m of text.matchAll(spaced)) {
      fail(4, `${path}:${lineOf(text, m.index)}`, "spaced em-dash; rewrite the sentence");
    }
  }
}

// ---------------------------------------------------------------------------
// Check 5: interactive-question tool name
// ---------------------------------------------------------------------------

function checkQuestionTool(files) {
  for (const path of files) {
    if (path === SELF) continue;
    let text;
    try {
      text = read(path);
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    let index = text.indexOf(QUESTION_TOOL);
    while (index >= 0) {
      fail(5, `${path}:${lineOf(text, index)}`, "names an interactive-question tool that portable skills must not depend on");
      index = text.indexOf(QUESTION_TOOL, index + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Check 6: links and backticked paths
// ---------------------------------------------------------------------------

function checkPaths(files) {
  const basenames = new Set(files.map((p) => basename(p)));
  const dirs = new Set();
  for (const p of files) {
    let d = dirname(p);
    while (d !== "." && d !== "") {
      dirs.add(`${d}/`);
      d = dirname(d);
    }
  }
  const resolves = (target) => {
    const clean = target.replace(/\/+$/, "");
    if (clean === "") return true;
    if (exists(clean)) return true;
    return dirs.has(`${clean}/`);
  };

  for (const path of files.filter((p) => p.toLowerCase().endsWith(".md"))) {
    const text = read(path);
    const base = dirname(path);
    const prose = stripFences(text).split("\n").map((line) => line.replace(INLINE_CODE, ""));

    prose.forEach((line, i) => {
      for (const m of line.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
        const href = m[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) continue;
        const target = decodeURIComponent(href.split("#")[0].split("?")[0]);
        const anchor = href.includes("#") ? decodeURIComponent(href.slice(href.indexOf("#") + 1)) : "";
        const rel = target ? normalize(join(base, target)).split(sep).join("/") : path;
        if (target && (rel.startsWith("..") || !resolves(rel))) {
          fail(6, `${path}:${i + 1}`, `link target "${href}" does not exist`);
          continue;
        }
        if (anchor && rel.toLowerCase().endsWith(".md") && exists(rel) && !headingSlugs(read(rel)).has(anchor)) {
          fail(6, `${path}:${i + 1}`, `link anchor "#${anchor}" matches no heading in ${rel}`);
        }
      }
    });

    for (const span of inlineSpans(text)) {
      for (let token of span.text.split(/\s+/)) {
        if (/[<>{}*$]/.test(token)) continue;
        token = token.replace(/^["'(]+/, "").replace(/["'),;:.]+$/, "").replace(/:\d+(?::\d+)?$/, "");
        if (!token || /^[a-z][a-z0-9+.-]*:\/\//i.test(token)) continue;
        const pathLike = token.includes("/") || /\.(mjs|js|md|json|ya?ml)$/i.test(token);
        if (!pathLike) continue;
        if (KNOWN_TOP_DIRS.some((d) => token.startsWith(d))) {
          if (!resolves(token)) fail(6, `${path}:${span.line}`, `backticked path "${token}" does not exist`);
          continue;
        }
        if (!token.includes("/")) {
          // A bare root document or script name, such as CHANGELOG.md or run-poe.mjs.
          const rootDoc = /^[A-Z][A-Z0-9_-]*\.md$/.test(token);
          const script = /\.(mjs|js)$/i.test(token);
          if ((rootDoc && !exists(token)) || (script && !exists(token) && !basenames.has(token))) {
            fail(6, `${path}:${span.line}`, `backticked file "${token}" does not exist`);
          }
          continue;
        }
        // Explicit relative file paths, such as ../SKILL.md. Runtime folders
        // such as ./poe-output carry no extension and are not repo paths.
        if ((token.startsWith("./") || token.startsWith("../")) && /\.(mjs|js|md|json|ya?ml)$/i.test(token)) {
          const rel = normalize(join(base, token)).split(sep).join("/");
          if (rel.startsWith("..") || !resolves(rel)) fail(6, `${path}:${span.line}`, `backticked path "${token}" does not exist`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Check 7: commands and flags against --help
// ---------------------------------------------------------------------------

function helpOutput() {
  const res = spawnSync(process.execPath, [join(ROOT, "run-poe.mjs"), "--help"], {
    cwd: ROOT, encoding: "utf8", timeout: 30_000, env: { ...process.env, CDP_DEBUG: "" },
  });
  const text = `${res.stdout || ""}${res.stderr || ""}`;
  if (res.status !== 0 || !text.includes("commands:")) return null;
  return text;
}

function helpCommands(help) {
  const commands = new Set();
  let inCommands = false;
  for (const line of help.split("\n")) {
    if (/^commands:\s*$/.test(line)) {
      inCommands = true;
      continue;
    }
    if (!inCommands) continue;
    if (line.trim() === "" || /^\S/.test(line)) break;
    const m = line.match(/^ {2}([a-z][a-z0-9-]*)\b/);
    if (m) commands.add(m[1]);
  }
  return commands;
}

const FLAG = /(?<![\w-])--[a-z][a-z0-9-]*/g;

function sourceFlags() {
  const flags = new Set();
  for (const path of ["format-poe.mjs", "tools/discover-poe-endpoints.mjs"]) {
    const text = readIfExists(path);
    if (text) for (const m of text.matchAll(FLAG)) flags.add(m[0]);
  }
  return flags;
}

function checkHelp(readme, skill) {
  const help = helpOutput();
  if (help === null) {
    fail(7, "run-poe.mjs", "node run-poe.mjs --help failed or printed no commands section");
    return;
  }
  const commands = helpCommands(help);
  const helpFlags = new Set([...help.matchAll(FLAG)].map((m) => m[0]));
  const known = new Set([...helpFlags, ...EXTERNAL_FLAGS, ...sourceFlags()]);

  for (const [name, text] of [["README.md", readme], ["SKILL.md", skill]]) {
    if (text === null) {
      fail(7, name, "file is missing");
      continue;
    }
    // Command references are read from code only, and only in invocation
    // shape ("node run-poe.mjs cmd", or a snippet that starts with
    // "run-poe.mjs cmd"), with shell comments removed. Prose such as
    // "run-poe.mjs and format-poe.mjs" is therefore not mistaken for a command.
    const code = [...fencedBlocks(text), ...inlineSpans(text)];
    const invocation = /(?:\bnode\s+(?:\S*\/)?|^\s*(?:\.\/)?)run-poe\.mjs\s+([a-z][a-z0-9-]*)/g;
    for (const { line, text: raw } of code) {
      const snippet = raw.replace(/(^|\s)#.*$/, "");
      for (const m of snippet.matchAll(invocation)) {
        if (!commands.has(m[1])) fail(7, `${name}:${line}`, `"run-poe.mjs ${m[1]}" is not a command in --help`);
      }
    }
    for (const m of text.matchAll(FLAG)) {
      if (!known.has(m[0])) fail(7, `${name}:${lineOf(text, m.index)}`, `flag ${m[0]} does not appear in run-poe.mjs --help`);
    }
  }

  if (readme !== null) {
    const readmeFlags = new Set([...readme.matchAll(FLAG)].map((m) => m[0]));
    for (const flag of [...helpFlags].sort()) {
      if (!readmeFlags.has(flag)) fail(7, "README.md", `--help lists ${flag} but README.md never mentions it`);
    }
  }
}

// ---------------------------------------------------------------------------
// Check 8: UPPER_SNAKE codes
// ---------------------------------------------------------------------------

function checkCodes(files) {
  const corpusFiles = [
    ...CODE_FILES_FOR_TOKENS,
    ...files.filter((p) => /^lib\/[^/]+\.mjs$/.test(p)),
  ];
  const corpus = corpusFiles.map((p) => readIfExists(p) ?? "").join("\n");
  const docs = ["README.md", "SKILL.md", ...files.filter((p) => /^references\/[^/]+\.md$/.test(p))];
  const cache = new Map();
  const inCode = (token) => {
    if (!cache.has(token)) cache.set(token, new RegExp(`(?<![A-Za-z0-9_])${token}(?![A-Za-z0-9_])`).test(corpus));
    return cache.get(token);
  };
  for (const path of docs) {
    const text = readIfExists(path);
    if (text === null) continue;
    for (const m of text.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) {
      const token = m[0];
      if (inCode(token)) continue;
      if (CODE_TOKEN_ALLOWLIST.has(token) && corpus.includes(DYNAMIC_CODE_TEMPLATE)) continue;
      fail(8, `${path}:${lineOf(text, m.index)}`, `${token} does not occur in ${corpusFiles.join(", ")}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Check 9: schema ids and output filename suffixes
// ---------------------------------------------------------------------------

function checkOutputs(files) {
  const schemaCorpus = ["format-poe.mjs", "fetch-poe.js"].map((p) => readIfExists(p) ?? "").join("\n");
  const outputCorpus = CODE_FILES_FOR_OUTPUTS.map((p) => readIfExists(p) ?? "").join("\n");
  // Some names are built as `_${env.kind}.json`, so a kind passed to the
  // envelope builder in fetch-poe.js is also a valid suffix.
  const kinds = new Set(
    [...(readIfExists("fetch-poe.js") ?? "").matchAll(/_pfEnvelope\(\s*"([a-z-]+)"/g)].map((m) => m[1]),
  );

  for (const path of files.filter((p) => p.toLowerCase().endsWith(".md"))) {
    const text = read(path);
    for (const m of text.matchAll(/\bamazon-poe-downloader\.[a-z0-9-]+\.v\d+\b/g)) {
      if (!schemaCorpus.includes(m[0])) {
        fail(9, `${path}:${lineOf(text, m.index)}`, `schema id ${m[0]} does not occur in format-poe.mjs or fetch-poe.js`);
      }
    }
    for (const m of text.matchAll(/(?<![A-Za-z0-9])_([A-Za-z][A-Za-z0-9-]*)\.(\{json,csv\}|\{csv,json\}|json|csv)\b/g)) {
      const exts = m[2].startsWith("{") ? ["json", "csv"] : [m[2]];
      for (const ext of exts) {
        const suffix = `_${m[1]}.${ext}`;
        if (outputCorpus.includes(suffix)) continue;
        if (ext === "json" && kinds.has(m[1])) continue;
        fail(9, `${path}:${lineOf(text, m.index)}`, `output suffix ${suffix} does not occur in ${CODE_FILES_FOR_OUTPUTS.join(", ")}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Check 10: package version and changelog
// ---------------------------------------------------------------------------

function checkVersion() {
  const pkgText = readIfExists("package.json");
  const changelog = readIfExists("CHANGELOG.md");
  if (pkgText === null) {
    fail(10, "package.json", "file is missing");
    return;
  }
  if (changelog === null) {
    fail(10, "CHANGELOG.md", "file is missing");
    return;
  }
  let version;
  try {
    version = JSON.parse(pkgText).version;
  } catch (err) {
    fail(10, "package.json", `not valid JSON: ${err.message}`);
    return;
  }
  const heading = changelog
    .split("\n")
    .map((line, i) => ({ line, n: i + 1, m: line.match(/^##\s+\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?/) }))
    .find(({ m }) => m);
  if (!heading) {
    fail(10, "CHANGELOG.md", 'no "## <version>" heading');
    return;
  }
  if (heading.m[1] !== version) {
    fail(10, `CHANGELOG.md:${heading.n}`, `first version heading is ${heading.m[1]}, package.json has ${version}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const files = listFiles().filter((p) => {
    try {
      return statSync(join(ROOT, p)).isFile();
    } catch {
      return false;
    }
  });
  const skill = readIfExists("SKILL.md");
  const readme = readIfExists("README.md");

  checkSkill(skill);
  checkOpenAiYaml(readIfExists("agents/openai.yaml"));
  checkEmDash(files);
  checkQuestionTool(files);
  checkPaths(files);
  checkHelp(readme, skill);
  checkCodes(files);
  checkOutputs(files);
  checkVersion();

  for (const w of warnings) process.stdout.write(`lint-docs: WARN ${w}\n`);
  if (errors.length === 0) {
    process.stdout.write(`lint-docs: clean (${files.length} files, 10 checks)\n`);
    return 0;
  }
  for (const e of errors) process.stderr.write(`lint-docs: ${e}\n`);
  process.stderr.write(`lint-docs: ${errors.length} problem(s)\n`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
