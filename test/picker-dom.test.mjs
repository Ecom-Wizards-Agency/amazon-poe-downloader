import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { inspectPickerSelection } from "../lib/account-selection.mjs";

// Exercise actual browser DOM/visibility semantics with an isolated temporary
// Chrome profile. No Amazon session, external requests or existing tabs are used.
test("picker scopes visible options to the exact seller in real Chromium DOM", t => {
  const binary = process.env.CHROME_BIN || "google-chrome";
  const version = spawnSync(binary, ["--version"], { encoding: "utf8" });
  if (version.error?.code === "ENOENT") return t.skip("Chrome is required for the DOM fixture test");
  const root = mkdtempSync(join(tmpdir(), "poe-picker-dom-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "fixture.html");
  writeFileSync(file, `<!doctype html><html><body><div id="fixture"></div><pre id="result"></pre><script>
    const inspect = ${inspectPickerSelection.toString()};
    const profile = { accountName: "Example Brand", marketplaceLabel: "United States" };
    const button = (name, extra = "") => '<button class="full-page-account-switcher-account-details" '+extra+'>'+name+'</button>';
    const group = (name, options, extra = "") => '<div class="full-page-account-switcher-account">'+button(name,extra)+options+'</div>';
    const fixture = document.getElementById("fixture");
    const results = {};
    const run = (name, html) => { fixture.innerHTML = html; results[name] = inspect(profile, "marketplace"); };
    run("one", group("Example Brand", button("United States")));
    run("otherSeller", group("Example Brand", button("Canada"))+group("Other",button("United States")));
    run("hiddenDuplicate", group("Example Brand", button("United States")+button("United States",'style="display:none"')));
    run("hiddenParent", group("Example Brand", '<div style="display:none">'+button("United States")+'</div>'));
    run("duplicate", group("Example Brand", button("United States")+button("United States")));
    run("current", group("Example Brand", button("United States (current)")));
    run("similarSeller", group("Example Brand Plus",button("United States")));
    run("duplicateSeller", group("Example Brand",button("United States"))+group("Example Brand",button("United States")));
    run("expandedPending", group("Example Brand", '<div aria-busy="true" style="width:20px;height:20px"></div>', 'aria-expanded="true"'));
    document.getElementById("result").textContent = JSON.stringify(results);
  </script></body></html>`);
  const chrome = spawnSync(binary, ["--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", `--user-data-dir=${join(root, "profile")}`, "--dump-dom", pathToFileURL(file).href],
  { encoding: "utf8", timeout: 20000, maxBuffer: 1024 * 1024 });
  assert.equal(chrome.status, 0, chrome.stderr);
  const match = chrome.stdout.match(/<pre id="result">([^<]+)<\/pre>/);
  assert.ok(match, "fixture must execute and return results");
  const results = JSON.parse(match[1]);
  assert.equal(results.one.count, 1);
  assert.ok(Number.isFinite(results.one.x));
  assert.equal(results.otherSeller.count, 0);
  assert.equal(results.hiddenDuplicate.count, 1);
  assert.equal(results.hiddenParent.count, 0);
  assert.equal(results.duplicate.count, 2);
  assert.equal(results.duplicate.x, undefined);
  assert.equal(results.current.current, true);
  assert.equal(results.similarSeller.accountCount, 0);
  assert.equal(results.duplicateSeller.accountCount, 2);
  assert.equal(results.expandedPending.expanded, true);
  assert.equal(results.expandedPending.loading, true);
});
