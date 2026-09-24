/*
 * CDP client tests against an in-process fake DevTools endpoint.
 *
 * The Session tests cover a target that stops answering: a live socket whose
 * target goes silent (for example mid-navigation) must reject within its
 * budget, never hang the process. The endpoint tests run on the fake's random port,
 * which proves no port is special-cased.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";

import { createServer } from "node:net";

import { Session, createCdpEndpoint, evaluate, launchHint } from "../lib/cdp.mjs";
import { startFakeCdp } from "./helpers/fake-cdp.mjs";

test("evaluate rejects within budget when Runtime.enable is never answered", { concurrency: false }, async () => {
  const fake = await startFakeCdp({
    targets: [{ id: "T1", url: "https://sellercentral.amazon.com/home", behavior: { neverReply: ["Runtime.enable"] } }],
  });
  try {
    const s = await Session.open(fake.wsUrl("T1"));
    const t0 = Date.now();
    // budget 100ms -> hard timer at 5100ms; the call must reject, not wait forever
    await assert.rejects(evaluate(s, "1+1", 100), /timed out/);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 9000, `rejected in ${elapsed} ms, expected well under 9 s`);
  } finally {
    await fake.close();
  }
});

test("Session.send honors an opt-in timeoutMs", { concurrency: false }, async () => {
  const fake = await startFakeCdp({
    targets: [{ id: "T1", url: "about:blank", behavior: { neverReply: ["Foo.bar"] } }],
  });
  try {
    const s = await Session.open(fake.wsUrl("T1"));
    const t0 = Date.now();
    await assert.rejects(s.send("Foo.bar", {}, { timeoutMs: 300 }), /CDP Foo\.bar timed out after 300 ms/);
    assert.ok(Date.now() - t0 < 2000);
    s.close();
  } finally {
    await fake.close();
  }
});

test("Session.send without timeoutMs still waits for a slow reply", { concurrency: false }, async () => {
  const fake = await startFakeCdp({
    targets: [{ id: "T1", url: "about:blank", behavior: { delayMs: 1200, results: { "Foo.slow": { ok: true } } } }],
  });
  try {
    const s = await Session.open(fake.wsUrl("T1"));
    const r = await s.send("Foo.slow");
    assert.deepEqual(r, { ok: true });
    s.close();
  } finally {
    await fake.close();
  }
});

test("Session.open rejects when the WebSocket handshake stalls", { concurrency: false }, async () => {
  const fake = await startFakeCdp({
    targets: [{ id: "T1", url: "about:blank", behavior: { stallUpgrade: true } }],
  });
  try {
    await assert.rejects(Session.open(fake.wsUrl("T1"), { timeoutMs: 300 }), /handshake timed out/);
  } finally {
    await fake.close();
  }
});

test("Session.open rejects when the target refuses the upgrade", { concurrency: false }, async () => {
  const fake = await startFakeCdp({
    targets: [{ id: "T1", url: "about:blank", behavior: { refuseUpgrade: true } }],
  });
  try {
    await assert.rejects(Session.open(fake.wsUrl("T1")), /failed to open/);
  } finally {
    await fake.close();
  }
});

test("Inspector.detached rejects every pending send with a named reason", { concurrency: false }, async () => {
  const fake = await startFakeCdp({
    targets: [{ id: "T1", url: "about:blank", behavior: { detachOn: "Runtime.enable" } }],
  });
  try {
    const s = await Session.open(fake.wsUrl("T1"));
    await assert.rejects(s.send("Runtime.enable"), /CDP target detached: target_closed/);
    s.close();
  } finally {
    await fake.close();
  }
});

test("unanswered direct sends default to 30 seconds and clear their keepalive", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const clearKeepalive = t.mock.method(globalThis, "clearInterval");
  const s = new Session({ send() {}, close() {} });
  t.after(() => s.close());
  const pending = s.send("Page.enable");
  const rejected = assert.rejects(pending, /CDP Page\.enable timed out after 30000 ms/);
  t.mock.timers.tick(29999);
  assert.equal(s.pending.size, 1);
  assert.equal(clearKeepalive.mock.callCount(), 0);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(s.pending.size, 0);
  assert.equal(clearKeepalive.mock.callCount(), 1);
});

test("an explicit longer send timeout survives the default deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const s = new Session({ send() {}, close() {} });
  t.after(() => s.close());
  const rejected = assert.rejects(s.send("Foo.long", {}, { timeoutMs: 60000 }),
    /CDP Foo\.long timed out after 60000 ms/);
  t.mock.timers.tick(30000);
  assert.equal(s.pending.size, 1);
  t.mock.timers.tick(30000);
  await rejected;
  assert.equal(s.pending.size, 0);
});

test("evaluate can return after the direct-send deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let dispatched;
  const evaluating = new Promise((resolve) => { dispatched = resolve; });
  const s = new Session({ close() {}, send(payload) {
    const command = JSON.parse(payload);
    if (command.method === "Runtime.enable") {
      const entry = s.pending.get(command.id);
      s.pending.delete(command.id);
      entry.resolve({});
    } else dispatched(command);
  } });
  t.after(() => s.close());
  const result = evaluate(s, "longPromise()", 120000);
  const command = await evaluating;
  assert.equal(command.params.timeout, 120000);
  t.mock.timers.tick(30001);
  assert.equal(s.pending.size, 1);
  const entry = s.pending.get(command.id);
  s.pending.delete(command.id);
  entry.resolve({ result: { value: "finished" } });
  assert.equal(await result, "finished");
});

test("an unanswered evaluate keeps its own hard deadline and closes the session", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let dispatched;
  const evaluating = new Promise((resolve) => { dispatched = resolve; });
  const ws = { closed: false, close() { this.closed = true; }, send(payload) {
    const command = JSON.parse(payload);
    if (command.method === "Runtime.enable") {
      const entry = s.pending.get(command.id);
      s.pending.delete(command.id);
      entry.resolve({});
    } else dispatched();
  } };
  const s = new Session(ws);
  t.after(() => s.close());
  const rejected = assert.rejects(evaluate(s, "neverSettles()", 60000),
    /CDP Runtime\.evaluate timed out after 65000 ms/);
  await evaluating;
  t.mock.timers.tick(64999);
  assert.equal(s.pending.size, 1);
  assert.equal(ws.closed, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(s.pending.size, 0);
  assert.equal(ws.closed, true);
});

test("a timed-out direct send lets the process exit without closing the session", async () => {
  // Accelerate only the 30-second default in the child; the keepalive is real.
  const source = `
    import { Session } from ${JSON.stringify(new URL("../lib/cdp.mjs", import.meta.url).href)};
    const originalTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 30000 ? 20 : ms, ...args);
    const s = new Session({ send() {}, close() {} });
    try { await s.send("Foo.missing"); process.exitCode = 1; }
    catch (error) {
      if (!/CDP Foo.missing timed out after 30000 ms/.test(error.message)) throw error;
      if (s.pending.size) throw new Error("pending command leaked");
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let killed = false;
  const watchdog = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, 3000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(killed, false, "timeout left a referenced keepalive running");
    assert.equal(code, 0, stderr);
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("launchHint names the port, a dedicated profile and the override knobs", () => {
  const hint = launchHint(9555);
  assert.match(hint, /--remote-debugging-port=9555/);
  assert.match(hint, /--user-data-dir="\$HOME\/\.poe-chrome"/);
  assert.match(hint, /--user-data-dir="\$env:LOCALAPPDATA\\poe-chrome"/);
  assert.match(hint, /Chrome 136\+/);
  assert.match(hint, /CDP_PORT\/CDP_HOST/);
  assert.equal(hint.split("\n").filter((line) => line.includes("--remote-debugging-port=")).length, 3);
});

test("createCdpEndpoint defaults to 127.0.0.1:9222 and brackets IPv6 hosts", () => {
  const local = createCdpEndpoint();
  assert.equal(local.host, "127.0.0.1");
  assert.equal(local.port, 9222);
  assert.equal(local.base, "http://127.0.0.1:9222");
  assert.equal(createCdpEndpoint({ host: "::1", port: "9333" }).base, "http://[::1]:9333");
  assert.equal(createCdpEndpoint({ host: "[::1]", port: 9333 }).base, "http://[::1]:9333");
});

test("version() reads /json/version from the fake on its random port", { concurrency: false }, async () => {
  const fake = await startFakeCdp();
  try {
    const cdp = createCdpEndpoint({ port: fake.port });
    assert.equal(cdp.base, `http://127.0.0.1:${fake.port}`);
    const info = await cdp.version();
    assert.equal(info.Browser, "FakeChrome/1.0");
    assert.equal(info.webSocketDebuggerUrl, `ws://127.0.0.1:${fake.port}/devtools/browser/fake`);
  } finally {
    await fake.close();
  }
});

test("an unreachable port yields CDP_UNREACHABLE with the launch hint", async () => {
  const port = await unusedPort();
  const cdp = createCdpEndpoint({ port });
  await assert.rejects(cdp.version(), (error) => {
    assert.equal(error.code, "CDP_UNREACHABLE");
    assert.ok(error.message.includes(`--remote-debugging-port=${port}`), error.message);
    assert.ok(error.message.includes("--user-data-dir"), error.message);
    assert.ok(error.message.includes(`http://127.0.0.1:${port}`), error.message);
    return true;
  });
  // createPage goes through version() first, so it fails the same way.
  await assert.rejects(cdp.createPage("about:blank"), { code: "CDP_UNREACHABLE" });
});

test("listPages filters out non-page targets", { concurrency: false }, async () => {
  const fake = await startFakeCdp({
    targets: [
      { id: "P1", url: "https://example.com/a" },
      { id: "SW1", type: "service_worker", url: "https://example.com/sw.js" },
      { id: "P2", type: "page", url: "https://example.com/b" },
      { id: "BG1", type: "background_page", url: "chrome-extension://x/bg.html" },
    ],
  });
  try {
    const pages = await createCdpEndpoint({ port: fake.port }).listPages();
    assert.deepEqual(pages.map((p) => p.id), ["P1", "P2"]);
    assert.ok(pages.every((p) => p.type === "page"));
  } finally {
    await fake.close();
  }
});

test("createPage opens a background target with a desktop viewport and a usable session", { concurrency: false }, async () => {
  const fake = await startFakeCdp({ targets: [{ id: "EXISTING", url: "https://example.com/" }] });
  try {
    const cdp = createCdpEndpoint({ port: fake.port });
    const { targetId, session, url } = await cdp.createPage("https://example.com/new");
    try {
      assert.equal(url, "https://example.com/new");
      assert.equal(session.targetId, targetId);
      const create = fake.sent.find((c) => c.method === "Target.createTarget");
      assert.equal(create.targetId, "(browser)");
      assert.deepEqual(create.params, { url: "https://example.com/new", background: true });
      const viewport = fake.sent.find((c) => c.method === "Emulation.setDeviceMetricsOverride");
      assert.equal(viewport.targetId, targetId);
      assert.deepEqual(viewport.params, { mobile: false, width: 1920, height: 1080, deviceScaleFactor: 1 });
      // The session answers real commands on the new target.
      assert.equal(await evaluate(session, "1+1", 2000), null);
      assert.ok(fake.sent.some((c) => c.targetId === targetId && c.method === "Runtime.evaluate"));
      assert.deepEqual((await cdp.listPages()).map((p) => p.id), ["EXISTING", targetId]);
    } finally {
      session.close();
    }
  } finally {
    await fake.close();
  }
});

test("createPage honours an explicit foreground request", { concurrency: false }, async () => {
  const fake = await startFakeCdp();
  try {
    const { session } = await createCdpEndpoint({ port: fake.port }).createPage(undefined, { background: false });
    session.close();
    const create = fake.sent.find((c) => c.method === "Target.createTarget");
    assert.deepEqual(create.params, { url: "about:blank", background: false });
  } finally {
    await fake.close();
  }
});

test("closePage closes over HTTP and records the id", { concurrency: false }, async () => {
  const fake = await startFakeCdp({ targets: [{ id: "T1", url: "about:blank" }, { id: "T2", url: "about:blank" }] });
  try {
    const cdp = createCdpEndpoint({ port: fake.port });
    assert.deepEqual(await cdp.closePage("T1"), { targetId: "T1", via: "http" });
    assert.deepEqual(fake.closed, ["T1"]);
    assert.deepEqual((await cdp.listPages()).map((p) => p.id), ["T2"]);
    assert.equal(fake.sent.some((c) => c.method === "Target.closeTarget"), false);
  } finally {
    await fake.close();
  }
});

test("closePage falls back to Target.closeTarget when HTTP close refuses", { concurrency: false }, async () => {
  const fake = await startFakeCdp();
  try {
    const cdp = createCdpEndpoint({ port: fake.port });
    await assert.rejects(cdp.closePage("MISSING"), /No target with given id found/);
    const fallback = fake.sent.find((c) => c.method === "Target.closeTarget");
    assert.equal(fallback.targetId, "(browser)");
    assert.deepEqual(fallback.params, { targetId: "MISSING" });
    assert.deepEqual(fake.closed, []);
  } finally {
    await fake.close();
  }
});
