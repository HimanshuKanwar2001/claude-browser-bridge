// Combined MCP stdio server (for Claude Code) + WebSocket bridge (for the
// Chrome extension). Claude tool calls are proxied to the extension, which
// executes them on the user's real, logged-in tabs.
//
// Multi-session: the first Claude Code session to start binds the port and
// "owns" the bridge; later sessions detect EADDRINUSE and relay their tool
// calls through the owner. If the owner exits, a relay takes over the port.

import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import WebSocket, { WebSocketServer } from "ws";

const PORT = Number(process.env.BRIDGE_PORT) || 8787;

let TOKEN = null;
try {
  TOKEN = readFileSync(new URL("./.bridge-token", import.meta.url), "utf8").trim();
} catch {}
if (!TOKEN) {
  console.error(
    "[bridge] WARNING: server/.bridge-token is missing — run `node gen-token.js` " +
      "in the server directory. Refusing all extension connections until then."
  );
}

// --- WebSocket bridge (owner or relay) -------------------------------------

const NO_EXT_MSG =
  "Chrome extension is not connected. Make sure Chrome is open with the " +
  "'Claude Code Browser Bridge' extension loaded (chrome://extensions). " +
  "Click the extension icon to check its connection status.";

let mode = "starting"; // "owner" | "relay"
let extension = null; // owner mode: the authenticated extension socket
let upstream = null; // relay mode: connection to the owning session
const pending = new Map(); // id -> { resolve, reject, timer }
let nextId = 1;

function addPending(id, resolve, reject, timeoutMs, label) {
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`${label} timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  pending.set(id, { resolve, reject, timer });
}

function settle(id, msg) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timer);
  msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error || "unknown bridge error"));
}

function rejectAllPending(reason) {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
    pending.delete(id);
  }
}

// --- owner mode -------------------------------------------------------------

function setupOwner(wss) {
  mode = "owner";
  console.error(`[bridge] owner of ws://127.0.0.1:${PORT}`);
  wss.on("error", (e) => console.error("[bridge] server error:", e.message));

  wss.on("connection", (ws) => {
    let role = null; // "extension" | "relay"
    const authTimer = setTimeout(() => {
      if (!role) ws.close();
    }, 3000);

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (!role) {
        if (msg.type === "auth" && TOKEN && msg.token === TOKEN) {
          role = msg.role === "relay" ? "relay" : "extension";
          clearTimeout(authTimer);
          if (role === "extension") {
            extension = ws;
            console.error("[bridge] extension connected (authenticated)");
          } else {
            console.error("[bridge] relay session connected");
          }
        } else {
          console.error("[bridge] rejected connection with bad/missing auth token");
          ws.close();
        }
        return;
      }

      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (role === "extension") {
        settle(msg.id, msg);
      } else if (msg.type === "call") {
        callExtensionDirect(msg.method, msg.params || {})
          .then((result) =>
            ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result }))
          )
          .catch((e) =>
            ws.send(
              JSON.stringify({ type: "result", id: msg.id, ok: false, error: String(e?.message || e) })
            )
          );
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      if (extension === ws) {
        extension = null;
        console.error("[bridge] extension disconnected");
      }
    });
  });
}

function callExtensionDirect(method, params = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (!extension || extension.readyState !== 1) {
      return reject(new Error(NO_EXT_MSG));
    }
    const id = nextId++;
    addPending(id, resolve, reject, timeoutMs, `Extension call '${method}'`);
    extension.send(JSON.stringify({ id, method, params }));
  });
}

// --- relay mode --------------------------------------------------------------

function connectRelay() {
  mode = "relay";
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "auth", token: TOKEN, role: "relay" }));
    upstream = ws;
    console.error(`[bridge] relay mode: forwarding through the session that owns port ${PORT}`);
  });
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === "result") settle(msg.id, msg);
  });
  ws.on("close", () => {
    if (upstream === ws) upstream = null;
    rejectAllPending("Bridge connection lost (owner session ended?) — retry the call.");
    setTimeout(establish, 1000); // owner may be gone: try to take over the port
  });
  ws.on("error", () => {
    try {
      ws.close();
    } catch {}
  });
}

function callViaRelay(method, params = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (!upstream || upstream.readyState !== 1) {
      return reject(new Error("Bridge is reconnecting — retry in a few seconds."));
    }
    const id = nextId++;
    addPending(id, resolve, reject, timeoutMs, `Bridge call '${method}'`);
    upstream.send(JSON.stringify({ type: "call", id, method, params }));
  });
}

// --- entry point --------------------------------------------------------------

function callExtension(method, params = {}) {
  return mode === "owner"
    ? callExtensionDirect(method, params)
    : callViaRelay(method, params);
}

function establish() {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
  wss.once("listening", () => setupOwner(wss));
  wss.once("error", (e) => {
    if (e.code === "EADDRINUSE") {
      connectRelay();
    } else {
      console.error("[bridge] failed to start:", e.message);
      setTimeout(establish, 3000);
    }
  });
}

establish();

// --- MCP server exposed to Claude Code -------------------------------------

const BATCH_TOOL = {
  name: "batch",
  description:
    "Execute multiple tool calls in a single round-trip for speed. Pass an array of {name, arguments} objects. All calls run in parallel and results are returned in the same order. Use this when you need to call 2+ tools that don't depend on each other.",
  inputSchema: {
    type: "object",
    properties: {
      calls: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Tool name" },
            arguments: { type: "object", description: "Tool arguments" },
          },
          required: ["name"],
        },
        description: "Array of tool calls to execute in parallel",
      },
    },
    required: ["calls"],
  },
};

const TAB_ID = {
  tab_id: {
    type: "number",
    description:
      "Optional tab id from list_tabs. Defaults to the tab pinned with select_tab, else the active tab.",
  },
};

const TOOLS = [
  {
    name: "list_tabs",
    description:
      "List all open browser tabs with their ids, titles and URLs. The pinned target (if any) has selected:true.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "select_tab",
    description:
      "Pin a tab as the sticky target for all subsequent tools, and visually mark it (orange border, 'Claude Code' badge, \u{1F916} title prefix in the tab strip) so the user can see exactly which tab is being driven. Without tab_id it pins the currently active tab. Pass clear=true to unpin and remove the marker. Use this first when several tabs show the same site.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: { type: "number", description: "Tab to pin (from list_tabs)" },
        clear: { type: "boolean", description: "Unpin and remove the visual marker" },
      },
    },
  },
  {
    name: "snapshot",
    description:
      "Snapshot the visible interactive elements of the page (buttons, links, inputs, etc.) as ref-tagged lines like: ref_12 <button> \"Sign in\". Pass the ref to click/fill — far more reliable than guessing CSS selectors. Refs are invalidated by navigation or a new snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        max_elements: { type: "number", description: "Cap on elements returned (default 300)" },
        ...TAB_ID,
      },
    },
  },
  {
    name: "get_page_text",
    description: "Get URL, title and visible text of the active tab (or a specific tab).",
    inputSchema: { type: "object", properties: { ...TAB_ID } },
  },
  {
    name: "get_html",
    description:
      "Get the outerHTML of an element by CSS selector, or the whole document if no selector is given. For finding things to interact with, prefer the snapshot tool.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" }, ...TAB_ID },
    },
  },
  {
    name: "wait_for",
    description:
      "Wait until a CSS selector and/or a text string appears on the page (polls every 200ms). Use after click/navigate on SPAs to know when the page settled. Example: {selector: \".results\", text: \"42 items\"}.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector to wait for" },
        text: {
          type: "string",
          description: "Text that must appear (inside the selector if given, else anywhere on the page)",
        },
        timeout_ms: { type: "number", description: "Default 10000, max 15000" },
        ...TAB_ID,
      },
    },
  },
  {
    name: "click",
    description:
      "Click an element identified by a snapshot ref (e.g. \"ref_12\", preferred) or a CSS selector. Automatically waits up to wait_ms (default 5000) for the element to appear, so it is safe right after navigation.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref from snapshot, e.g. \"ref_12\" (preferred)" },
        selector: { type: "string", description: "CSS selector (fallback if you have no snapshot)" },
        wait_ms: { type: "number", description: "How long to wait for the element (default 5000)" },
        ...TAB_ID,
      },
    },
  },
  {
    name: "fill",
    description:
      "Fill an input/textarea/contenteditable identified by a snapshot ref (preferred) or CSS selector, firing input/change events so frameworks like React notice. Auto-waits for the element like click.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref from snapshot, e.g. \"ref_12\" (preferred)" },
        selector: { type: "string", description: "CSS selector (fallback if you have no snapshot)" },
        value: { type: "string" },
        wait_ms: { type: "number", description: "How long to wait for the element (default 5000)" },
        ...TAB_ID,
      },
      required: ["value"],
    },
  },
  {
    name: "eval",
    description: "Evaluate JavaScript in the page's main world and return the result as a string.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string" }, ...TAB_ID },
      required: ["code"],
    },
  },
  {
    name: "get_console",
    description:
      "Get recorded console messages, uncaught errors (with stack traces) and unhandled rejections — recorded continuously since page load. Pass clear=true to reset the buffer (useful before reproducing a bug).",
    inputSchema: {
      type: "object",
      properties: { clear: { type: "boolean" }, ...TAB_ID },
    },
  },
  {
    name: "get_network",
    description:
      "Get recorded fetch/XHR requests (method, url, status, duration, redacted request headers; response bodies are captured for failed requests). Recorded continuously since page load. Filter with url_contains and only_failures; clear=true resets the buffer.",
    inputSchema: {
      type: "object",
      properties: {
        url_contains: { type: "string", description: "Only requests whose URL contains this substring, e.g. \"/api/\"" },
        only_failures: { type: "boolean", description: "Only network errors and HTTP status >= 400" },
        clear: { type: "boolean" },
        ...TAB_ID,
      },
    },
  },
  {
    name: "screenshot",
    description: "Take a PNG screenshot of the visible area of the tab.",
    inputSchema: { type: "object", properties: { ...TAB_ID } },
  },
  {
    name: "navigate",
    description: "Navigate the current tab to a URL (reuses the tab, does not open a new one).",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, ...TAB_ID },
      required: ["url"],
    },
  },
  {
    name: "hover",
    description: "Hover over an element by snapshot ref or CSS selector. Fires mouseover/mouseenter events so tooltips and dropdowns appear.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref from snapshot" },
        selector: { type: "string", description: "CSS selector" },
        ...TAB_ID,
      },
    },
  },
  {
    name: "select_option",
    description: "Select one or more options in a <select> dropdown by value or visible text.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        selector: { type: "string" },
        values: { type: "array", items: { type: "string" }, description: "Option values or text to select" },
        ...TAB_ID,
      },
      required: ["values"],
    },
  },
  {
    name: "press_key",
    description: "Press a key or key combination (e.g. 'Enter', 'Escape', 'Tab', 'a'). Modifiers: ['Control','Shift','Alt','Meta'].",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key name (e.g. 'Enter', 'ArrowDown', 'a')" },
        modifiers: { type: "array", items: { type: "string" }, description: "Modifier keys to hold" },
        ...TAB_ID,
      },
      required: ["key"],
    },
  },
  {
    name: "scroll",
    description: "Scroll the page or a specific element. Direction: up/down/left/right. Default 400px.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Scroll direction (default 'down')" },
        amount: { type: "number", description: "Pixels to scroll (default 400)" },
        ref: { type: "string", description: "Scroll inside this element (from snapshot)" },
        selector: { type: "string", description: "CSS selector of scrollable container" },
        ...TAB_ID,
      },
    },
  },
  {
    name: "go_back",
    description: "Navigate the tab back in history (like clicking the browser back button).",
    inputSchema: { type: "object", properties: { ...TAB_ID } },
  },
  {
    name: "go_forward",
    description: "Navigate the tab forward in history.",
    inputSchema: { type: "object", properties: { ...TAB_ID } },
  },
  {
    name: "reload",
    description: "Reload the current tab. Pass bypass_cache=true for a hard reload.",
    inputSchema: {
      type: "object",
      properties: {
        bypass_cache: { type: "boolean", description: "Bypass browser cache (hard reload)" },
        ...TAB_ID,
      },
    },
  },
  {
    name: "new_tab",
    description: "Open a new browser tab, optionally with a URL.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
    },
  },
  {
    name: "close_tab",
    description: "Close the specified tab (or the active/pinned tab).",
    inputSchema: { type: "object", properties: { ...TAB_ID } },
  },
  {
    name: "get_cookies",
    description: "Get cookies for the current tab's URL. Sensitive cookie values (session/auth/token) are redacted.",
    inputSchema: { type: "object", properties: { ...TAB_ID } },
  },
  {
    name: "get_storage",
    description: "Read localStorage or sessionStorage from the tab. Pass key_filter to search for specific keys.",
    inputSchema: {
      type: "object",
      properties: {
        storage_type: { type: "string", enum: ["local", "session"], description: "Which storage (default 'local')" },
        key_filter: { type: "string", description: "Only return keys containing this substring" },
        ...TAB_ID,
      },
    },
  },
  {
    name: "upload_file",
    description: "Upload a file to an <input type='file'> element by ref or CSS selector. Uses chrome.debugger to set the file path.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref from snapshot" },
        selector: { type: "string", description: "CSS selector for the file input" },
        file_path: { type: "string", description: "Absolute path to the file to upload" },
        ...TAB_ID,
      },
      required: ["file_path"],
    },
  },
  {
    name: "diagnose",
    description:
      "PREFERRED first tool — returns snapshot + console errors + failed network requests + recent API responses + CAPTCHA/iframe detection + localStorage keys, ALL in a single call. Use this instead of calling snapshot + get_console + get_network separately. Replaces 4 round-trips with 1.",
    inputSchema: {
      type: "object",
      properties: {
        max_elements: { type: "number", description: "Max snapshot elements (default 200)" },
        ...TAB_ID,
      },
    },
  },
  {
    name: "get_page_info",
    description:
      "Quick diagnostic: returns URL, title, recent console errors, recent failed network requests, and CAPTCHA detection — all in a single call. Use this first when investigating a page issue.",
    inputSchema: { type: "object", properties: { ...TAB_ID } },
  },
];

const server = new Server(
  { name: "browser-bridge", version: "0.3.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [BATCH_TOOL, ...TOOLS] }));

function formatResult(name, result) {
  if (name === "screenshot" && result?.dataUrl) {
    const base64 = result.dataUrl.replace(/^data:image\/png;base64,/, "");
    return {
      content: [
        { type: "image", data: base64, mimeType: "image/png" },
        { type: "text", text: `Screenshot of ${result.url}` },
      ],
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    // Batch: run multiple calls in one round-trip through the extension.
    if (name === "batch") {
      const calls = args?.calls;
      if (!Array.isArray(calls) || !calls.length) {
        return { isError: true, content: [{ type: "text", text: "'calls' array is required" }] };
      }
      const results = await callExtension("batch", { calls: calls.map(c => ({ method: c.name, params: c.arguments || {} })) });
      const formatted = results.map((r, i) => {
        const label = `[${i}] ${calls[i].name}`;
        if (!r.ok) return `${label}: ERROR — ${r.error}`;
        if (calls[i].name === "screenshot" && r.result?.dataUrl) return `${label}: (screenshot captured)`;
        return `${label}: ${JSON.stringify(r.result)}`;
      });
      return { content: [{ type: "text", text: formatted.join("\n\n") }] };
    }

    const result = await callExtension(name, args || {});
    return formatResult(name, result);
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: String(e?.message || e) }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[mcp] ready on stdio");
