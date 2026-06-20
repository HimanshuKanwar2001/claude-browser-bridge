// Combined MCP stdio server (for Claude Code) + WebSocket bridge (for the
// Chrome extension). Claude tool calls are proxied to the extension, which
// executes them on the user's real, logged-in tabs.
//
// Multi-session: the first Claude Code session to start binds the port and
// "owns" the bridge; later sessions detect EADDRINUSE and relay their tool
// calls through the owner. If the owner exits, a relay takes over the port.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname, userInfo } from "node:os";
import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import WebSocket, { WebSocketServer } from "ws";

const PORT = Number(process.env.BRIDGE_PORT) || 8787;

// Deterministic token: derived from machine identity (username + hostname).
// Same token every time on the same machine — no file sync issues, no
// regeneration needed, no stale-token bugs across sessions.
// Falls back to file-based token if BRIDGE_TOKEN env var or token file exists.
function deriveToken() {
  const identity = `claude-browser-bridge:${userInfo().username}@${hostname()}:${PORT}`;
  return createHash("sha256").update(identity).digest("hex");
}

function readToken() {
  // 1. Explicit env var override
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN;
  // 2. File-based token (legacy — checked for backwards compatibility)
  const filePaths = [
    process.env.BRIDGE_TOKEN_PATH,
    join(homedir(), ".claude", "browser-bridge-token"),
    new URL("./.bridge-token", import.meta.url).pathname,
    join(process.cwd(), "server", ".bridge-token"),
    join(process.cwd(), ".bridge-token"),
  ].filter(Boolean);
  for (const p of filePaths) {
    try {
      const t = readFileSync(p, "utf8").trim();
      if (t) return t;
    } catch {}
  }
  // 3. Deterministic token (always works, no files needed)
  return deriveToken();
}

// Write the deterministic token to the canonical location so gen-token.js
// isn't required anymore (but still works for custom tokens).
const canonicalDir = join(homedir(), ".claude");
const canonicalPath = join(canonicalDir, "browser-bridge-token");
if (!existsSync(canonicalPath)) {
  try {
    if (!existsSync(canonicalDir)) mkdirSync(canonicalDir, { recursive: true });
    writeFileSync(canonicalPath, deriveToken() + "\n");
    console.error(`[bridge] Auto-generated token at ${canonicalPath}`);
  } catch {}
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
    "Returns the quick-start usage guide for all browser-bridge tools, workflows, Chrome edge cases, and anti-patterns. Call this ONCE at session start. For DEEP expertise on specific topics (security testing, performance analysis, design validation, proactive scanning, Chrome internals, etc.), call bridge_knowledge with a topic.",
  inputSchema: { type: "object", properties: {} },
};

const HELP_TEXT = `# Claude Browser Bridge — 74 Tools

## WHICH TOOL FIRST? (decision tree)
- Investigating a bug → diagnose (gives snapshot + errors + network + API responses in ONE call)
- Fixing CSS/visual → batch([screenshot, get_styles({selector:".target"}), get_html({selector:".target"})])
- Debugging image layers/z-index → batch([get_element_rect({selector:".container", include_children:true}), annotate({annotations:[...]})])
- Checking pixel colors on images → inspect_pixel({selector:"img", x:50, y:50, percent:true})
- Performance check → batch([performance_trace, get_load_timeline, heap_snapshot_summary])
- Accessibility audit → batch([get_accessibility_tree, check_contrast({selector:".text"})])
- Reading page content → eval (specific data) or get_page_text (all text)
- Interacting with page → diagnose first (get refs), then click/fill using refs
- Showing user what Claude does → cursor_mode({enabled:true}) — visible pointer + effects
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

Page Interaction (with observe mode — Claude sees every action's result automatically):
  observe_mode({enabled:true}) → diagnose → fill({ref:"ref_3"}) → click({ref:"ref_0"})
  Every interaction returns a screenshot — no separate screenshot calls needed.

Visual Demo Mode (user watches Claude work — cursor + effects):
  cursor_mode({enabled:true}) → observe_mode({enabled:true})
  Now every click/fill/hover shows a visible pointer moving to the target,
  click ripple effects, typing indicators, and action labels.
  The user sees exactly what Claude is doing in real time.

Improved Interactions (always active, no toggle needed):
  Clicks fire the full Playwright-style event sequence:
    pointerover → mouseover → pointerenter → mouseenter → pointermove →
    mousemove → pointerdown → mousedown → focus → pointerup → mouseup → click
  All events carry correct clientX/clientY coordinates.
  Actionability checks run before each interaction (hidden, disabled, zero-size).
  Fill uses InputEvent with inputType for proper React/Vue/Angular detection.

Multi-tab Research:
  select_tab(app) → new_tab(docs) → get_page_text → close_tab → continue on app

Error State Testing:
  mock_network({url_pattern:"/api/cart", status_code:500}) → reload → screenshot

Regression Testing:
  record_actions → reproduce → stop → fix → replay_actions → screenshot

Before/After Comparison:
  screenshot (save dataUrl) → make changes → visual_diff({before_dataUrl:"..."})

Image/Layer Debugging:
  annotate({annotations:[{selector:".base",label:"Base",color:"red"},{selector:".overlay",label:"Overlay",color:"blue"}]}) → screenshot → clear_annotations
  inspect_pixel({selector:".garment-img", x:50, y:30, percent:true}) → check if transparent or opaque
  get_element_rect({selector:".container", include_children:true}) → see all child positions + z-indexes
  capture_canvas({selector:".composer"}) → flatten all stacked images into one PNG

Cross-Product Comparison:
  new_tab({url:"product-A"}) → new_tab({url:"product-B"}) → compare_tabs({tab_id_1:A, tab_id_2:B})

State Management Testing:
  set_storage({key:"cache", action:"remove"}) → reload → verify fresh state

## COMMON BUG PATTERNS (check these before investigating):
- Stale session: clear with eval({code:"sessionStorage.clear();['session','cache','config'].forEach(p=>{for(let i=localStorage.length-1;i>=0;i--){const k=localStorage.key(i);if(k.includes(p))localStorage.removeItem(k)}})"}) + reload
- React state unreadable (prod): don't rely on class names. Use get_styles, get_element_rect, eval with data-testid or global store
- Login expired: get_network shows empty/{} responses → re-authenticate with the platform CLI
- Visual change not visible: wait 3s for HMR, use inject_css to test live, get_styles to verify computed value
- Font/asset mismatch: get_grouped_console → look for repeated warnings with API vs resolved values

## ALL 74 TOOLS BY CATEGORY:
Core: diagnose, batch, select_tab, snapshot, eval, screenshot, full_page_screenshot, get_page_text, get_html, get_page_info, browser_bridge_help, observe_mode, cursor_mode
Interaction: click, fill, hover, scroll, press_key, select_option, upload_file, highlight_element
Navigation: navigate, new_tab, close_tab, go_back, go_forward, reload, list_tabs, wait_for
Debugging: get_console, get_grouped_console, get_network, search_network_bodies, get_styles, get_cookies, get_storage, get_clipboard, watch_dom_changes, generate_selector
Performance: performance_trace, heap_snapshot_summary, get_load_timeline
Accessibility: get_accessibility_tree, check_contrast
Emulation: emulate_device, network_throttle, set_geolocation, toggle_dark_mode
Testing: visual_diff, inject_css, mock_network, record_actions, replay_actions, handle_dialog
Productivity: save_form_profile, load_form_profile, save_tab_session, restore_tab_session, edit_cookie, export_pdf
Visual Debugging: inspect_pixel, get_element_rect, compare_tabs, annotate, clear_annotations, capture_canvas
Storage: set_storage
Video: video_get_captions, video_control, video_capture_frame, video_get_chapters, video_listen, video_smart_read

## VIDEO LEARNING WORKFLOW:
For YouTube: use youtube-transcript MCP (get_timed_transcript) for full transcript + video_capture_frame to see code/slides.
For non-YouTube HTML5 video: use video_get_captions or video_smart_read (auto-detects captions, falls back to speech recognition).
video_capture_frame({timestamp:120}) → Claude sees code/slides at 2:00 mark.
video_control({action:"seek", value:600}) → jump to 10:00.
video_get_chapters → get topic structure from description.

## CHROME EDGE CASES — KNOW BEFORE YOU HIT THEM:

### CSP/Trusted Types block eval on major sites:
Sites: GitHub, YouTube, MDN, CodePen, Google properties, most modern production sites.
Symptom: eval returns "Content Security Policy" or "Trusted Type" error.
diagnose now reports cspBlocksEval: true when this applies.
DO NOT retry eval — switch to: get_html({selector}) + get_styles({selector}) + get_page_text.
All other tools (snapshot, click, fill, screenshot, get_console, get_network) work everywhere.

### chrome:// pages are completely blocked:
Pages: chrome://settings, chrome://extensions, chrome://flags, chrome://newtab, etc.
ALL tools fail. Only list_tabs can see the tab. Navigate to a regular page instead.

### Debugger conflicts — NEVER batch these together:
Tools using chrome.debugger: performance_trace, get_accessibility_tree, heap_snapshot_summary,
  mock_network, emulate_device, network_throttle, upload_file, check_contrast.
BAD: batch([performance_trace, get_accessibility_tree]) → second FAILS.
GOOD: Run debugger tools one at a time, NOT in the same batch.
SAFE TO BATCH: batch([screenshot, get_styles, get_html, get_console, eval]) — none of these need debugger.

### check_contrast with transparent backgrounds:
Now walks up parent chain to find actual visible background color.
Reports bg_source: "inherited from parent" when element has transparent bg.

### Shadow DOM: snapshot finds interactive elements inside open shadow roots.
click/fill work on shadow DOM refs. Use get_html on the host element for structure.

### Cross-origin iframes: diagnose reports crossOriginIframes when present.
Cannot read/modify content inside cross-origin iframes from parent page.
screenshot still captures them visually.

### After back/forward navigation: always re-snapshot. Old refs are stale after bfcache restore.

### Tab discarding: Chrome kills background tabs under memory pressure.
Console/network buffers are lost. Tab reloads fresh on refocus.

## INVESTIGATION APPROACHES (choose by problem type):

Visual bug: batch([screenshot, get_styles]) → inject_css fix → screenshot → write to file
Broken feature: diagnose → click/fill action → get_console + get_network → trace the error
Wrong data: get_network({url_contains:"/api/"}) → search_network_bodies("value") → eval for state
Security: get_cookies (flags) → get_network (tokens in URLs?) → get_html (reflected input?) → get_storage (tokens in localStorage?)
Slow page: performance_trace → get_load_timeline → network_throttle("slow-3g") test
A11y audit: get_accessibility_tree → check_contrast → keyboard Tab test (press_key)
API failure: diagnose → get_network({only_failures:true}) → mock_network for error state testing
Regression: screenshot (save) → fix → visual_diff → record_actions/replay for full flows

SECURITY TESTING CHECKLIST:
1. get_cookies → HttpOnly? Secure? SameSite? reasonable expiration?
2. get_network → tokens/keys in URLs? (never put secrets in URLs)
3. search_network_bodies("token") → where do tokens appear in responses?
4. fill XSS payload → get_html → check if reflected unescaped in DOM
5. get_html → hidden fields, HTML comments, JSON data with sensitive info?
6. get_network → any http:// on https:// page? (mixed content)
7. diagnose → cspBlocksEval false = weaker XSS protection
8. get_storage → tokens in localStorage? (XSS can steal them)

ANTI-PATTERNS:
- Don't retry eval on CSP sites → switch to get_html/get_styles/get_page_text
- Don't batch debugger tools → run sequentially
- Don't navigate app tab for research → use new_tab
- Don't claim fix works without screenshot
- Don't guess CSS values → use get_styles to read actual computed values
`;

const BATCH_TOOL = {
  name: "batch",
  description:
    "Execute multiple tool calls in a single round-trip for speed. Pass an array of {name, arguments} objects. All calls run in parallel. ALWAYS prefer this over sequential calls. CDP operations are automatically queued (no more debugger conflicts) — you can now safely batch ANY combination of tools including performance_trace + get_accessibility_tree.",
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

const OBSERVE_TOOL = {
  name: "observe_mode",
  description:
    "Toggle observe mode ON/OFF. When ON, every interaction tool (click, fill, hover, scroll, navigate) automatically captures and returns a screenshot in its response — Claude sees the visual result of every action without separate screenshot calls. Turn ON at session start for visual debugging workflows. Turn OFF for speed when you don't need visual feedback.",
  inputSchema: {
    type: "object",
    properties: {
      enabled: { type: "boolean", description: "true to enable, false to disable" },
    },
    required: ["enabled"],
  },
};

const CURSOR_TOOL = {
  name: "cursor_mode",
  description:
    "Toggle visual cursor mode ON/OFF. When ON, a visible mouse pointer animates smoothly to each target element before click/fill/hover actions — users can watch exactly what Claude is doing in real time. Includes click ripple effects, typing indicators, and action labels. Adds ~400ms per interaction for animation. Use for demos, pair debugging, or when the user wants to follow along. Combine with observe_mode for full visual feedback.",
  inputSchema: {
    type: "object",
    properties: {
      enabled: { type: "boolean", description: "true to show visual cursor, false to hide" },
      speed: { type: "string", enum: ["slow", "normal", "fast"], description: "Animation speed (default 'normal'). 'slow' for demos, 'fast' for quick workflows." },
    },
    required: ["enabled"],
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
      "Snapshot all interactive elements including React portals, shadow DOM, overlays, and dropdown menus as ref-tagged lines like: ref_12 <button> \"Sign in\". Scans portal containers (Radix, MUI, Headless UI, GitHub Primer), walks open shadow roots, and detects dialog/listbox/menu overlays. Pass refs to click/fill. Refs invalidated by navigation or new snapshot.",
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
      "Wait until a CSS selector and/or text appears on the page. Uses MutationObserver for instant detection (no polling delay). Resolves in < 1ms if condition already met. Use after click/navigate on SPAs.",
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
    description: "Evaluate JavaScript in the page context and return the result as a string. Uses CDP Runtime.evaluate (bypasses CSP — works on GitHub, YouTube, MDN, and all sites). Falls back to script injection if CDP unavailable. Does NOT steal tab focus — runs on background tabs.",
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
    description: "Take a PNG screenshot of the tab. Uses CDP Page.captureScreenshot — works on background tabs WITHOUT stealing focus from the user. No tab switching needed.",
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
    description: "Press a key via CDP Input.dispatchKeyEvent — produces isTrusted:true events that work with all frameworks. Falls back to DOM events if CDP unavailable. Modifiers: ['Control','Shift','Alt','Meta'].",
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
    name: "detach_debugger",
    description: "Detach the Chrome debugger from the tab, removing the yellow 'debugging' bar. The debugger auto-attaches when needed and auto-releases after 30s of inactivity, so you rarely need this. Use it when the yellow bar is distracting or after finishing a session of CDP-heavy tools.",
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
      "⚡ CALL THIS FIRST on any page. Returns snapshot (interactive elements with refs for click/fill) + console errors with stacks + failed network requests with response bodies + recent successful API responses + CAPTCHA detection + CSP detection (cspBlocksEval: true if eval won't work) + cross-origin iframe warnings + localStorage keys — ALL in ONE call. Replaces 4-5 sequential tool calls. After this, use refs from the snapshot to click/fill elements. If cspBlocksEval is true, use get_html/get_styles/get_page_text instead of eval.",
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
    description: "Get the full accessibility (a11y) tree from Chrome — ARIA roles, names, states. Uses chrome.debugger — cannot batch with other debugger tools (performance_trace, heap_snapshot_summary, etc.). Run these sequentially.",
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
    description: "Capture Core Web Vitals (LCP, FCP, CLS) and performance metrics — DOM load time, resource count, transfer size, long task count. Uses chrome.debugger — cannot batch with other debugger tools (get_accessibility_tree, heap_snapshot_summary, etc.). Run these sequentially.",
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
    description: "Check WCAG color contrast ratio for a text element — returns fg/bg colors, contrast ratio, and AA/AAA pass/fail. Now walks up parent chain when element has transparent background (reports bg_source: 'inherited from parent'). Uses chrome.debugger — cannot batch with other debugger tools.",
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
  // =================== SESSION-REQUESTED TOOLS ===================
  {
    name: "inspect_pixel",
    description: "Sample RGBA color at a specific pixel coordinate on any rendered element. Bypasses CORS restrictions on images. Use percent=true to specify x/y as percentages of the element's size (e.g. x:50, y:50 = center). Returns hex color, opacity, and element bounding box.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" }, ref: { type: "string" },
        x: { type: "number", description: "X coordinate (pixels from element left, or percentage if percent=true)" },
        y: { type: "number", description: "Y coordinate (pixels from element top, or percentage if percent=true)" },
        percent: { type: "boolean", description: "If true, x/y are percentages (0-100) of the element size" },
        ...TAB_ID,
      },
    },
  },
  {
    name: "get_element_rect",
    description: "Get exact computed position (viewport + offset + scroll), size, z-index, visibility, opacity, and parent info for any element. Use include_children=true to also get bounding boxes of all child elements — essential for debugging stacking/layering issues.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" }, ref: { type: "string" },
        include_children: { type: "boolean", description: "Also return child element rects (default false)" },
        ...TAB_ID,
      },
    },
  },
  {
    name: "compare_tabs",
    description: "Screenshot two tabs side by side and compute a pixel diff between them. Returns both screenshots plus a diff image with changes in red. Use for comparing the same page across products, environments (prod vs staging), or before/after states.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id_1: { type: "number", description: "First tab to screenshot" },
        tab_id_2: { type: "number", description: "Second tab to screenshot" },
      },
      required: ["tab_id_1", "tab_id_2"],
    },
  },
  {
    name: "annotate",
    description: "Draw persistent colored borders + labels on elements for visual debugging. Annotations stay visible across screenshots — use to identify layers, z-index stacking, or mark multiple elements at once. Call clear_annotations to remove them.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" }, ref: { type: "string" },
        label: { type: "string", description: "Text label shown above the element" },
        color: { type: "string", description: "Border/label color (default '#D97757')" },
        annotations: { type: "array", items: { type: "object" }, description: "Array of {selector, ref, label, color} for annotating multiple elements at once" },
        ...TAB_ID,
      },
    },
  },
  {
    name: "clear_annotations",
    description: "Remove all annotations drawn by the annotate tool.",
    inputSchema: { type: "object", properties: { ...TAB_ID } },
  },
  {
    name: "capture_canvas",
    description: "Flatten stacked child images inside a container element into a single canvas capture (like the browser renders them). Returns a PNG. Use for inspecting composited garment/image layers where individual images stack via z-index.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" }, ref: { type: "string" }, ...TAB_ID },
    },
  },
  {
    name: "set_storage",
    description: "Write to localStorage or sessionStorage. Handles complex JSON objects safely. Use action='remove' to delete a key, action='clear' to clear all storage.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" }, value: { description: "Value to set (string or JSON object)" },
        storage_type: { type: "string", enum: ["local", "session"], description: "Default: local" },
        action: { type: "string", enum: ["set", "remove", "clear"], description: "Default: set" },
        ...TAB_ID,
      },
    },
  },
  // =================== VIDEO UNDERSTANDING TOOLS ===================
  {
    name: "video_get_captions",
    description: "Extract ALL captions/subtitles from the current YouTube video in one call — returns every line with start/end timestamps. Faster than watching the video. Use on any YouTube tab to get what the instructor is saying.",
    inputSchema: { type: "object", properties: { ...TAB_ID } },
  },
  {
    name: "video_control",
    description: "Control video playback: play, pause, seek to a timestamp, change speed, or get current status. Use action='seek' with value=seconds to jump to a specific point. action='speed' with value=2 for 2x playback.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["play", "pause", "seek", "status", "speed"], description: "What to do with the video" },
        value: { type: "number", description: "Seek target in seconds, or playback speed multiplier" },
        ...TAB_ID,
      },
      required: ["action"],
    },
  },
  {
    name: "video_capture_frame",
    description: "Pause the video at a specific timestamp and screenshot what's on screen — lets Claude 'see' code, slides, diagrams shown in the video. Also returns the caption at that moment. Pass timestamp in seconds.",
    inputSchema: {
      type: "object",
      properties: {
        timestamp: { type: "number", description: "Time in seconds to capture the frame at (e.g. 120 for 2:00)" },
        ...TAB_ID,
      },
    },
  },
  {
    name: "video_get_chapters",
    description: "Extract chapter markers from a YouTube video (from the description or progress bar). Returns chapter titles with timestamps — use to navigate a tutorial by topic.",
    inputSchema: { type: "object", properties: { ...TAB_ID } },
  },
  {
    name: "video_listen",
    description: "When no captions/transcript exist: uses Chrome's built-in Speech Recognition to listen to the audio playing in the tab and transcribe it in real-time. Records for duration_ms (default 30s, max 120s). The video must be playing and unmuted.",
    inputSchema: {
      type: "object",
      properties: {
        duration_ms: { type: "number", description: "How long to listen in ms (default 30000, max 120000)" },
        ...TAB_ID,
      },
    },
  },
  {
    name: "video_smart_read",
    description: "Intelligent video reader — tries captions first (instant), falls back to speech recognition if no captions exist. The 'just give me what the video says' tool. Returns full text + method used.",
    inputSchema: {
      type: "object",
      properties: {
        listen_duration_ms: { type: "number", description: "If speech recognition is needed, how long to listen (default 60s, max 120s)" },
        ...TAB_ID,
      },
    },
  },
];

const server = new Server(
  { name: "browser-bridge", version: "6.0.0" },
  { capabilities: { tools: {} } }
);

const KNOWLEDGE_TOOL = {
  name: "bridge_knowledge",
  description:
    "Deep browser expertise system — call with a topic to get comprehensive methodology for that area. " +
    "Topics: 'full_site_audit' (proactive multi-angle scan), 'security' (XSS, auth, CSRF, injection, data exposure), " +
    "'performance' (load, runtime, memory, rendering), 'accessibility' (WCAG, keyboard, screen reader), " +
    "'design_validation' (compare UI to Figma/design specs), 'api_testing' (validation, security, error handling), " +
    "'chrome_internals' (how Chrome works, processes, rendering, navigation), " +
    "'state_debugging' (storage, cache, session, React/Redux state), " +
    "'network_debugging' (CORS, caching, service workers, WebSocket), " +
    "'element_inspection' (DOM, CSS, layout, z-index, shadow DOM, iframes), " +
    "'proactive_patterns' (automated sweeps to find problems before they're reported), " +
    "'quick_reference' (decision trees, security checklist, anti-patterns — start here), " +
    "'devtools_workarounds' (how to replicate Chrome DevTools panel features using bridge tools — CSS rules, event listeners, WebSocket, memory leaks, service workers, coverage). " +
    "Call this when starting a new investigation to get the right approach.",
  inputSchema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description: "Knowledge area to query. Use 'full_site_audit' for the complete multi-angle scan methodology.",
      },
    },
    required: ["topic"],
  },
};

const KNOWLEDGE = {

full_site_audit: `# Full Site Audit — Multi-Angle Proactive Scan

Run this systematic sweep to find ALL issues on a page — not just the one you're looking for.
Each angle discovers different problem classes. Run them all for complete coverage.

## Phase 1: First Contact (30 seconds)
\`\`\`
diagnose → gives you:
  - snapshot: all interactive elements (missing labels? broken links? disabled buttons?)
  - consoleErrors: JS errors already happening (fix these first)
  - failedRequests: broken API calls with response bodies
  - cspBlocksEval: whether eval works on this page
  - crossOriginIframes: iframes you can't inspect
  - hasCaptcha: bot detection active
  - localStorage_keys: what state the page stores
\`\`\`

## Phase 2: Visual Scan (1 minute)
\`\`\`
1. screenshot → overall visual state
2. emulate_device({device:"mobile"}) → screenshot → mobile layout
3. emulate_device({device:"tablet"}) → screenshot → tablet layout
4. emulate_device({device:"reset"}) → restore
5. toggle_dark_mode({dark:true}) → screenshot → dark mode
6. toggle_dark_mode({dark:false}) → restore

Look for: overflow, text cut-off, overlapping elements, broken layouts,
          missing responsive behavior, dark mode contrast issues
\`\`\`

## Phase 3: Structural Integrity (1 minute)
\`\`\`
1. get_accessibility_tree({max_depth:5, max_nodes:200}) → full a11y tree
   Check: missing roles, empty names, broken landmarks, form labels
2. eval or get_html → check for:
   - Images without alt text
   - Links without href
   - Buttons without accessible names
   - Form inputs without associated labels
   - Heading hierarchy gaps (h1 → h3, skipping h2)
3. check_contrast on key text elements (headings, body text, buttons)
\`\`\`

## Phase 4: Functional Testing (2 minutes)
\`\`\`
1. For every form on the page:
   a. Fill with valid data → submit → check get_console + get_network
   b. Fill with empty data → submit → check validation messages
   c. Fill with edge cases (special chars, very long text, SQL injection patterns)
   d. Check: does the form actually submit? Does validation work?

2. For every button/link:
   a. click → does it navigate/trigger action?
   b. get_console after click → any JS errors?
   c. get_network after click → API call made and successful?

3. For navigation:
   a. Click each nav item → wait_for → screenshot
   b. go_back → does back work correctly?
   c. Check URL changes, page title updates
\`\`\`

## Phase 5: Network & API Health (1 minute)
\`\`\`
1. get_network → review ALL requests:
   - Any failed? (status >= 400)
   - Any slow? (duration > 1000ms)
   - Any redundant? (same URL called multiple times)
   - Any insecure? (http:// on https:// page)
   - Any with tokens in URLs?
2. search_network_bodies({query:"error"}) → hidden errors in API responses
3. search_network_bodies({query:"deprecated"}) → deprecated API usage
\`\`\`

## Phase 6: Performance Baseline (1 minute)
\`\`\`
1. performance_trace → Web Vitals snapshot
   - LCP > 2.5s? → find the bottleneck
   - FCP > 1.8s? → render-blocking resources
   - CLS > 0.1? → layout shifts
2. get_load_timeline → resource waterfall
   - Which resource is slowest?
   - Are images optimized? (large transfer size = unoptimized)
   - Render-blocking scripts without async/defer?
3. heap_snapshot_summary → memory baseline
\`\`\`

## Phase 7: Security Sweep (2 minutes)
\`\`\`
1. get_cookies → audit every cookie:
   - Session cookies: HttpOnly? Secure? SameSite?
   - Expiration: reasonable? (> 1 year = risk)
   - Any cookies without security flags?
2. get_storage → check localStorage:
   - Tokens/keys stored? (vulnerable to XSS)
   - Sensitive user data?
3. get_network → check requests:
   - Tokens in URL parameters?
   - API keys in query strings?
   - Mixed content (http on https)?
4. get_html({selector:"body"}) → check for:
   - HTML comments with sensitive info
   - Hidden inputs with tokens
   - Inline scripts with user data
5. diagnose → cspBlocksEval?
   - false = no CSP = weaker XSS protection (concern for production)
   - true = CSP active = good security posture
\`\`\`

## Phase 8: State Integrity (1 minute)
\`\`\`
1. get_storage → all localStorage keys/values
2. get_storage({storage_type:"session"}) → sessionStorage
3. get_cookies → cookies
4. Navigate to another page → come back
5. Repeat storage checks → did anything change unexpectedly?
6. reload({bypass_cache:true}) → does page work with clean cache?
\`\`\`

## Findings Template:
For each issue found, record:
- WHAT: description of the problem
- WHERE: URL, element selector, API endpoint
- SEVERITY: Critical / High / Medium / Low
- CATEGORY: Visual / Functional / Security / Performance / A11y
- HOW TO REPRODUCE: exact steps
- EVIDENCE: screenshot, console error, network response`,

security: `# Security Testing Methodology

## Approach 1: Cookie & Session Security
\`\`\`
get_cookies → for each cookie check:
  ┌─ HttpOnly: true?     → if false: XSS can steal this cookie
  ├─ Secure: true?       → if false: sent over HTTP (interceptable)
  ├─ SameSite: Lax/Strict? → if None: CSRF vulnerable
  ├─ Path: scoped?       → "/" is too broad for sensitive cookies
  ├─ Expiration: reasonable? → long-lived sessions = hijack window
  └─ Domain: correctly scoped? → too broad = cookie leaks to subdomains
\`\`\`

## Approach 2: Input Injection Testing
For every input field on the page:
\`\`\`
1. XSS Payloads — fill then check if reflected unescaped:
   fill({value: '<img src=x onerror=alert(1)>'}) → submit → get_html → unescaped <img>?
   fill({value: '"><script>alert(1)</script>'}) → submit → get_html → script tag in DOM?
   fill({value: "javascript:alert(1)"}) → for URL inputs → does it execute?
   fill({value: "{{7*7}}"}) → template injection → does "49" appear?

2. SQL Injection Probes — fill then check API response:
   fill({value: "' OR '1'='1"}) → submit → get_network → different response?
   fill({value: "1; DROP TABLE users--"}) → submit → get_network → error message reveals DB?

3. Path Traversal:
   fill({value: "../../etc/passwd"}) → for file inputs → get_network → unusual response?
   fill({value: "../admin"}) → for URL/path inputs

4. After each test:
   get_html({selector:"body"}) → is the payload reflected unescaped?
   get_console → any new errors from the injection?
   get_network → what did the server respond? Error messages revealing internals?
\`\`\`

## Approach 3: Authentication Bypass Attempts
\`\`\`
1. Direct URL access:
   navigate to protected pages without logging in
   get_network → does API return data or redirect?

2. Token manipulation:
   get_cookies → copy session token
   edit_cookie({name:"session", value:"modified"}) → reload → still authenticated?
   edit_cookie({name:"session", delete:true}) → reload → proper redirect to login?

3. Role escalation:
   get_network → find admin-only API endpoints in network calls
   eval: fetch those endpoints directly → do they return data?

4. Session fixation:
   get_cookies before login → note session ID
   log in → get_cookies after → did session ID change? (should change!)
\`\`\`

## Approach 4: Data Exposure Audit
\`\`\`
1. DOM scanning:
   get_html({selector:"body"}) → search for:
   - HTML comments: <!-- TODO: remove API key -->
   - Hidden inputs: <input type="hidden" name="token" value="...">
   - Data attributes: data-user-id, data-api-key
   - JSON in script tags: <script type="application/json">
   - Source map references: //# sourceMappingURL=

2. API response scanning:
   get_network → for each API response:
   - Does it return more fields than the UI displays? (over-fetching)
   - search_network_bodies("password") → password hashes exposed?
   - search_network_bodies("email") → user emails in bulk?
   - search_network_bodies("token") → tokens in responses?
   - search_network_bodies("secret") → secrets exposed?

3. Error message analysis:
   get_network({only_failures:true}) → do error responses reveal:
   - Stack traces? (server internals)
   - Database names/schemas?
   - File paths?
   - Version numbers?
\`\`\`

## Approach 5: CORS & Cross-Origin Security
\`\`\`
eval: fetch('https://the-api.com/data', {
  method: 'GET',
  credentials: 'include'
}).then(r => ({
  status: r.status,
  cors: r.headers.get('access-control-allow-origin'),
  creds: r.headers.get('access-control-allow-credentials')
}))

DANGEROUS if: Allow-Origin: * AND Allow-Credentials: true
→ Any site can make authenticated requests to this API

Check: get_network → look at all cross-origin request headers
\`\`\`

## Approach 6: Transport Security
\`\`\`
1. get_network → list ALL resource URLs:
   - Any http:// on an https:// page? = mixed content vulnerability
   - Any http:// API calls? = credentials sent in cleartext

2. eval: document.querySelectorAll('[src^="http:"]')
   → find all resources loaded over insecure HTTP

3. eval: document.querySelectorAll('a[href^="http:"]')
   → find links that send user to HTTP pages

4. get_cookies → any cookies without Secure flag on HTTPS site?
   → will be sent over HTTP if user visits http:// version
\`\`\`

## Multi-Pattern Security Matrix:
| Attack Vector | Detection Tool Chain | What to Look For |
|--------------|---------------------|-----------------|
| Reflected XSS | fill → get_html | Unescaped user input in DOM |
| Stored XSS | fill → navigate away → come back → get_html | Input persisted and rendered |
| DOM XSS | get_html → search for innerHTML/document.write with user data | Dangerous sink usage |
| CSRF | get_html → check forms for anti-CSRF tokens | Missing or predictable tokens |
| Session hijack | get_cookies → check HttpOnly | Non-HttpOnly session cookies |
| Clickjacking | get_html({selector:"head"}) → check X-Frame-Options/CSP frame-ancestors | Missing frame protection |
| Open redirect | fill URL param → submit → get_network | Redirect to attacker-controlled URL |
| Info disclosure | get_network → search_network_bodies | Sensitive data in responses |
| Mixed content | get_network → filter http:// | Insecure resources on secure page |
| Weak auth | edit_cookie → reload | Session survives token modification |`,

performance: `# Performance Analysis Methodology

## Layer 1: Page Load Metrics
\`\`\`
performance_trace → Core Web Vitals:
  LCP (Largest Contentful Paint):
    < 2.5s = Good | 2.5-4s = Needs Work | > 4s = Poor
    If poor → get_load_timeline → find the LCP resource → optimize it

  FCP (First Contentful Paint):
    < 1.8s = Good | 1.8-3s = Needs Work | > 3s = Poor
    If poor → check render-blocking resources in <head>

  CLS (Cumulative Layout Shift):
    < 0.1 = Good | 0.1-0.25 = Needs Work | > 0.25 = Poor
    If poor → images without width/height, dynamic content injection

  Long Tasks:
    Count > 0 = JS blocking main thread for > 50ms
    Identify: eval performance.getEntriesByType('longtask')
\`\`\`

## Layer 2: Resource Waterfall
\`\`\`
get_load_timeline → analyze:
1. Which resources load first? (critical path)
2. Which are render-blocking? (scripts without async/defer, CSS)
3. Which are largest? (unoptimized images, large bundles)
4. Which are slowest? (high TTFB = server issue, high download = size issue)
5. Redundant loads? (same resource loaded twice)
6. Third-party scripts? (analytics, ads — blocking your page?)
\`\`\`

## Layer 3: Runtime Performance
\`\`\`
1. Scroll test:
   scroll({direction:"down", amount:5000}) → is it smooth or janky?
   eval: performance.getEntriesByType('longtask') → long tasks during scroll?

2. Interaction test:
   click a button → measure time to response:
   eval: performance.mark('start'); → click → eval: performance.measure('click', 'start');

3. Animation test:
   eval: "requestAnimationFrame timestamps" → frame rate analysis
\`\`\`

## Layer 4: Memory Analysis
\`\`\`
1. heap_snapshot_summary → baseline: usedMB, totalMB, nodeCount
2. Interact with page (open/close dialogs, navigate, scroll)
3. heap_snapshot_summary → check growth
4. Repeat 5 times → memory keeps growing? = LEAK

Signs of memory leak:
- JS heap grows monotonically (never goes back down)
- DOM node count increases with each interaction
- Event listeners accumulate (check via eval)
\`\`\`

## Layer 5: Network Efficiency
\`\`\`
get_network → analyze:
1. Total requests count (< 50 is good for initial load)
2. Total transfer size (< 1MB is good for initial load)
3. Duplicate requests (same URL called multiple times)
4. Unnecessary requests (resources not used on this page)
5. Caching headers (are responses cached? check Cache-Control)
6. Compression (is gzip/brotli used? check Content-Encoding)
\`\`\`

## Layer 6: Simulated Conditions
\`\`\`
network_throttle({preset:"slow-3g"}) → reload → performance_trace
→ How does the page perform on slow connections?

network_throttle({preset:"4g"}) → reload → performance_trace
→ Typical mobile performance

emulate_device({device:"mobile"}) → reload → performance_trace
→ Performance on mobile viewport (may load different resources)

network_throttle({preset:"none"}) → emulate_device({device:"reset"})
→ Always restore after testing
\`\`\``,

design_validation: `# Design Validation — Compare UI to Design Specs

## Approach 1: Visual Comparison with Figma
\`\`\`
If you have access to Figma MCP:
1. get_screenshot from Figma (the design)
2. screenshot from browser bridge (the implementation)
3. Compare visually — or use visual_diff if both are same size

For pixel-perfect comparison:
1. Open the Figma design as an image
2. Use compare_tabs with the implementation tab
3. Red highlights show differences
\`\`\`

## Approach 2: Systematic CSS Property Validation
\`\`\`
For each key element in the design:
1. get_styles({selector:".element"}) → get ALL computed CSS values
2. Compare against design specs:
   - Font family, size, weight, line-height
   - Colors (text, background, border)
   - Spacing (margin, padding)
   - Dimensions (width, height)
   - Border radius, shadows, opacity
   - Flex/grid layout properties
   - Position, z-index

Common mismatches to check:
  font-weight: 600 vs 500 (looks similar, isn't)
  line-height: 1.5 vs 24px (can produce different results)
  padding: 16px vs 1rem (depends on root font-size)
  color: #333 vs rgb(51,51,51) (same value, different format)
  border-radius: 8px vs 0.5rem
\`\`\`

## Approach 3: Responsive Design Validation
\`\`\`
For each breakpoint in the design system:
1. emulate_device({width:1440, height:900}) → screenshot → desktop
2. emulate_device({width:1024, height:768}) → screenshot → tablet landscape
3. emulate_device({device:"tablet"}) → screenshot → tablet portrait
4. emulate_device({device:"mobile"}) → screenshot → mobile
5. emulate_device({device:"reset"})

At each breakpoint check:
- Layout changes (1-column vs multi-column)
- Navigation (hamburger menu appears?)
- Font sizes scale down?
- Images resize/crop correctly?
- Touch targets large enough (>44px on mobile)?
- No horizontal scroll
\`\`\`

## Approach 4: Component-Level Validation
\`\`\`
For each component (button, card, form, nav, etc.):
1. get_html({selector:".component"}) → verify HTML structure matches design
2. get_styles({selector:".component"}) → verify styling
3. Interaction states:
   a. hover({ref:"ref_X"}) → screenshot → hover state matches design?
   b. click → screenshot → active/pressed state?
   c. fill (for inputs) → screenshot → focus state?
   d. CSS.forcePseudoState via get_styles → check :focus-visible
4. Error states:
   - Does validation styling match design?
   - Error messages positioned correctly?
5. Empty states:
   - What does the component look like with no data?
   - Does it match the empty state design?
\`\`\`

## Approach 5: Typography & Spacing Audit
\`\`\`
eval: (() => {
  const styles = new Map();
  document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,span,a,button,label').forEach(el => {
    const cs = getComputedStyle(el);
    const key = cs.fontFamily + '|' + cs.fontSize + '|' + cs.fontWeight + '|' + cs.lineHeight;
    if (!styles.has(key)) styles.set(key, {
      font: cs.fontFamily.split(',')[0],
      size: cs.fontSize,
      weight: cs.fontWeight,
      lineHeight: cs.lineHeight,
      example: el.textContent.slice(0,30),
      count: 0
    });
    styles.get(key).count++;
  });
  return JSON.stringify([...styles.values()].sort((a,b) => b.count - a.count), null, 2);
})()
→ Shows all typography variants used on the page
→ Compare against design system: should there be fewer variants?
\`\`\`

## Approach 6: Color Audit
\`\`\`
eval: (() => {
  const colors = new Map();
  document.querySelectorAll('*').forEach(el => {
    const cs = getComputedStyle(el);
    [cs.color, cs.backgroundColor, cs.borderColor].forEach(c => {
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') {
        colors.set(c, (colors.get(c) || 0) + 1);
      }
    });
  });
  return JSON.stringify([...colors.entries()].sort((a,b) => b[1] - a[1]).slice(0,20)
    .map(([color, count]) => ({color, count})), null, 2);
})()
→ Shows all colors used on the page
→ Compare against design system palette: any off-brand colors?
\`\`\``,

api_testing: `# API Testing & Validation Methodology

## Approach 1: API Health Check
\`\`\`
1. diagnose → check failedRequests (any 4xx/5xx?)
2. get_network → list ALL API calls the page makes:
   - Method (GET/POST/PUT/DELETE)
   - URL pattern
   - Status code
   - Duration (slow > 1000ms)
   - Response size

3. For each critical API:
   search_network_bodies({query:"endpoint-keyword"}) → verify response structure
\`\`\`

## Approach 2: API Security Validation
\`\`\`
1. Auth token handling:
   get_network → do ANY requests have tokens in URL query params?
   → NEVER: /api/data?token=xxx (logged in server access logs, cached)
   → ALWAYS: Authorization: Bearer xxx (in headers, not logged)

2. Response data validation:
   get_network → for each API response:
   - Does it return user data from OTHER users? (IDOR vulnerability)
   - Does it return internal IDs, database keys, or server paths?
   - Does it include fields not needed by the UI? (over-fetching = data leak)

3. Error response safety:
   mock_network({url_pattern:"/api/data", status_code:500, response_body:'{"error":"test"}'})
   → reload → screenshot → does the app handle errors gracefully?
   → Does the error message expose internals to the user?

4. Rate limiting:
   eval: Promise.all(Array(20).fill().map(()=>fetch('/api/endpoint')))
   → Does the API rate-limit? Or can you hammer it?

5. Input validation:
   eval: fetch('/api/endpoint', {method:'POST', body:'{"field":"<script>alert(1)</script>"}'})
   → Does the API accept and store XSS payloads?
\`\`\`

## Approach 3: API Contract Validation
\`\`\`
For each API the page calls:
1. get_network → capture the response
2. Verify response structure:
   - Required fields present?
   - Data types correct? (string vs number vs boolean)
   - Null handling? (null vs undefined vs empty string)
   - Array responses: empty array vs null for "no results"
   - Date formats consistent? (ISO 8601?)
   - Pagination: correct page/limit/total?

3. Edge cases:
   mock_network({url_pattern:"/api/data", response_body:'[]'}) → empty array
   mock_network({url_pattern:"/api/data", response_body:'null'}) → null response
   mock_network({url_pattern:"/api/data", response_body:'{}'}) → empty object
   → For each: reload → screenshot → does UI handle it correctly?
\`\`\`

## Approach 4: API Performance Profiling
\`\`\`
get_network → sort by duration:
1. Any API call > 1000ms? → server-side performance issue
2. Any API call made multiple times? → redundant fetching
3. Are responses cached? → check Cache-Control headers
4. Sequential API calls that could be parallel? → batch/combine opportunity
5. Large payloads (> 100KB)? → pagination or field selection needed

Test under load:
network_throttle({preset:"slow-3g"}) → reload
get_network → which APIs are now the bottleneck?
network_throttle({preset:"none"})
\`\`\``,

chrome_internals: `# Chrome Internals — How the Browser Works

## Process Architecture (affects what the bridge can access)
\`\`\`
┌──────────────────────────────────────────────┐
│ Browser Process (1)                          │
│  - Tab management, URL bar, bookmarks        │
│  - Network requests (Network Service)        │
│  - File system access                        │
│  - Extension management                      │
│  - chrome:// pages (NOT scriptable)          │
├──────────────────────────────────────────────┤
│ Renderer Process (1 per site-instance)       │
│  - Blink: DOM, CSS, layout, paint            │
│  - V8: JavaScript execution                  │
│  - Our content script runs HERE              │
│  - One process per origin (Site Isolation)   │
│  - Cross-origin iframes = SEPARATE process   │
├──────────────────────────────────────────────┤
│ GPU Process (1)                              │
│  - Compositing layers → pixels               │
│  - screenshot captures THIS output           │
├──────────────────────────────────────────────┤
│ Extension Process (1 per extension)          │
│  - Our service worker runs HERE              │
│  - Communicates with renderers via IPC       │
└──────────────────────────────────────────────┘
\`\`\`

## Rendering Pipeline (what happens when CSS changes)
\`\`\`
DOM Change → Style Recalculation → Layout → Paint → Composite
  ↑              ↑                   ↑        ↑        ↑
  get_html    get_styles      get_element_rect  │   screenshot
                                              inject_css
\`\`\`

## What Each Tool Actually Accesses:
\`\`\`
chrome.scripting.executeScript (MAIN world):
  → Runs in the page's V8 context
  → Can access window, document, page's JS variables
  → Subject to page's CSP (eval may be blocked)
  → Used by: snapshot, click, fill, eval, get_html, get_styles

chrome.scripting.executeScript (ISOLATED world):
  → Separate V8 context, shares DOM but not JS
  → NOT subject to page CSP
  → Can't access window.__claudeBridge
  → Used by: some internal helpers

chrome.debugger (CDP):
  → Connects to the renderer's DevTools protocol
  → Bypasses all page-level restrictions
  → Shows yellow "debugging" bar
  → Only ONE per tab at a time
  → Used by: screenshot, performance_trace, a11y tree, mock_network

Content script (inject.js, MAIN world):
  → Injected at document_start on every page
  → Wraps console.*, fetch, XMLHttpRequest
  → Creates window.__claudeBridge with circular buffers
  → Persists through bfcache, lost on tab discard
\`\`\`

## CSP Levels and What They Block:
\`\`\`
No CSP:
  → Everything works. eval, inline scripts, all of it.
  → Also means: weaker XSS protection for the site

script-src without 'unsafe-eval':
  → eval tool BLOCKED (GitHub, MDN, CodePen pattern)
  → All other tools work fine
  → Site has good XSS protection

Trusted Types:
  → eval BLOCKED + innerHTML blocked for untrusted strings
  → YouTube, Google properties
  → Strongest XSS protection

Extension scripts bypass CSP?
  → ISOLATED world: YES (uses extension's CSP)
  → MAIN world with function ref: YES
  → MAIN world calling eval(): NO (page CSP applies to eval)
\`\`\`

## Navigation & Page Lifecycle:
\`\`\`
Fresh navigation: content script re-injects, buffers reset
bfcache restore: everything preserved (bridge, refs, buffers)
Tab discard: everything lost, re-injects on reload
Tab freeze: timers throttled, but listeners survive
Service Worker: separate context, bridge NOT present
Cross-origin iframe: separate process, bridge injects independently
\`\`\``,

element_inspection: `# Element-Level Browser Inspection

## Layer 1: Finding Elements
\`\`\`
diagnose/snapshot → interactive elements with refs (fastest)
get_html({selector:"..."}) → raw HTML structure of any element
eval: document.querySelectorAll("...") → programmatic DOM queries
get_accessibility_tree → semantic structure (roles, names, states)
\`\`\`

## Layer 2: Visual Properties
\`\`\`
get_styles({selector:"..."}) → ALL computed CSS:
  - Layout: display, position, flex, grid properties
  - Box model: width, height, margin, padding, border
  - Typography: font-family, font-size, font-weight, line-height, color
  - Visual: background, opacity, z-index, overflow, box-shadow
  - Transform: transform, transition

get_element_rect({selector:"...", include_children:true}) → geometry:
  - Exact viewport position (x, y, width, height)
  - z-index stacking order
  - opacity chain (parent opacity affects children)
  - Visibility state
  - All children with their positions
\`\`\`

## Layer 3: Stacking & Layering
\`\`\`
When elements overlap or z-index is wrong:
1. get_element_rect({include_children:true}) on the container
   → See z-index of every child
2. annotate({annotations:[...]}) → visually label each layer
3. screenshot → see the labeled state
4. inspect_pixel({selector:"...", x:50, y:50, percent:true})
   → What color is actually rendered at that point?
   → If transparent (a:0), the element you expect isn't on top
5. capture_canvas({selector:"..."}) → flatten all layers into one image
\`\`\`

## Layer 4: Shadow DOM Navigation
\`\`\`
Open shadow roots (most components):
  eval: el.shadowRoot.querySelector("...") → access inside
  eval: el.shadowRoot.innerHTML → read the shadow tree
  snapshot still finds interactive elements inside

Closed shadow roots (rare):
  Cannot access via JavaScript
  get_html shows the host element only
  screenshot captures the rendered output

Detecting shadow roots:
  eval: document.querySelectorAll('*').forEach(el => {
    if(el.shadowRoot) console.log(el.tagName, el.shadowRoot.childElementCount)
  })
\`\`\`

## Layer 5: Cross-Origin Iframes
\`\`\`
What you CAN inspect:
  - iframe element itself: position, size, attributes
  - Visual rendering (screenshot captures it)
  - Whether it loaded (check src, check get_network)

What you CANNOT inspect:
  - DOM inside cross-origin iframe
  - JavaScript state inside it
  - Network requests originating from it

Detecting cross-origin iframes:
  diagnose → crossOriginIframes array lists them
  eval: document.querySelectorAll('iframe').forEach(f => {
    try { f.contentDocument; console.log('same-origin:', f.src); }
    catch(e) { console.log('cross-origin:', f.src); }
  })
\`\`\`

## Layer 6: Dynamic Content & Mutations
\`\`\`
watch_dom_changes({selector:"...", duration_ms:5000})
  → Record all DOM mutations for 5 seconds
  → See: added nodes, removed nodes, attribute changes
  → Use while performing an action to see exactly what changes

For SPAs that update without navigation:
  click → wait_for({text:"expected result"}) → snapshot
  → Ensures you wait for dynamic content before reading
\`\`\``,

state_debugging: `# State Management Debugging

## Browser Storage Layers (from most to least persistent):
\`\`\`
1. Cookies:        get_cookies → server-set, sent with requests, security flags
2. localStorage:   get_storage → persistent, survives tab close, XSS-accessible
3. sessionStorage: get_storage({storage_type:"session"}) → per-tab, cleared on close
4. IndexedDB:      eval: indexedDB.databases().then(dbs=>JSON.stringify(dbs))
5. Cache API:      eval: caches.keys().then(k=>JSON.stringify(k))
6. JS variables:   eval: window.someGlobalStore → application state in memory
7. Service Worker: separate context, has its own Cache API and IndexedDB
\`\`\`

## Approach 1: State Snapshot & Diff
\`\`\`
Before an action:
  eval: JSON.stringify({
    localStorage: {...localStorage},
    sessionStorage: {...sessionStorage},
    cookies: document.cookie
  })

Perform the action (click, navigate, submit)

After the action:
  Same eval → compare the two snapshots
  What changed? What shouldn't have?
\`\`\`

## Approach 2: React/Vue/Angular State Inspection
\`\`\`
React:
  eval: document.querySelector('[data-reactroot]')?.__reactInternalInstance
  eval: window.__REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers
  eval: window.__NEXT_DATA__ (Next.js pages)

Vue:
  eval: document.querySelector('[data-v-app]')?.__vue_app__
  eval: document.querySelector('#app').__vue__.$data

Angular:
  eval: ng.getComponent(document.querySelector('app-root'))

Redux:
  eval: window.__REDUX_DEVTOOLS_EXTENSION__
  eval: store.getState() (if store is on window)

Generic hydration data:
  eval: document.querySelector('script#__NEXT_DATA__')?.textContent
  eval: document.querySelectorAll('script[type="application/json"]')
\`\`\`

## Approach 3: Clean Slate Isolation
\`\`\`
To determine if a bug is caused by stale state:
1. Capture current state (storage, cookies)
2. set_storage({action:"clear"}) → clear localStorage
3. set_storage({action:"clear", storage_type:"session"}) → clear sessionStorage
4. eval: document.cookie.split(';').forEach(c => {
     document.cookie = c.split('=')[0] + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
   })
5. reload({bypass_cache:true}) → completely fresh load
6. Does the bug disappear? → stale state was the cause
7. If yes: binary search — restore state items one by one to find the culprit
\`\`\``,

network_debugging: `# Network Debugging Methodology

## Layer 1: Request/Response Analysis
\`\`\`
get_network → all captured requests with:
  method, url, status, duration, response body (for failures)

Filters for focused investigation:
  get_network({url_contains:"/api/"}) → only API calls
  get_network({only_failures:true}) → only failures
  search_network_bodies({query:"error"}) → find error messages
  search_network_bodies({query:"fieldName"}) → find specific data
\`\`\`

## Layer 2: CORS Debugging
\`\`\`
Symptoms: "Access-Control-Allow-Origin" error in console, requests blocked

1. get_console → find the exact CORS error message
2. get_network → find the failed request:
   - Is it a preflight (OPTIONS) that failed?
   - Is the origin allowed?
   - Are the required headers allowed?

3. Common CORS fixes to verify:
   - Access-Control-Allow-Origin matches the requesting origin
   - Access-Control-Allow-Methods includes the request method
   - Access-Control-Allow-Headers includes custom headers
   - Access-Control-Allow-Credentials: true if sending cookies
\`\`\`

## Layer 3: Caching Behavior
\`\`\`
1. eval: performance.getEntriesByType('resource').map(r => ({
     name: r.name.slice(-60),
     cached: r.transferSize === 0,
     size: r.encodedBodySize,
     protocol: r.nextHopProtocol
   }))
   → Which resources are served from cache vs network?

2. reload({bypass_cache:true}) → force fresh load
   → Compare performance before/after → cache impact

3. eval: caches.keys() → list Cache API caches
   eval: caches.open('cacheName').then(c=>c.keys().then(k=>k.map(r=>r.url)))
   → Inspect what's in each cache
\`\`\`

## Layer 4: Service Worker Inspection
\`\`\`
1. eval: navigator.serviceWorker?.controller?.scriptURL
   → Is a SW controlling this page?

2. eval: navigator.serviceWorker?.getRegistrations().then(regs =>
     JSON.stringify(regs.map(r => ({scope:r.scope, active:r.active?.state}))))
   → All SW registrations

3. The bridge does NOT capture SW network traffic
   → If requests "disappear", the SW may be intercepting and responding from cache
   → get_network only shows requests that reach the page context
\`\`\`

## Layer 5: WebSocket Debugging
\`\`\`
Bridge limitation: WebSocket frames are NOT captured

Detect WS connections:
  eval: performance.getEntriesByType('resource')
    .filter(r => r.name.startsWith('wss://') || r.name.startsWith('ws://'))
  → Shows WS connection URLs

Observe WS effects:
  screenshot at intervals → see real-time data updates
  get_page_text at intervals → see text content changes
  watch_dom_changes({duration_ms:5000}) → see DOM mutations from WS messages
\`\`\``,

proactive_patterns: `# Proactive Scanning Patterns — Find Problems Before They're Reported

## Pattern 1: Broken Resource Sweep
\`\`\`
eval: (() => {
  const broken = [];
  document.querySelectorAll('img').forEach(img => {
    if (!img.naturalWidth && img.src) broken.push({type:'img', src:img.src.slice(0,100)});
  });
  document.querySelectorAll('link[rel=stylesheet]').forEach(link => {
    if (link.sheet === null) broken.push({type:'css', href:link.href.slice(0,100)});
  });
  document.querySelectorAll('script[src]').forEach(script => {
    // Script errors are in console
  });
  return JSON.stringify(broken, null, 2);
})()
+ get_console → check for 404 errors on resources
+ get_network({only_failures:true}) → any failed resource loads
\`\`\`

## Pattern 2: Accessibility Sweep
\`\`\`
eval: (() => {
  const issues = [];
  // Images without alt
  document.querySelectorAll('img:not([alt])').forEach(img =>
    issues.push({issue:'img-no-alt', src:img.src?.slice(0,80)}));
  // Buttons without accessible name
  document.querySelectorAll('button').forEach(btn => {
    if (!btn.textContent?.trim() && !btn.getAttribute('aria-label'))
      issues.push({issue:'button-no-name', html:btn.outerHTML.slice(0,100)});
  });
  // Inputs without labels
  document.querySelectorAll('input:not([type=hidden])').forEach(inp => {
    if (!inp.labels?.length && !inp.getAttribute('aria-label') && !inp.placeholder)
      issues.push({issue:'input-no-label', name:inp.name, type:inp.type});
  });
  // Links without text
  document.querySelectorAll('a[href]').forEach(a => {
    if (!a.textContent?.trim() && !a.getAttribute('aria-label') && !a.querySelector('img[alt]'))
      issues.push({issue:'link-no-text', href:a.href?.slice(0,80)});
  });
  // Heading hierarchy
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')];
  for (let i = 1; i < headings.length; i++) {
    const prev = +headings[i-1].tagName[1];
    const curr = +headings[i].tagName[1];
    if (curr > prev + 1) issues.push({issue:'heading-skip', from:'h'+prev, to:'h'+curr});
  }
  return JSON.stringify(issues, null, 2);
})()
\`\`\`

## Pattern 3: Security Quick Scan
\`\`\`
eval: (() => {
  const risks = [];
  // Check for sensitive data in DOM
  const html = document.body.innerHTML;
  if (html.includes('<!--')) risks.push('HTML comments present (may contain sensitive info)');
  document.querySelectorAll('input[type=hidden]').forEach(h => {
    if (h.name.match(/token|key|secret|csrf/i))
      risks.push('Hidden input with sensitive name: ' + h.name);
  });
  // Check for inline event handlers (XSS surface)
  const inlineHandlers = document.querySelectorAll('[onclick],[onload],[onerror],[onmouseover]');
  if (inlineHandlers.length) risks.push(inlineHandlers.length + ' inline event handlers found');
  // Check for http:// resources on https:// page
  if (location.protocol === 'https:') {
    document.querySelectorAll('[src^="http:"]').forEach(el =>
      risks.push('Mixed content: ' + el.tagName + ' loads ' + el.src.slice(0,80)));
  }
  // Check for target=_blank without rel=noopener
  document.querySelectorAll('a[target=_blank]:not([rel*=noopener])').forEach(a =>
    risks.push('target=_blank without noopener: ' + a.href?.slice(0,80)));
  return JSON.stringify(risks, null, 2);
})()
+ get_cookies → check security flags
+ diagnose → check cspBlocksEval (false = weak XSS protection in production)
\`\`\`

## Pattern 4: Performance Red Flags
\`\`\`
eval: (() => {
  const flags = [];
  // Large DOM
  const nodeCount = document.querySelectorAll('*').length;
  if (nodeCount > 1500) flags.push('Large DOM: ' + nodeCount + ' nodes (target: < 1500)');
  // Synchronous scripts in head
  document.querySelectorAll('head script[src]:not([async]):not([defer])').forEach(s =>
    flags.push('Render-blocking script: ' + s.src.slice(-60)));
  // Images without dimensions
  document.querySelectorAll('img:not([width]):not([style*=width])').forEach(img =>
    flags.push('Image without dimensions (causes CLS): ' + img.src?.slice(-60)));
  // Large images
  document.querySelectorAll('img').forEach(img => {
    if (img.naturalWidth > 2000)
      flags.push('Oversized image (' + img.naturalWidth + 'px): ' + img.src?.slice(-60));
  });
  // Too many event listeners (potential leak)
  if (typeof getEventListeners === 'function') {
    // Only works in DevTools console, not in extension
  }
  return JSON.stringify(flags, null, 2);
})()
\`\`\`

## Pattern 5: Functional Integrity Sweep
\`\`\`
eval: (() => {
  const issues = [];
  // Dead links
  document.querySelectorAll('a[href]').forEach(a => {
    if (a.href === '' || a.href === '#' || a.href === 'javascript:void(0)')
      issues.push({issue:'dead-link', text:a.textContent?.slice(0,40)});
  });
  // Empty interactive elements
  document.querySelectorAll('button,a,[role=button]').forEach(el => {
    if (!el.textContent?.trim() && !el.querySelector('img,svg') && !el.getAttribute('aria-label'))
      issues.push({issue:'empty-interactive', tag:el.tagName, html:el.outerHTML.slice(0,80)});
  });
  // Forms without action
  document.querySelectorAll('form:not([action])').forEach(f =>
    issues.push({issue:'form-no-action', inputs:f.querySelectorAll('input').length}));
  // Console errors already present
  // (checked via get_console separately)
  return JSON.stringify(issues, null, 2);
})()
+ get_console → any existing JS errors?
+ get_network({only_failures:true}) → any failed requests?
\`\`\`

## Pattern 6: Multi-Page Consistency Sweep
\`\`\`
For a list of URLs/pages in the app:
For each page:
  1. new_tab({url}) → wait_for({selector:"main"})
  2. diagnose → check errors + snapshot
  3. screenshot → save for comparison
  4. Run Pattern 3 (security scan) + Pattern 4 (performance flags)
  5. get_styles on common elements (header, footer, nav)
  6. close_tab

After sweep:
  - Compare screenshots across pages (consistent layout?)
  - Compare errors across pages (systemic issues?)
  - Compare styles on shared elements (inconsistent spacing/fonts?)
\`\`\``,

quick_reference: `# Quick Reference — What to Do for Any Problem

## Decision Tree: Which approach for which problem?

Visual bug? → batch([screenshot, get_styles({selector:".broken"})]) → inject_css fix → screenshot
Broken feature? → diagnose (check consoleErrors + failedRequests) → click action → get_console + get_network
Wrong data? → get_network({url_contains:"/api/"}) → search_network_bodies("value") → eval for state
Security check? → get_cookies (flags) + get_network (tokens in URLs?) + get_html (reflected input?)
Slow page? → performance_trace (Web Vitals) → get_load_timeline (waterfall)
A11y audit? → get_accessibility_tree → check_contrast on key elements
API failure? → diagnose (failedRequests) → get_network({only_failures:true}) → mock_network for testing
Regression? → screenshot (save) → fix → visual_diff → record_actions/replay

## Security Checklist (10 points)
1. get_cookies → HttpOnly? Secure? SameSite? reasonable expiration?
2. get_network → tokens/keys in URLs? (never put secrets in URLs)
3. search_network_bodies("token") → where do tokens appear?
4. fill XSS payload → get_html → reflected unescaped?
5. get_html → hidden fields, HTML comments, JSON data with secrets?
6. get_network → any http:// on https:// page? (mixed content)
7. diagnose → cspBlocksEval false = weaker XSS protection
8. get_storage → tokens in localStorage? (XSS can steal them)
9. get_cookies → session cookie without Secure flag?
10. get_network → Access-Control-Allow-Origin: * with credentials?

## Chrome Edge Cases (handled automatically)
- eval on CSP-strict sites (GitHub/YouTube): Uses CDP Runtime.evaluate, bypasses CSP
- Debugger conflicts in batch: CDP session manager queues operations automatically
- Screenshots: CDP Page.captureScreenshot works on background tabs, no focus stealing
- React portals/Shadow DOM: Snapshot scans portal containers + walks shadow roots
- Post-click staleness: MutationObserver waits for DOM to stabilize after click
- Keyboard events: CDP Input.dispatchKeyEvent produces isTrusted:true events
- wait_for: MutationObserver for instant detection (0ms if already present)
- chrome:// pages: Detected early with clear error message
- Transparent backgrounds: check_contrast walks up parent chain

## Anti-Patterns (don't do these)
- Don't retry eval on CSP error — it now auto-falls back to CDP
- Don't call tools one at a time — use batch for independent calls
- Don't guess CSS values — use get_styles to read actual computed values
- Don't navigate app tab for research — use new_tab + close_tab
- Don't claim fix works without screenshot verification
- Don't batch is fine now — CDP session manager handles all queuing

## How to Start Any Investigation
1. Call bridge_knowledge("full_site_audit") for the complete methodology
2. Or call diagnose as the single first step (covers 80% of needs)
3. Then use bridge_knowledge with specific topic for deep dives
`,

devtools_workarounds: `# Chrome DevTools Feature Workarounds

When you need a DevTools feature the bridge doesn't have a dedicated tool for,
use these workarounds with existing tools.

## CSS Debugging (Elements Panel equivalent)

### Which CSS rule applies to an element?
DevTools: Elements → Styles pane shows matched rules with specificity
Bridge workaround:
\`\`\`
get_styles({selector:".target"}) → shows COMPUTED values (what's actually applied)
get_html({selector:".target"}) → shows classes/inline styles
eval: getComputedStyle(el).cssText → full computed CSS
eval: el.classList.toString() → all CSS classes
\`\`\`

### What event listeners are on an element?
DevTools: Elements → Event Listeners tab
Bridge workaround:
\`\`\`
eval: (() => {
  const el = document.querySelector('.target');
  const listeners = getEventListeners?.(el); // only works in DevTools console
  // Alternative: check for known handlers
  return JSON.stringify({
    onclick: !!el.onclick,
    hasClickAttr: el.hasAttribute('onclick'),
    dataHandlers: [...el.attributes].filter(a => a.name.startsWith('data-') || a.name.startsWith('on'))
      .map(a => a.name + '=' + a.value.slice(0,50))
  });
})()
\`\`\`

### Force :hover/:focus/:active state?
DevTools: Elements → :hov toggle
Bridge: hover({ref:"ref_X"}) for :hover
For :focus: click({ref:"ref_X"}) then eval: document.activeElement.tagName

### Track CSS changes made during session?
DevTools: Changes panel
Bridge: Use visual_diff — screenshot before → make changes → visual_diff shows what changed

## Network Debugging (Network Panel equivalent)

### See response body of successful requests?
DevTools: Network → click request → Response tab
Bridge workaround:
\`\`\`
get_network → shows response bodies for FAILURES only
search_network_bodies({query:"keyword"}) → search ALL response bodies
eval: fetch('/api/endpoint').then(r=>r.text()).then(t=>t.slice(0,2000)) → re-fetch the endpoint
\`\`\`

### See WebSocket frames?
DevTools: Network → WS filter → click connection → Messages tab
Bridge workaround:
\`\`\`
eval: (() => {
  // Detect WS connections
  const entries = performance.getEntriesByType('resource')
    .filter(r => r.name.startsWith('wss://') || r.name.startsWith('ws://'));
  return JSON.stringify(entries.map(r => ({url: r.name, duration: r.duration})));
})()
// For WS message content: watch DOM changes that result from WS messages
watch_dom_changes({duration_ms: 5000}) → see what WS data updates in the UI
\`\`\`

### See request initiator chain?
DevTools: Network → click request → Initiator tab
Bridge: get_console → stack traces show what code made the call

### Block specific URLs?
DevTools: Network → right-click → Block request URL
Bridge: mock_network({url_pattern: "/blocked-resource", status_code: 404})

## Performance Debugging (Performance Panel equivalent)

### CPU profiling / find slow functions?
DevTools: Performance panel → Record → CPU flame chart
Bridge workaround:
\`\`\`
eval: (() => {
  const start = performance.now();
  // Measure specific operations
  return JSON.stringify(performance.getEntriesByType('measure')
    .map(m => ({name: m.name, duration: Math.round(m.duration)})));
})()
// Or use performance marks around suspect code
eval: performance.mark('start-suspect')
// ... trigger the slow action
eval: performance.measure('suspect-op', 'start-suspect')
\`\`\`

### Paint flashing / see what repaints?
DevTools: Rendering → Paint flashing
Bridge workaround:
\`\`\`
// Take screenshots at short intervals and visual_diff them
screenshot → save → wait 1s → visual_diff → red areas = repaints

// Or check for expensive layout properties
eval: (() => {
  const expensive = [];
  document.querySelectorAll('*').forEach(el => {
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed' || cs.position === 'sticky') expensive.push(el.tagName + '.' + el.className.split(' ')[0]);
    if (cs.willChange && cs.willChange !== 'auto') expensive.push(el.tagName + ' will-change:' + cs.willChange);
  });
  return JSON.stringify(expensive);
})()
\`\`\`

### INP (Interaction to Next Paint)?
DevTools: Performance → check INP in Web Vitals lane
Bridge workaround:
\`\`\`
eval: (() => {
  return new Promise(resolve => {
    new PerformanceObserver(list => {
      const entries = list.getEntries();
      resolve(JSON.stringify(entries.map(e => ({
        name: e.name, duration: Math.round(e.duration),
        processingStart: Math.round(e.processingStart),
        processingEnd: Math.round(e.processingEnd)
      }))));
    }).observe({type: 'event', durationThreshold: 16, buffered: true});
  });
})()
\`\`\`

## Memory Debugging (Memory Panel equivalent)

### Detect memory leaks?
DevTools: Memory → Heap snapshot → compare two snapshots
Bridge workaround:
\`\`\`
// Take measurements over time
heap_snapshot_summary → record usedMB, nodeCount
// Interact with the page (open/close dialogs, navigate)
heap_snapshot_summary → compare
// Repeat 5 times — if usedMB or nodeCount keeps growing → LEAK

// Detect detached DOM nodes
eval: (() => {
  const nodeCount = document.querySelectorAll('*').length;
  // After interaction that should clean up:
  return 'DOM nodes: ' + nodeCount;
})()
// If count grows after opening/closing the same dialog → detached nodes leaking
\`\`\`

### Force garbage collection?
DevTools: Performance panel → trash can icon
Bridge: eval: window.gc?.() (only works with --js-flags="--expose-gc")
Alternative: Navigate away and back — forces GC

## Application Panel Equivalents

### Inspect IndexedDB?
DevTools: Application → IndexedDB
Bridge:
\`\`\`
eval: (() => {
  return new Promise(resolve => {
    indexedDB.databases().then(dbs =>
      resolve(JSON.stringify(dbs.map(d => ({name: d.name, version: d.version}))))
    );
  });
})()
\`\`\`

### Inspect Cache Storage?
DevTools: Application → Cache Storage
Bridge:
\`\`\`
eval: (() => {
  return new Promise(resolve => {
    caches.keys().then(async keys => {
      const result = {};
      for (const key of keys) {
        const cache = await caches.open(key);
        const requests = await cache.keys();
        result[key] = requests.map(r => r.url).slice(0, 20);
      }
      resolve(JSON.stringify(result, null, 2));
    });
  });
})()
\`\`\`

### Service Worker status?
DevTools: Application → Service Workers
Bridge:
\`\`\`
eval: (() => {
  return new Promise(resolve => {
    navigator.serviceWorker?.getRegistrations().then(regs =>
      resolve(JSON.stringify(regs.map(r => ({
        scope: r.scope,
        active: r.active?.state,
        waiting: r.waiting?.state,
        installing: r.installing?.state,
        scriptURL: r.active?.scriptURL
      }))))
    );
  });
})()
\`\`\`

### Unregister a Service Worker?
Bridge:
\`\`\`
eval: (() => {
  return new Promise(resolve => {
    navigator.serviceWorker?.getRegistrations().then(async regs => {
      for (const r of regs) await r.unregister();
      resolve('Unregistered ' + regs.length + ' service workers');
    });
  });
})()
\`\`\`

## Rendering Panel Equivalents

### Test print layout?
DevTools: Rendering → Emulate CSS media → print
Bridge: eval: document.body.classList.add('print-preview') — if the site has print CSS
Alternative: export_pdf → see how the page renders for print

### Test reduced motion?
DevTools: Rendering → prefers-reduced-motion
Bridge:
\`\`\`
eval: (() => {
  const style = document.createElement('style');
  style.textContent = '*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }';
  document.head.appendChild(style);
  return 'Animations disabled';
})()
\`\`\`

### Find unused CSS/JS (Coverage panel)?
DevTools: Coverage panel
Bridge workaround:
\`\`\`
eval: (() => {
  const stylesheets = [...document.styleSheets];
  let totalRules = 0, usedRules = 0;
  for (const sheet of stylesheets) {
    try {
      for (const rule of sheet.cssRules) {
        totalRules++;
        if (rule.selectorText && document.querySelector(rule.selectorText)) usedRules++;
      }
    } catch(e) {} // cross-origin sheets
  }
  return JSON.stringify({totalCSSRules: totalRules, usedCSSRules: usedRules,
    unusedPercent: Math.round((1 - usedRules/totalRules) * 100) + '%'});
})()
\`\`\`

## Security Panel Equivalents

### Check TLS certificate?
DevTools: Security panel
Bridge:
\`\`\`
eval: JSON.stringify({
  protocol: location.protocol,
  secure: isSecureContext,
  // Can't access certificate details from JS — use get_network to check for mixed content
})
get_network → filter for http:// requests on https:// page (mixed content)
get_cookies → check Secure flag on all cookies
\`\`\`

## Summary: What You Can't Workaround

These DevTools features have NO bridge workaround and would need dedicated CDP implementation:
1. Full heap snapshot with object retention graph — HeapProfiler.takeHeapSnapshot
2. CPU flame chart profiling — Profiler.start/stop
3. Paint/layout/composite rendering performance — Tracing domain
4. CSS Grid/Flexbox overlay visualization — Overlay domain
5. JS breakpoint debugging (step through code) — Debugger domain
6. Real-time performance monitor graph — Performance.getMetrics on interval

For these, tell the user to open Chrome DevTools directly (F12).
`
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [HELP_TOOL, KNOWLEDGE_TOOL, OBSERVE_TOOL, CURSOR_TOOL, BATCH_TOOL, ...TOOLS] }));

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
  if (name === "capture_canvas" && result?.dataUrl) {
    const base64 = result.dataUrl.replace(/^data:image\/png;base64,/, "");
    const { dataUrl, ...rest } = result;
    return {
      content: [
        { type: "image", data: base64, mimeType: "image/png" },
        { type: "text", text: JSON.stringify(rest, null, 2) },
      ],
    };
  }
  if (name === "compare_tabs" && result?.diffImage) {
    const diffBase64 = result.diffImage.replace(/^data:image\/png;base64,/, "");
    return {
      content: [
        { type: "text", text: `Diff: ${result.diffPercent}% changed (${result.diffPixels} pixels)` },
        { type: "image", data: diffBase64, mimeType: "image/png" },
      ],
    };
  }
  // Video frame capture: return the screenshot as an image
  if (name === "video_capture_frame" && result?.dataUrl) {
    const base64 = result.dataUrl.replace(/^data:image\/png;base64,/, "");
    const { dataUrl, ...rest } = result;
    return {
      content: [
        { type: "image", data: base64, mimeType: "image/png" },
        { type: "text", text: JSON.stringify(rest, null, 2) },
      ],
    };
  }
  // Observe mode: if the response includes an auto-captured screenshot, return it as an image
  if (result?.__screenshot) {
    const base64 = result.__screenshot.replace(/^data:image\/png;base64,/, "");
    const { __screenshot, ...rest } = result;
    return {
      content: [
        { type: "text", text: JSON.stringify(rest, null, 2) },
        { type: "image", data: base64, mimeType: "image/png" },
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

    // Knowledge: return deep expertise by topic (no extension needed).
    if (name === "bridge_knowledge") {
      const topic = args?.topic?.toLowerCase?.()?.replace(/[^a-z_]/g, '_') || '';
      const content = KNOWLEDGE[topic];
      if (!content) {
        const topics = Object.keys(KNOWLEDGE).join(', ');
        return { content: [{ type: "text", text: `Unknown topic "${args?.topic}". Available topics: ${topics}` }] };
      }
      return { content: [{ type: "text", text: content }] };
    }

    // Cursor mode: toggle visual cursor (handled by extension, but also pass through)
    // (falls through to callExtension like other tools)

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
