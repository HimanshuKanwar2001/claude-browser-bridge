// Shared WebSocket client for workflow scripts.
// Usage: import { connect } from "./bridge-client.js";
//        const { call, close } = await connect();
//        const tabs = await call("list_tabs");

import WebSocket from "ws";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname, userInfo } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const PORT = Number(process.env.BRIDGE_PORT) || 8787;

function getToken() {
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN;
  const paths = [
    join(homedir(), ".claude", "browser-bridge-token"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "server", ".bridge-token"),
  ];
  for (const p of paths) {
    try { return readFileSync(p, "utf8").trim(); } catch {}
  }
  // Deterministic fallback
  return createHash("sha256")
    .update(`claude-browser-bridge:${userInfo().username}@${hostname()}:${PORT}`)
    .digest("hex");
}

export async function connect() {
  const token = getToken();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    let id = 0;
    const pending = new Map();

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", token, role: "relay" }));
      setTimeout(() => {
        if (ws.readyState === 1) {
          resolve({
            call: (method, params = {}, timeoutMs = 20000) => new Promise((res, rej) => {
              const myId = ++id;
              const timer = setTimeout(() => { pending.delete(myId); rej(new Error(`Timeout: ${method}`)); }, timeoutMs);
              pending.set(myId, (msg) => { clearTimeout(timer); msg.ok ? res(msg.result) : rej(new Error(msg.error)); });
              ws.send(JSON.stringify({ type: "call", id: myId, method, params }));
            }),
            close: () => ws.close(),
          });
        }
      }, 500);
    });
    ws.on("message", (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.type === "result" && pending.has(msg.id)) {
        const handler = pending.get(msg.id);
        pending.delete(msg.id);
        handler(msg);
      }
    });
    ws.on("close", () => reject(new Error("Connection closed — is the bridge server running?")));
    ws.on("error", (e) => reject(new Error("Connection failed: " + e.message)));
  });
}
