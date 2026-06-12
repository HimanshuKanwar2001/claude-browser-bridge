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

// F2 FIX: Re-read token on every auth attempt so `init` token regeneration
// takes effect without restarting the server.
const TOKEN_PATH = new URL("./.bridge-token", import.meta.url);
function readToken() {
  try {
    return readFileSync(TOKEN_PATH, "utf8").trim();
  } catch {
    return null;
  }
}
if (!readToken()) {
  console.error(
    "[bridge] WARNING: server/.bridge-token is missing — run `claude-browser-bridge init` " +
      "or `node gen-token.js`. Refusing all extension connections until then."
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
        if (msg.type === "auth" && readToken() && msg.token === readToken()) {
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
    ws.send(JSON.stringify({ type: "auth", token: readToken(), role: "relay" }));
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

const HELP_TOOL = {
  name: "browser_bridge_help",
  description:
    "Returns the complete usage guide for all 57 browser-bridge tools. Call this ONCE at the start of any session where you need to use browser tools, to learn the optimal workflows and avoid slow anti-patterns.",
  inputSchema: { type: "object", properties: {} },
};

const HELP_TEXT = `# Claude Browser Bridge — 58 Tools

## WHICH TOOL FIRST? (decision tree)
- Investigating a bug → diagnose (gives snapshot + errors + network + API responses in ONE call)
- Fixing CSS/visual → batch([screenshot, get_styles({selector:".target"}), get_html({selector:".target"})])
- Performance check → batch([performance_trace, get_load_timeline, heap_snapshot_summary])
- Accessibility audit → batch([get_accessibility_tree, check_contrast({selector:".text"})])
- Reading page content → eval (specific data) or get_page_text (all text)
- Interacting with page → diagnose first (get refs), then click/fill using refs
- Opening a URL for research → new_tab (NEVER navigate away from the app tab)
- Don't know → diagnose (covers 80% of needs)

## 10 CRITICAL RULES:
1. diagnose FIRST, always. ONE call replaces snapshot+get_console+get_network.
2. batch for parallel. 2+ independent calls → always batch. Every sequential call wastes 2-3 seconds.
3. select_tab once, never again. Pin target tab at start, stop passing tab_id.
4. new_tab for research. NEVER navigate the app tab to docs/Google.
5. screenshot after EVERY code edit. Never claim a fix works without seeing it.
6. inject_css before editing files. Test CSS live, confirm with screenshot, THEN write to file.
7. eval for state. React state, Redux store, variables — faster than parsing page text.
8. get_styles for CSS. Never guess computed values — read them.
9. 3 failed attempts = search web. new_tab + Google search. Stop guessing.
10. Use refs from diagnose/snapshot for click/fill. Never guess CSS selectors.

## KEY WORKFLOWS:

Visual/CSS Fix:
  batch([screenshot, get_styles, get_html]) → inject_css({css:"..."}) → screenshot → if good, write to file

Bug Investigation:
  diagnose → read errors → batch([get_grouped_console, get_network]) → fix → screenshot → verify

Performance Audit:
  batch([performance_trace, get_load_timeline, heap_snapshot_summary])

Page Interaction:
  diagnose → fill({ref:"ref_3", value:"..."}) → click({ref:"ref_0"}) → wait_for({text:"Success"})

Multi-tab Research:
  select_tab(app) → new_tab(docs) → get_page_text → close_tab → continue on app

Error State Testing:
  mock_network({url_pattern:"/api/cart", status_code:500}) → reload → screenshot

Regression Testing:
  record_actions → reproduce → stop → fix → replay_actions → screenshot

Before/After Comparison:
  screenshot (save dataUrl) → make changes → visual_diff({before_dataUrl:"..."})

## ALL 58 TOOLS BY CATEGORY:
Core: diagnose, batch, select_tab, snapshot, eval, screenshot, full_page_screenshot, get_page_text, get_html, get_page_info, browser_bridge_help
Interaction: click, fill, hover, scroll, press_key, select_option, upload_file, highlight_element
Navigation: navigate, new_tab, close_tab, go_back, go_forward, reload, list_tabs, wait_for
Debugging: get_console, get_grouped_console, get_network, search_network_bodies, get_styles, get_cookies, get_storage, get_clipboard, watch_dom_changes, generate_selector
Performance: performance_trace, heap_snapshot_summary, get_load_timeline
Accessibility: get_accessibility_tree, check_contrast
Emulation: emulate_device, network_throttle, set_geolocation, toggle_dark_mode
Testing: visual_diff, inject_css, mock_network, record_actions, replay_actions, handle_dialog
Productivity: save_form_profile, load_form_profile, save_tab_session, restore_tab_session, edit_cookie, export_pdf
`;

const BATCH_TOOL = {
  name: "batch",
  description:
    "Execute multiple tool calls in a single round-trip for speed. Pass an array of {name, arguments} objects. All calls run in parallel and results are returned in the same order. Use this when you need to call 2+ tools that don't depend on each other. ALWAYS prefer this over sequential calls.",
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
      "⚡ CALL THIS FIRST on any page. Returns snapshot (interactive elements with refs for click/fill) + console errors with stacks + failed network requests with response bodies + recent successful API responses + CAPTCHA detection + cross-origin iframe warnings + localStorage keys — ALL in ONE call. Replaces 4-5 sequential tool calls. After this, use refs from the snapshot to click/fill elements.",
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
  {
    name: "get_styles",
    description: "Get computed CSS styles (fonts, colors, spacing, layout) for any element by ref or selector. Essential for frontend/design debugging.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" }, selector: { type: "string" },
        properties: { type: "array", items: { type: "string" }, description: "Specific CSS properties to return (default: common layout/typography/color properties)" },
        ...TAB_ID,
      },
    },
  },
  {
    name: "get_accessibility_tree",
    description: "Get the full accessibility (a11y) tree from Chrome — ARIA roles, names, states. Use for accessibility auditing and WCAG compliance checks.",
    inputSchema: {
      type: "object",
      properties: {
        max_depth: { type: "number", description: "Tree depth (default 5)" },
        max_nodes: { type: "number", description: "Max nodes to return (default 300)" },
        ...TAB_ID,
      },
    },
  },
  {
    name: "performance_trace",
    description: "Capture Core Web Vitals (LCP, FCP, CLS) and performance metrics — DOM load time, resource count, transfer size, long task count. One-call performance audit.",
    inputSchema: { type: "object", properties: { ...TAB_ID } },
  },
  {
    name: "heap_snapshot_summary",
    description: "Get JS heap memory usage (used/total/limit MB) and DOM node count. Quick memory health check without a full heap snapshot.",
    inputSchema: { type: "object", properties: { ...TAB_ID } },
  },
  {
    name: "emulate_device",
    description: "Emulate a device viewport — 'mobile' (iPhone 375x812), 'tablet' (iPad 768x1024), 'desktop' (1440x900), or custom width/height. Pass clear=true or device='reset' to restore.",
    inputSchema: {
      type: "object",
      properties: {
        device: { type: "string", enum: ["mobile", "tablet", "desktop", "reset"], description: "Preset device" },
        width: { type: "number" }, height: { type: "number" },
        device_scale: { type: "number" }, mobile: { type: "boolean" },
        user_agent: { type: "string" }, clear: { type: "boolean" },
        ...TAB_ID,
      },
    },
  },
  {
    name: "network_throttle",
    description: "Throttle network speed — 'slow-3g', 'fast-3g', '4g', 'offline', or 'none' to disable. Use for testing loading states and slow connections.",
    inputSchema: {
      type: "object",
      properties: {
        preset: { type: "string", enum: ["slow-3g", "fast-3g", "4g", "offline", "none"] },
        ...TAB_ID,
      },
      required: ["preset"],
    },
  },
  {
    name: "full_page_screenshot",
    description: "Capture the ENTIRE scrollable page as a PNG, not just the visible viewport. Uses Chrome DevTools Protocol.",
    inputSchema: { type: "object", properties: { ...TAB_ID } },
  },
  {
    name: "export_pdf",
    description: "Export the current page as a PDF document.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["A4", "Letter", "Legal"], description: "Page format (default A4)" },
        ...TAB_ID,
      },
    },
  },
  {
    name: "watch_dom_changes",
    description: "Watch for DOM mutations (added/removed nodes, attribute changes) for a specified duration. Use to see what changes when an action is performed.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the subtree to watch (default: body)" },
        duration_ms: { type: "number", description: "How long to watch in ms (default 5000, max 15000)" },
        ...TAB_ID,
      },
    },
  },
  {
    name: "check_contrast",
    description: "Check WCAG color contrast ratio for a text element — returns fg/bg colors, contrast ratio, and AA/AAA pass/fail. Essential for accessibility.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" }, selector: { type: "string" }, ...TAB_ID,
      },
    },
  },
  {
    name: "handle_dialog",
    description: "Set up an auto-handler for the next JavaScript dialog (alert/confirm/prompt). Use before triggering an action that shows a dialog.",
    inputSchema: {
      type: "object",
      properties: {
        accept: { type: "boolean", description: "Accept (true) or dismiss (false) the dialog (default true)" },
        prompt_text: { type: "string", description: "Text to enter for prompt() dialogs" },
        ...TAB_ID,
      },
    },
  },
  {
    name: "get_clipboard",
    description: "Read the current clipboard text content.",
    inputSchema: { type: "object", properties: { ...TAB_ID } },
  },
  // ====================== TIER 1 ======================
  {
    name: "visual_diff",
    description: "Compare a 'before' screenshot with the current page state. Returns diff percentage, pixel count, and a diff image with changes highlighted in red. Use: take a screenshot, make changes, then call visual_diff with before_dataUrl set to the first screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        before_dataUrl: { type: "string", description: "data:image/png;base64,... from a previous screenshot call" },
        ...TAB_ID,
      },
      required: ["before_dataUrl"],
    },
  },
  {
    name: "inject_css",
    description: "Inject CSS directly into the live page WITHOUT rebuilding. Instant visual feedback for CSS fixes. Pass css=null with the same id to remove it. Use this to test CSS changes before writing them to the actual file.",
    inputSchema: {
      type: "object",
      properties: {
        css: { type: "string", description: "CSS to inject (null to remove)" },
        id: { type: "string", description: "Style element ID (default '__claude_inject_css__'). Use different IDs for multiple injections." },
        ...TAB_ID,
      },
    },
  },
  {
    name: "record_actions",
    description: "Start or stop recording user interactions (clicks, input changes). Call with no params to start recording. Call with stop=true to get the recorded action list. Replay the list with replay_actions.",
    inputSchema: {
      type: "object",
      properties: {
        stop: { type: "boolean", description: "Stop recording and return actions" },
        ...TAB_ID,
      },
    },
  },
  {
    name: "replay_actions",
    description: "Replay a recorded sequence of actions (from record_actions). Useful for regression testing — record the steps to reproduce a bug, fix the code, replay to verify.",
    inputSchema: {
      type: "object",
      properties: {
        actions: { type: "array", items: { type: "object" }, description: "Array of actions from record_actions" },
        delay_ms: { type: "number", description: "Delay between actions in ms (default: none)" },
        ...TAB_ID,
      },
      required: ["actions"],
    },
  },
  {
    name: "mock_network",
    description: "Intercept network requests matching a URL pattern and return a custom response. Use for testing error states, empty states, slow responses. The mock stays active until the debugger is detached.",
    inputSchema: {
      type: "object",
      properties: {
        url_pattern: { type: "string", description: "URL substring to match (e.g. '/api/cart')" },
        status_code: { type: "number", description: "HTTP status to return (default 200)" },
        response_body: { description: "Response body (string or object)" },
        content_type: { type: "string", description: "Content-Type header (default 'application/json')" },
        ...TAB_ID,
      },
      required: ["url_pattern"],
    },
  },
  {
    name: "highlight_element",
    description: "Visually highlight an element in the browser with a pulsing colored outline. The user sees exactly which element you're referring to. Highlight disappears after duration_ms.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" }, selector: { type: "string" },
        color: { type: "string", description: "Border color (default '#D97757' orange)" },
        duration_ms: { type: "number", description: "How long to show highlight (default 3000)" },
        ...TAB_ID,
      },
    },
  },
  // ====================== TIER 2 ======================
  {
    name: "save_form_profile",
    description: "Save all current form field values on the page as a named profile. Reuse with load_form_profile on similar forms.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Profile name (default 'default')" }, ...TAB_ID },
    },
  },
  {
    name: "load_form_profile",
    description: "Load a saved form profile and fill all matching fields. Useful for job applications, login forms, or any repeated form filling.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Profile name to load" }, ...TAB_ID },
    },
  },
  {
    name: "get_load_timeline",
    description: "Get the full page load timeline: DNS, TCP, request, response, DOM processing phases + resource waterfall (top 30 by load order) + milestones (FP, FCP, LCP, DCL, Load).",
    inputSchema: { type: "object", properties: { ...TAB_ID } },
  },
  {
    name: "get_grouped_console",
    description: "Get console messages grouped and counted — e.g. '27x: Font resolve mismatch' instead of 27 individual entries. Sorted by frequency.",
    inputSchema: { type: "object", properties: { ...TAB_ID } },
  },
  {
    name: "generate_selector",
    description: "Generate multiple stable CSS selectors for an element (by id, data-testid, aria-label, path, text). Returns options ranked by reliability.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string" }, selector: { type: "string" }, ...TAB_ID },
    },
  },
  {
    name: "save_tab_session",
    description: "Save all current tab URLs as a named session. Restore later with restore_tab_session.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Session name (default 'default')" } },
    },
  },
  {
    name: "restore_tab_session",
    description: "Restore a previously saved tab session — reopens all tabs from the saved session.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Session name to restore" } },
    },
  },
  // ====================== TIER 3 ======================
  {
    name: "set_geolocation",
    description: "Spoof GPS geolocation for location-based features. Pass clear=true to restore real location.",
    inputSchema: {
      type: "object",
      properties: {
        latitude: { type: "number" }, longitude: { type: "number" }, accuracy: { type: "number" },
        clear: { type: "boolean" }, ...TAB_ID,
      },
    },
  },
  {
    name: "toggle_dark_mode",
    description: "Toggle prefers-color-scheme between dark and light. Tests dark mode without changing OS settings.",
    inputSchema: {
      type: "object",
      properties: { dark: { type: "boolean", description: "true for dark, false for light (default true)" }, ...TAB_ID },
    },
  },
  {
    name: "edit_cookie",
    description: "Set, modify, or delete a cookie. Pass delete=true to remove. Useful for testing auth states.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" }, value: { type: "string" }, domain: { type: "string" },
        path: { type: "string" }, secure: { type: "boolean" }, httpOnly: { type: "boolean" },
        expirationDate: { type: "number" }, delete: { type: "boolean" }, ...TAB_ID,
      },
      required: ["name"],
    },
  },
  {
    name: "search_network_bodies",
    description: "Search across all recorded request/response bodies for a string. Finds which API call contains a specific value, field name, or error message.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "String to search for in request/response bodies" }, ...TAB_ID },
      required: ["query"],
    },
  },
];

const server = new Server(
  { name: "browser-bridge", version: "3.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [HELP_TOOL, BATCH_TOOL, ...TOOLS] }));

function formatResult(name, result) {
  if ((name === "screenshot" || name === "full_page_screenshot") && result?.dataUrl) {
    const base64 = result.dataUrl.replace(/^data:image\/png;base64,/, "");
    return {
      content: [
        { type: "image", data: base64, mimeType: "image/png" },
        { type: "text", text: `Screenshot of ${result.url}` },
      ],
    };
  }
  if (name === "visual_diff" && result?.diffImage) {
    const base64 = result.diffImage.replace(/^data:image\/png;base64,/, "");
    const { diffImage, ...rest } = result;
    return {
      content: [
        { type: "image", data: base64, mimeType: "image/png" },
        { type: "text", text: JSON.stringify(rest, null, 2) },
      ],
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    // Help: return the full usage guide (no extension needed).
    if (name === "browser_bridge_help") {
      return { content: [{ type: "text", text: HELP_TEXT }] };
    }

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
