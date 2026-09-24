// The public tree must run on plain Node: only node: built-ins and relative
// imports that stay inside the repository, and no npm dependencies.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatEnvelope } from "../format-poe.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set([".git", "node_modules", "poe-output"]);

function sourceFiles(dir = ROOT) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith("poe-endpoint-capture-")) out.push(...sourceFiles(path.join(dir, entry.name)));
    } else if (/\.(mjs|js)$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// Static imports, re-exports, dynamic import() and require() with a literal
// specifier. "from" may be followed directly by the quote, and a statement may
// follow a comment on the same line. Template-literal specifiers count too.
const Q = "[\"'`]";
const NQ = "[^\"'`]";
function importSpecifiers(source) {
  const specs = [];
  const patterns = [
    new RegExp(`(?<![\\w$.])import\\s*(?:${NQ.slice(0, -1)};]*?\\s*from\\s*)?${Q}(${NQ}+)${Q}`, "g"),
    new RegExp(`(?<![\\w$.])export\\s+${NQ.slice(0, -1)};]*?\\s*from\\s*${Q}(${NQ}+)${Q}`, "g"),
    new RegExp(`\\bimport\\(\\s*${Q}(${NQ}+)${Q}\\s*\\)`, "g"),
    new RegExp(`\\brequire\\(\\s*${Q}(${NQ}+)${Q}`, "g"),
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) specs.push(match[1]);
  return specs;
}

// import() whose argument is not one plain string literal cannot be checked
// statically, so it is a problem in itself. An empty "import()" is prose in a
// comment or string (as a call it would not parse), so it is skipped.
function computedImports(source) {
  const out = [];
  for (const match of source.matchAll(/\bimport\(\s*/g)) {
    const rest = source.slice(match.index + match[0].length);
    if (rest.startsWith(")")) continue;
    if (!new RegExp(`^${Q}[^"'\`$]+${Q}\\s*\\)`).test(rest)) out.push(source.slice(match.index, match.index + 40).split("\n")[0]);
  }
  return out;
}

test("every import is a node: built-in or a relative path inside the repository", () => {
  const files = sourceFiles();
  assert.ok(files.length >= 5, `expected source files, found ${files.length}`);
  const problems = [];
  let checked = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const call of computedImports(source)) problems.push(`${path.relative(ROOT, file)}: ${call} (computed import())`);
    for (const spec of importSpecifiers(source)) {
      checked += 1;
      const where = `${path.relative(ROOT, file)}: ${spec}`;
      if (spec.startsWith("node:")) continue;
      if (!spec.startsWith("./") && !spec.startsWith("../")) { problems.push(`${where} (not node: or relative)`); continue; }
      const target = path.resolve(path.dirname(file), spec);
      if (path.relative(ROOT, target).startsWith("..")) problems.push(`${where} (outside the repository)`);
      else if (!fs.existsSync(target)) problems.push(`${where} (does not exist)`);
    }
  }
  assert.ok(checked > 0, "no imports were found; the scanner is broken");
  assert.deepEqual(problems, []);
});

// The fixtures are assembled at run time so this file's own source never
// contains the import statements it tests.
const IMP = "imp" + "ort";
test("the import scanner catches compact and CommonJS forms", () => {
  assert.deepEqual(importSpecifiers(`${IMP} x from"pkg-a";\nexport * from"pkg-b";\nconst y = ` + "req" + 'uire("pkg-c");'),
    ["pkg-a", "pkg-b", "pkg-c"]);
});

test("the import scanner catches template literals, trailing comments and computed import()", () => {
  assert.deepEqual(importSpecifiers(`await ${IMP}(\`pkg-d\`);\n/* x */ ${IMP} y from "pkg-e";`), ["pkg-e", "pkg-d"]);
  assert.equal(computedImports(`const n = "pkg-f"; await ${IMP}(n);`).length, 1);
  assert.equal(computedImports(`await ${IMP}(\`pkg-\${n}\`);`).length, 1);
  assert.equal(computedImports(`await ${IMP}("node:net");`).length, 0);
});

test("no source file builds a require function", () => {
  const offenders = sourceFiles().filter((file) => /\bcreateRequire\b/.test(fs.readFileSync(file, "utf8"))
    && path.relative(ROOT, file) !== path.join("test", "portability.test.mjs"));
  assert.deepEqual(offenders.map((file) => path.relative(ROOT, file)), []);
});

test("package.json declares no dependencies", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "bundleDependencies"]) {
    assert.equal(pkg[key], undefined, `package.json must not declare ${key}`);
  }
  assert.equal(pkg.type, "module");
  assert.equal(fs.existsSync(path.join(ROOT, "package-lock.json")), false, "no lockfile");
  assert.equal(fs.existsSync(path.join(ROOT, "node_modules")), false, "no node_modules");
});

test("fetch-poe.js emits the envelope schema that format-poe.mjs accepts", () => {
  const fetchSource = fs.readFileSync(path.join(ROOT, "fetch-poe.js"), "utf8");
  const formatSource = fs.readFileSync(path.join(ROOT, "format-poe.mjs"), "utf8");
  const emitted = /function _pfEnvelope[\s\S]*?schemaVersion:\s*"([^"]+)"/.exec(fetchSource)?.[1];
  const accepted = /const ENVELOPE_SCHEMA = "([^"]+)"/.exec(formatSource)?.[1];
  assert.ok(emitted, "fetch-poe.js _pfEnvelope schemaVersion not found");
  assert.equal(emitted, accepted);
  const files = formatEnvelope({ schemaVersion: emitted, kind: "merchant-niches", marketplace: "ATVPDKIKX0DER",
    capturedAt: "2026-01-02T00:00:00Z", merchantInfo: [] });
  assert.equal(files.length, 1);
});

test("fetch-poe.js does not touch window globals", () => {
  const fetchSource = fs.readFileSync(path.join(ROOT, "fetch-poe.js"), "utf8");
  assert.equal(fetchSource.includes("window."), false);
});
