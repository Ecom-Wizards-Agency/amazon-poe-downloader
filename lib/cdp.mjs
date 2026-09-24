/*
 * Minimal Chrome DevTools Protocol client with zero dependencies (Node 22+
 * global WebSocket and fetch). It drives any Chrome started with
 * --remote-debugging-port=<port> and runs expressions in the page's real main
 * world, where the page's own fetch and logged-in session are available.
 *
 * This module never launches, restarts or manages a browser. Start Chrome
 * yourself (see launchHint) and point createCdpEndpoint at its host and port.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// CDP_DEBUG=1 prints one stderr line per protocol call with its round-trip time,
// which is how a hang gets localized to a method without touching the code.
const DEBUG = /^(1|true|yes|on)$/i.test(String(process.env.CDP_DEBUG || ""));

// A live CDP session over one target's WebSocket.
export class Session {
  constructor(ws, { targetId = null } = {}) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.targetId = targetId;
  }

  static async open(webSocketDebuggerUrl, { timeoutMs = 10000 } = {}) {
    if (typeof WebSocket !== "function") {
      throw new Error("Node.js 22+ is required (global WebSocket)");
    }
    const ws = new WebSocket(webSocketDebuggerUrl);
    // A destroyed target's ws endpoint can accept the TCP connection and then
    // never complete the upgrade, firing neither onopen nor onerror.
    await new Promise((res, rej) => {
      const timer = setTimeout(() => {
        // reject before close: closing a half-open socket fires onerror synchronously
        rej(new Error(`CDP WebSocket handshake timed out after ${timeoutMs} ms`));
        try { ws.close(); } catch (_) {}
      }, timeoutMs);
      ws.onopen = () => { clearTimeout(timer); res(); };
      ws.onerror = () => { clearTimeout(timer); rej(new Error("CDP WebSocket failed to open")); };
    });
    const targetId = /\/devtools\/page\/([^/?#]+)/.exec(webSocketDebuggerUrl)?.[1] || null;
    const s = new Session(ws, { targetId });
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && s.pending.has(msg.id)) {
        const { resolve, reject } = s.pending.get(msg.id); s.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        const subs = s._subs || {};
        for (const fn of [...(subs[msg.method] || []), ...(subs["*"] || [])]) {
          try {
            const ret = fn(msg.params, msg.method);
            // An async subscriber's rejection must not become an unhandled one.
            if (ret && typeof ret.catch === "function") ret.catch(() => {});
          } catch (_) { /* subscriber errors must not kill the socket */ }
        }
        // A detached/crashed target keeps its socket open but will never answer
        // another command (an account switch navigating the tab does exactly
        // this). Fail every in-flight call now, with a name, instead of hanging.
        if (msg.method === "Inspector.detached" || msg.method === "Inspector.targetCrashed") {
          const message = `CDP target detached${msg.params?.reason ? `: ${msg.params.reason}` : ""}`;
          s._rejectPending(message);
        }
      }
    };
    const transportFailed = (message) => s._rejectPending(message);
    ws.onclose = () => transportFailed("CDP WebSocket closed");
    ws.onerror = () => transportFailed("CDP WebSocket error");
    return s;
  }

  _rejectPending(message) {
    const pending = [...this.pending.values()];
    this.pending.clear();
    const error = message instanceof Error ? message : new Error(message);
    for (const { reject } of pending) reject(error);
  }

  // Streaming event hook for long-running listeners. `method` may be "*" for all
  // events. Subscriber errors, thrown or rejected, are swallowed so they cannot
  // kill the socket or the process.
  subscribe(method, fn) {
    this._subs = this._subs || {};
    (this._subs[method] = this._subs[method] || []).push(fn);
  }

  // Direct commands get a deadline; longer operations can pass their own budget.
  async send(method, params = {}, { timeoutMs = 30000 } = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      // Node's built-in global WebSocket does not keep the event loop alive while
      // idly awaiting an inbound frame, so a slow Runtime.evaluate (awaitPromise
      // for a multi-second page fetch, e.g. POE data) lets the process exit early
      // with "unsettled top-level await" (exit 13) before Chrome replies. A ref'd
      // keepalive timer holds the loop open until the response lands.
      const keepalive = setInterval(() => {}, 1 << 30);
      const t0 = DEBUG ? Date.now() : 0;
      let timer;
      const done = (fn) => (v) => {
        clearInterval(keepalive);
        if (timer) clearTimeout(timer);
        if (DEBUG) console.error(`[cdp] ${method} → ${Date.now() - t0} ms`);
        fn(v);
      };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      if (timeoutMs) {
        timer = setTimeout(() => {
          const entry = this.pending.get(id);
          if (!entry) return;
          this.pending.delete(id);
          entry.reject(new Error(`CDP ${method} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      }
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (error) {
        const entry = this.pending.get(id);
        this.pending.delete(id);
        entry.reject(error);
      }
    });
  }

  close() {
    this._rejectPending("CDP session closed");
    try { this.ws.close(); } catch (_) {}
  }
}

// Full desktop viewport on every programmatically created tab.
//
// A tab created over CDP does not always inherit the window size, and a page
// that renders at 800x600 can get a narrow layout that differs from the one
// the user sees, including where the account picker places its buttons.
// Setting it per tab makes the size independent of how Chrome happened to be
// started. Failure is non-fatal, because a data fetch does not care about
// layout.
export const DESKTOP_VIEWPORT = { width: 1920, height: 1080, deviceScaleFactor: 1 };

export async function setDesktopViewport(session, viewport = DESKTOP_VIEWPORT) {
  try {
    await session.send("Emulation.setDeviceMetricsOverride", { mobile: false, ...viewport });
  } catch (_) { /* older target or a page that refuses emulation: keep going */ }
}

// Run an async expression in the page main world and return its (JSON) value.
export async function evaluate(session, expression, timeoutMs = 120000) {
  let hardTimer;
  const hardTimeoutMs = timeoutMs + 5000;
  const timeout = new Promise((_, reject) => {
    hardTimer = setTimeout(() => {
      reject(new Error(`CDP Runtime.evaluate timed out after ${hardTimeoutMs} ms`));
      session.close();
    }, hardTimeoutMs);
  });
  let r;
  try {
    // The hard timer is armed BEFORE Runtime.enable so the whole call is
    // budgeted. A mid-navigation target that never answers Runtime.enable
    // would otherwise hang the process forever here.
    r = await Promise.race([
      (async () => {
        await session.send("Runtime.enable", {}, { timeoutMs: 10000 });
        return session.send("Runtime.evaluate", {
          expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs,
        }, { timeoutMs: hardTimeoutMs });
      })(),
      timeout,
    ]);
  } finally {
    clearTimeout(hardTimer);
  }
  if (r.exceptionDetails) {
    throw new Error("page evaluate threw: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result?.value;
}

// Human-readable instructions for starting a Chrome that this module can reach.
export function launchHint(port = 9222) {
  return [
    `Start Chrome with a debug port and a dedicated profile, then retry:`,
    `  macOS:   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=${port} --user-data-dir="$HOME/.poe-chrome"`,
    `  Linux:   google-chrome --remote-debugging-port=${port} --user-data-dir="$HOME/.poe-chrome"`,
    `  Windows: & "$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=${port} --user-data-dir="$env:LOCALAPPDATA\\poe-chrome"`,
    `Chrome 136+ ignores --remote-debugging-port on the default profile, so the separate --user-data-dir is required.`,
    `Sign in to Seller Central in that window once; the profile keeps the login.`,
    `To reach a different endpoint, pass --port/--host or set CDP_PORT/CDP_HOST.`,
  ].join("\n");
}

// One DevTools endpoint (host + port). Nothing here is global state, so several
// endpoints can coexist in one process.
export function createCdpEndpoint({ host = "127.0.0.1", port = 9222 } = {}) {
  const hostName = String(host);
  const portNumber = Number(port);
  const urlHost = hostName.includes(":") && !hostName.startsWith("[") ? `[${hostName}]` : hostName;
  const base = `http://${urlHost}:${portNumber}`;

  // The DevTools HTTP endpoints answer at once; a stalled endpoint fails fast.
  const HTTP_TIMEOUT_MS = 5000;

  async function httpJson(path) {
    const r = await fetch(base + path, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`CDP HTTP ${r.status} on ${path}`);
    return r.json();
  }

  async function version() {
    try {
      return await httpJson("/json/version");
    } catch (cause) {
      const error = new Error(
        `Cannot reach Chrome DevTools at ${base} (${cause.message}).\n${launchHint(portNumber)}`,
        { cause },
      );
      error.code = "CDP_UNREACHABLE";
      throw error;
    }
  }

  async function listPages() {
    return (await httpJson("/json/list")).filter((t) => t.type === "page");
  }

  async function browserSession() {
    const { webSocketDebuggerUrl } = await version();
    if (!webSocketDebuggerUrl) throw new Error(`No browser webSocketDebuggerUrl at ${base}/json/version`);
    return Session.open(webSocketDebuggerUrl);
  }

  // Create a fresh page at `url` through the browser-level endpoint, so the
  // user's existing tabs are left alone. background: true keeps the new tab
  // from stealing focus while someone is using the window.
  async function createPage(url = "about:blank", { background = true } = {}) {
    const browser = await browserSession();
    let targetId = null;
    try {
      ({ targetId } = await browser.send("Target.createTarget", { url, background }));
      for (let i = 0; i < 40; i++) {
        const page = (await listPages()).find((p) => p.id === targetId);
        if (page && page.webSocketDebuggerUrl) {
          const session = await Session.open(page.webSocketDebuggerUrl);
          await setDesktopViewport(session);
          return { targetId, session, url };
        }
        await sleep(100);
      }
      throw new Error(`created target ${targetId} never appeared in the page list`);
    } catch (error) {
      if (targetId) {
        await browser.send("Target.closeTarget", { targetId }, { timeoutMs: 5000 }).catch(() => {});
      }
      throw error;
    } finally {
      browser.close();
    }
  }

  // Close a target. The HTTP endpoint is tried first; if it refuses, fall back
  // to Target.closeTarget over the browser-level socket.
  async function closePage(targetId) {
    try {
      const r = await fetch(`${base}/json/close/${encodeURIComponent(targetId)}`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      await r.text().catch(() => {});
      if (r.ok) return { targetId, via: "http" };
    } catch (_) { /* fall through to the protocol route */ }
    const browser = await browserSession();
    try {
      await browser.send("Target.closeTarget", { targetId });
      return { targetId, via: "protocol" };
    } finally {
      browser.close();
    }
  }

  return { host: hostName, port: portNumber, base, httpJson, version, listPages, createPage, closePage };
}

export { sleep };
