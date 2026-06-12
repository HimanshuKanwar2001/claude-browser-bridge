// Browser Bridge Lite — MCP server with 8 basic tools.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer } from "ws";

const PORT = 8787;
let extension = null;
const pending = new Map();
let nextId = 1;

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
wss.on("connection", (ws) => {
  extension = ws;
  console.error("[bridge-lite] extension connected");
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); clearTimeout(p.timer); msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error)); }
  });
  ws.on("close", () => { if (extension === ws) extension = null; });
});

function callExtension(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!extension || extension.readyState !== 1) return reject(new Error("Extension not connected"));
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Timeout")); }, 20000);
    pending.set(id, { resolve, reject, timer });
    extension.send(JSON.stringify({ id, method, params }));
  });
}

const TAB_ID = { tab_id: { type: "number", description: "Optional tab id. Defaults to active tab." } };

const TOOLS = [
  { name: "list_tabs", description: "List all open browser tabs.", inputSchema: { type: "object", properties: {} } },
  { name: "snapshot", description: "Snapshot visible interactive elements as ref-tagged lines.", inputSchema: { type: "object", properties: { max_elements: { type: "number" }, ...TAB_ID } } },
  { name: "get_page_text", description: "Get visible text of the active tab.", inputSchema: { type: "object", properties: { ...TAB_ID } } },
  { name: "get_html", description: "Get outerHTML of an element by CSS selector.", inputSchema: { type: "object", properties: { selector: { type: "string" }, ...TAB_ID } } },
  { name: "click", description: "Click an element by ref or CSS selector.", inputSchema: { type: "object", properties: { ref: { type: "string" }, selector: { type: "string" }, ...TAB_ID } } },
  { name: "fill", description: "Fill an input by ref or CSS selector.", inputSchema: { type: "object", properties: { ref: { type: "string" }, selector: { type: "string" }, value: { type: "string" }, ...TAB_ID }, required: ["value"] } },
  { name: "screenshot", description: "Take a PNG screenshot of the visible tab.", inputSchema: { type: "object", properties: { ...TAB_ID } } },
  { name: "navigate", description: "Navigate the current tab to a URL.", inputSchema: { type: "object", properties: { url: { type: "string" }, ...TAB_ID }, required: ["url"] } },
];

const server = new Server({ name: "browser-bridge-lite", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const result = await callExtension(req.params.name, req.params.arguments || {});
    if (req.params.name === "screenshot" && result?.dataUrl) {
      return { content: [
        { type: "image", data: result.dataUrl.replace(/^data:image\/png;base64,/, ""), mimeType: "image/png" },
        { type: "text", text: `Screenshot of ${result.url}` },
      ]};
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: String(e?.message || e) }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[bridge-lite] ready on stdio; ws://127.0.0.1:" + PORT);
