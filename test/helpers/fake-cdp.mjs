/*
 * Minimal scriptable fake CDP endpoint for tests: an HTTP server with
 * /json/version, /json/list, /json/close plus a hand-rolled RFC6455 WebSocket
 * server (Node has no built-in ws server). Each target declares a `behavior`
 * that scripts how its socket misbehaves, so a target that stops answering in
 * the middle of a navigation is reproducible without a browser:
 *
 *   refuseUpgrade  destroy the socket on upgrade (dead target: /json/list shows
 *                  it, Session.open fails)
 *   stallUpgrade   accept TCP, never complete the handshake
 *   neverReply     swallow these methods (target stopped answering mid-switch)
 *   detachOn       emit Inspector.detached instead of answering this method
 *   delayMs        delay every reply (slow but healthy target)
 *   results        map of method -> response `result` object (or fn(params));
 *                  defaults: Runtime.evaluate -> {result:{value:null}}, else {}
 *
 * Targets may also carry `type` (default "page"). The browser-level socket
 * answers Target.createTarget (via `onCreateTarget(params)` or a default page
 * target) and Target.closeTarget. /json/close/<id> and Target.closeTarget
 * remove the target and push its id onto the returned `closed` array; an
 * unknown id gets a 404 or a protocol error, as in Chrome.
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeFrame(text) {
  const payload = Buffer.from(text, "utf8");
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

// Streaming client->server frame parser (client frames are masked).
function makeFrameParser(onText, onClose = () => {}) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2)); off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.subarray(off + maskLen + len);
      if (opcode === 0x1) onText(payload.toString("utf8"));
      if (opcode === 0x8) onClose();
    }
  };
}

function defaultResult(method) {
  return method === "Runtime.evaluate" ? { result: { value: null } } : {};
}

export async function startFakeCdp({ targets = [], onCreateTarget = null } = {}) {
  const sockets = new Set();
  const sent = []; // every command any client sent: {targetId, method, params}
  const closed = []; // ids removed through /json/close or Target.closeTarget
  let createdCount = 0;
  const removeTarget = (id) => {
    const index = targets.findIndex((t) => t.id === id);
    if (index < 0) return false;
    targets.splice(index, 1);
    closed.push(id);
    return true;
  };

  const server = createServer((req, res) => {
    if (req.url.startsWith("/json/version")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        Browser: "FakeChrome/1.0", "Protocol-Version": "1.3",
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake`,
      }));
      return;
    }
    if (req.url.startsWith("/json/list") || req.url === "/json") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(targets.map((t) => ({
        id: t.id,
        type: t.type || "page",
        title: t.title || "Fake page",
        url: t.url,
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${t.id}`,
      }))));
      return;
    }
    if (req.url.startsWith("/json/close/")) {
      const id = decodeURIComponent(req.url.slice("/json/close/".length).split("?")[0]);
      if (removeTarget(id)) { res.end("Target is closing"); return; }
      res.statusCode = 404;
      res.end(`No such target id: ${id}`);
      return;
    }
    res.statusCode = 404;
    res.end("unknown");
  });

  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    // Browser-level endpoint: enough of Target.createTarget for createPage().
    // `onCreateTarget(params)` returns a target definition that joins the list;
    // without it a plain page target at params.url is created.
    if (req.url.includes("/devtools/browser/")) {
      const key = req.headers["sec-websocket-key"];
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${createHash("sha1").update(key + WS_MAGIC).digest("base64")}\r\n\r\n`,
      );
      socket.on("data", makeFrameParser((text) => {
        const msg = JSON.parse(text);
        sent.push({ targetId: "(browser)", method: msg.method, params: msg.params });
        if (msg.method === "Target.createTarget") {
          const def = onCreateTarget
            ? onCreateTarget(msg.params)
            : { id: `CREATED${++createdCount}`, url: msg.params?.url || "about:blank" };
          targets.push(def);
          socket.write(encodeFrame(JSON.stringify({ id: msg.id, result: { targetId: def.id } })));
          return;
        }
        if (msg.method === "Target.closeTarget") {
          const ok = removeTarget(msg.params?.targetId);
          socket.write(encodeFrame(JSON.stringify(ok
            ? { id: msg.id, result: { success: true } }
            : { id: msg.id, error: { code: -32602, message: "No target with given id found" } })));
          return;
        }
        socket.write(encodeFrame(JSON.stringify({ id: msg.id, result: {} })));
      }, () => socket.end(Buffer.from([0x88, 0x00]))));
      return;
    }
    const target = targets.find((t) => req.url.endsWith(`/devtools/page/${t.id}`));
    const b = (target && target.behavior) || {};
    if (b.refuseUpgrade) { socket.destroy(); return; }
    if (b.stallUpgrade) return; // TCP open, handshake never completes
    const key = req.headers["sec-websocket-key"];
    const accept = createHash("sha1").update(key + WS_MAGIC).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on("data", makeFrameParser((text) => {
      const msg = JSON.parse(text);
      sent.push({ targetId: target ? target.id : null, method: msg.method, params: msg.params });
      if (target && msg.method === "Page.navigate" && msg.params?.url) {
        target.url = msg.params.url;
      }
      if ((b.neverReply || []).includes(msg.method)) return;
      if (b.detachOn === msg.method) {
        socket.write(encodeFrame(JSON.stringify({ method: "Inspector.detached", params: { reason: "target_closed" } })));
        return;
      }
      const reply = () => {
        if (socket.destroyed) return;
        const spec = (b.results || {})[msg.method];
        const result = typeof spec === "function" ? spec(msg.params) : (spec ?? defaultResult(msg.method));
        socket.write(encodeFrame(JSON.stringify({ id: msg.id, result })));
      };
      b.delayMs ? setTimeout(reply, b.delayMs) : reply();
    }, () => socket.end(Buffer.from([0x88, 0x00]))));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    port,
    sent,
    closed,
    targets,
    wsUrl: (targetId) => `ws://127.0.0.1:${port}/devtools/page/${targetId}`,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
