// Service worker: keeps a WebSocket open to the local bridge (ws://localhost:8787)
// and executes tool calls against the user's real tabs.
// v0.4 — performance-optimized: batch calls, parallel execution, cached state,
// deferred marker, eliminated redundant script injections.

importScripts("config.js");

const BRIDGE_URL = "ws://localhost:8787";
let socket = null;
let connecting = false;

function ensureConnected() {
  if (connecting || (socket && socket.readyState <= WebSocket.OPEN)) return;
  connecting = true;
  try {
    socket = new WebSocket(BRIDGE_URL);
  } catch (e) {
    connecting = false;
    return;
  }
  socket.onopen = () => {
    connecting = false;
    socket.send(JSON.stringify({ type: "auth", token: BRIDGE_TOKEN }));
  };
  socket.onclose = () => {
    connecting = false;
    socket = null;
    setTimeout(ensureConnected, 1000); // was 3000 — faster reconnect
  };
  socket.onerror = () => {};
  socket.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "pong") return;

    // Batch support: handle array of calls concurrently.
    if (msg.method === "batch" && Array.isArray(msg.params?.calls)) {
      const results = await Promise.all(
        msg.params.calls.map(async (call) => {
          try {
            return { ok: true, result: await handle(call) };
          } catch (e) {
            return { ok: false, error: String(e?.message || e) };
          }
        })
      );
      socket?.send(JSON.stringify({ id: msg.id, ok: true, result: results }));
      return;
    }

    try {
      const result = await handle(msg);
      socket?.send(JSON.stringify({ id: msg.id, ok: true, result }));
    } catch (e) {
      socket?.send(JSON.stringify({ id: msg.id, ok: false, error: String(e?.message || e) }));
    }
  };
}

// F1 FIX: Aggressive keepalive to prevent Chrome from killing the service worker.
// MV3 workers die after 30s of inactivity. We use three strategies:
// 1. WebSocket pings every 20s (keeps the worker "active" with pending I/O)
// 2. chrome.alarms at minimum interval (fires every ~20-30s)
// 3. Any incoming message from popup wakes the worker via onMessage
setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "ping" }));
  } else {
    ensureConnected();
  }
}, 20000);

chrome.alarms.create("bridge-keepalive", { periodInMinutes: 1/3 });
chrome.alarms.onAlarm.addListener(() => ensureConnected());
chrome.runtime.onStartup.addListener(() => ensureConnected());
chrome.runtime.onInstalled.addListener(() => ensureConnected());
// Extra wake-up: any tab update triggers a connection check
chrome.tabs.onActivated.addListener(() => ensureConnected());

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "status") {
    sendResponse({ connected: socket?.readyState === WebSocket.OPEN });
  }
});

// ---------------------------------------------------------------------------
// Tab targeting & caching
// ---------------------------------------------------------------------------

let targetTabId = null;
let markedTabId = null;
let markerGrouped = false;
let observeMode = false; // when true, interaction tools auto-capture screenshot in response
let cursorMode = false; // when true, visual cursor animates to targets before interactions
const injectedTabs = new Set();

// ---------------------------------------------------------------------------
// CDP Session Manager — persistent, queued, auto-releasing
// ---------------------------------------------------------------------------
// Instead of attach/detach per operation, we keep a persistent CDP session
// per tab and queue all operations through it. This fixes:
// 1. Batch debugger conflicts (operations serialize instead of failing)
// 2. ~100ms overhead per attach/detach cycle eliminated
// 3. Yellow "debugging" bar auto-hides after 30s of inactivity

const cdpSessions = new Map(); // tabId → { attached, queue, idleTimer, useCount }
const CDP_IDLE_MS = 30000;

async function cdpAttach(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    return true;
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes("already attached") || msg.includes("Already attached") || msg.includes("Another debugger")) return true;
    if (msg.includes("Cannot attach") || msg.includes("Cannot access")) {
      throw new Error(
        `Cannot attach debugger to this tab. Chrome blocks debugger on chrome://, ` +
        `Chrome Web Store, and other protected pages. Tools that DO work without debugger: ` +
        `snapshot, get_html, get_styles, get_console, get_network, click, fill.`
      );
    }
    throw e;
  }
}

function releaseCDP(tabId) {
  const session = cdpSessions.get(tabId);
  if (!session || !session.attached) return;
  chrome.debugger.detach({ tabId }).catch(() => {});
  session.attached = false;
}

function withCDP(tabId, fn) {
  let session = cdpSessions.get(tabId);
  if (!session) {
    session = { attached: false, queue: Promise.resolve(), idleTimer: null, useCount: 0 };
    cdpSessions.set(tabId, session);
  }
  // Chain on the current queue head THEN reassign — this ensures true serialization
  // even when multiple withCDP calls happen synchronously (e.g. in batch Promise.all)
  const prev = session.queue;
  const next = prev.then(async () => {
    if (!session.attached) {
      await cdpAttach(tabId);
      session.attached = true;
    }
    clearTimeout(session.idleTimer);
    session.useCount++;
    try {
      return await fn(tabId);
    } finally {
      session.idleTimer = setTimeout(() => releaseCDP(tabId), CDP_IDLE_MS);
    }
  }).catch(async (err) => {
    const msg = String(err?.message || err);
    if (msg.includes("Debugger is not attached") || msg.includes("Target closed")) {
      session.attached = false;
      cdpSessions.delete(tabId);
    }
    throw err;
  });
  session.queue = next;
  return next;
}

// Convenience: send a CDP command through the session
function cdpSend(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    const session = cdpSessions.get(source.tabId);
    if (session) { session.attached = false; clearTimeout(session.idleTimer); }
    cdpSessions.delete(source.tabId);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  const session = cdpSessions.get(tabId);
  if (session) clearTimeout(session.idleTimer);
  cdpSessions.delete(tabId);
  injectedTabs.delete(tabId);
});

chrome.storage.session
  .get("targetTabId")
  .then(({ targetTabId: saved }) => { if (saved) targetTabId = saved; })
  .catch(() => {});

async function resolveTab(params) {
  if (params?.tab_id) return chrome.tabs.get(params.tab_id);
  if (targetTabId !== null) {
    try {
      return await chrome.tabs.get(targetTabId);
    } catch {
      targetTabId = null;
      chrome.storage.session.remove("targetTabId");
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("No active tab found");
  return tab;
}

// ---------------------------------------------------------------------------
// Visual marker (deferred — runs after response is sent for non-select_tab calls)
// ---------------------------------------------------------------------------

function pageMarker(show) {
  const ID = "__claude_bridge_marker__";
  const FAV_ID = "__claude_bridge_favicon__";
  const PREFIX = "\u{1F916} ";
  let el = document.getElementById(ID);
  if (show) {
    if (!el) {
      el = document.createElement("div");
      el.id = ID;
      el.style.cssText =
        "position:fixed;inset:0;border:3px solid #D97757;z-index:2147483647;pointer-events:none;box-sizing:border-box;print-color-adjust:exact;";
      const printStyle = document.createElement("style");
      printStyle.textContent = "@media print { #__claude_bridge_marker__ { display: none !important; } }";
      document.head?.appendChild(printStyle);
      const badge = document.createElement("div");
      badge.textContent = "Claude Code";
      badge.style.cssText =
        "position:absolute;top:0;right:16px;background:#D97757;color:#fff;" +
        "font:600 11px/1.7 -apple-system,BlinkMacSystemFont,sans-serif;" +
        "padding:1px 10px;border-radius:0 0 6px 6px;";
      el.appendChild(badge);
      (document.body || document.documentElement).appendChild(el);
    }
    if (!document.title.startsWith(PREFIX)) document.title = PREFIX + document.title;
    if (!document.getElementById(FAV_ID)) {
      const link = document.createElement("link");
      link.id = FAV_ID;
      link.rel = "icon";
      link.href =
        "data:image/svg+xml," +
        encodeURIComponent(
          "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>" +
            "<circle cx='16' cy='16' r='16' fill='#D97757'/>" +
            "<text x='16' y='23' font-family='Arial' font-size='20' font-weight='bold' text-anchor='middle' fill='#fff'>C</text>" +
            "</svg>"
        );
      document.head?.appendChild(link);
    }
  } else {
    el?.remove();
    if (document.title.startsWith(PREFIX)) document.title = document.title.slice(PREFIX.length);
    document.getElementById(FAV_ID)?.remove();
    const orig = document.querySelector("link[rel~='icon']:not(#" + FAV_ID + ")");
    if (orig) orig.parentNode.appendChild(orig);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Visual cursor overlay (injected into the page via execInTab)
// ---------------------------------------------------------------------------

function pageCursorSystem(action, params) {
  const CID = '__claude_cursor__';
  const LID = '__claude_cursor_label__';
  const SID = '__claude_cursor_style__';
  const RC = '__claude_ripple__';
  const TC = '__claude_typing_indicator__';

  if (!document.getElementById(SID)) {
    const s = document.createElement('style');
    s.id = SID;
    s.textContent = `
      #${CID}{position:fixed;z-index:2147483647;pointer-events:none;width:20px;height:20px;opacity:0;
        transition:left .35s cubic-bezier(.22,1,.36,1),top .35s cubic-bezier(.22,1,.36,1),opacity .15s;
        filter:drop-shadow(0 1px 3px rgba(0,0,0,.3))}
      #${LID}{position:fixed;z-index:2147483647;pointer-events:none;
        font:600 11px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;
        background:#D97757;color:#fff;padding:2px 10px;border-radius:4px;white-space:nowrap;opacity:0;
        transition:left .35s cubic-bezier(.22,1,.36,1),top .35s cubic-bezier(.22,1,.36,1),opacity .2s;
        box-shadow:0 2px 8px rgba(0,0,0,.15)}
      .${RC}{position:fixed;z-index:2147483646;pointer-events:none;width:30px;height:30px;border-radius:50%;
        background:rgba(217,119,87,.35);transform:scale(0);animation:__cr__ .5s ease-out forwards}
      @keyframes __cr__{0%{transform:scale(0);opacity:.6}100%{transform:scale(2.5);opacity:0}}
      .${TC}{animation:__ct__ .8s ease-in-out infinite;outline:2px solid #D97757!important;outline-offset:2px}
      @keyframes __ct__{0%,100%{box-shadow:0 0 0 2px rgba(217,119,87,.3)}50%{box-shadow:0 0 0 5px rgba(217,119,87,.5)}}
      .__claude_highlight_flash__{animation:__chf__ .4s ease-out;outline:2px solid #D97757;outline-offset:2px}
      @keyframes __chf__{0%{outline-color:rgba(217,119,87,.8);outline-width:3px}100%{outline-color:rgba(217,119,87,0);outline-width:0}}
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  let cursor = document.getElementById(CID);
  let label = document.getElementById(LID);
  if (!cursor) {
    cursor = document.createElement('div');
    cursor.id = CID;
    cursor.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24">' +
      '<path d="M5.5 3.21V20.8l5.71-5.71h8.79L5.5 3.21z" fill="#D97757" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    (document.body || document.documentElement).appendChild(cursor);
  }
  if (!label) {
    label = document.createElement('div');
    label.id = LID;
    (document.body || document.documentElement).appendChild(label);
  }

  if (action === 'show') {
    cursor.style.left = (params.x - 2) + 'px';
    cursor.style.top = (params.y - 2) + 'px';
    cursor.style.opacity = '1';
    if (params.label) {
      label.textContent = params.label;
      label.style.left = (params.x + 22) + 'px';
      label.style.top = (params.y - 6) + 'px';
      label.style.opacity = '1';
    }
    return true;
  }
  if (action === 'move') {
    cursor.style.opacity = '1';
    cursor.style.left = (params.x - 2) + 'px';
    cursor.style.top = (params.y - 2) + 'px';
    if (params.label) {
      label.textContent = params.label;
      label.style.left = (params.x + 22) + 'px';
      label.style.top = (params.y - 6) + 'px';
      label.style.opacity = '1';
    } else {
      label.style.opacity = '0';
    }
    return true;
  }
  if (action === 'ripple') {
    const r = document.createElement('div');
    r.className = RC;
    r.style.left = (params.x - 15) + 'px';
    r.style.top = (params.y - 15) + 'px';
    (document.body || document.documentElement).appendChild(r);
    setTimeout(() => r.remove(), 600);
    return true;
  }
  if (action === 'typing') {
    if (params.el) params.el.classList.toggle(TC, params.on);
    return true;
  }
  if (action === 'flash') {
    if (params.el) {
      params.el.classList.add('__claude_highlight_flash__');
      setTimeout(() => params.el.classList.remove('__claude_highlight_flash__'), 500);
    }
    return true;
  }
  if (action === 'hide') {
    cursor.style.opacity = '0';
    label.style.opacity = '0';
    return true;
  }
  if (action === 'destroy') {
    document.getElementById(CID)?.remove();
    document.getElementById(LID)?.remove();
    document.querySelectorAll('.' + RC).forEach(e => e.remove());
    document.querySelectorAll('.' + TC).forEach(e => e.classList.remove(TC));
    return true;
  }
  return false;
}

async function applyMarker(tabId, show) {
  try {
    const t = await chrome.tabs.get(tabId);
    if (t.url?.startsWith("file://") || t.url?.startsWith("chrome://")) return;
    await chrome.scripting.executeScript({ target: { tabId }, func: pageMarker, args: [show] });
  } catch {}
}

async function setMarker(tabId, skipGroup) {
  if (markedTabId === tabId) return;
  if (markedTabId !== null) {
    applyMarker(markedTabId, false);
    if (markerGrouped) {
      chrome.tabs.ungroup(markedTabId).catch(() => {});
      markerGrouped = false;
    }
  }
  markedTabId = tabId;
  if (tabId !== null) {
    applyMarker(tabId, true);
    // Only group the tab on explicit select_tab (not on every tool call)
    if (!skipGroup) {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
          const gid = await chrome.tabs.group({ tabIds: tabId });
          chrome.tabGroups.update(gid, { title: "\u{1F916} Claude", color: "orange" });
          markerGrouped = true;
        }
      } catch {}
    }
  }
}

// Deferred marker: silently marks the tab without grouping or stealing focus.
function deferMarker(tabId) {
  if (markedTabId === tabId) return; // already marked, skip entirely
  setTimeout(() => setMarker(tabId, true), 0); // skipGroup = true
}

// Re-apply marker + auto-inject recorder on page load.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "complete") {
    if (tabId === markedTabId) applyMarker(tabId, true);
    injectedTabs.delete(tabId); // page reloaded — needs re-inject
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
  if (tabId === markedTabId) { markedTabId = null; markerGrouped = false; }
  if (tabId === targetTabId) { targetTabId = null; chrome.storage.session.remove("targetTabId"); }
});

// Auto-observe: capture screenshot after interaction tools and attach to response
async function autoCapture(tabId) {
  if (!observeMode) return null;
  try {
    if (markedTabId === tabId) await applyMarker(tabId, false);
    const dataUrl = await withCDP(tabId, async () => {
      const { data } = await cdpSend(tabId, "Page.captureScreenshot", { format: "png", quality: 70 });
      return "data:image/png;base64," + data;
    });
    if (markedTabId === tabId) applyMarker(tabId, true);
    return dataUrl;
  } catch { return null; }
}

function attachScreenshot(result, dataUrl) {
  if (!dataUrl) return result;
  result.__screenshot = dataUrl;
  return result;
}

// ---------------------------------------------------------------------------
// Script execution helpers
// ---------------------------------------------------------------------------

function execInTab(tabId, func, args = [], world = "ISOLATED") {
  return chrome.scripting.executeScript({ target: { tabId }, world, func, args })
    .then(([{ result }]) => result);
}

async function ensureRecorder(tabId) {
  if (injectedTabs.has(tabId)) return false;
  const present = await execInTab(tabId, () => Boolean(window.__claudeBridge), [], "MAIN");
  if (present) { injectedTabs.add(tabId); return false; }
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["inject.js"], world: "MAIN" }).catch(() =>
    chrome.scripting.executeScript({ target: { tabId }, files: ["inject.js"], world: "MAIN" })
  );
  injectedTabs.add(tabId);
  return true;
}

// ---------------------------------------------------------------------------
// In-page functions (serialized into the tab)
// ---------------------------------------------------------------------------

function pageLocateAndAct(sel, ref, timeoutMs, action, value) {
  return new Promise((resolve) => {
    const started = Date.now();
    const attempt = () => {
      let el = null;
      let stale = false;
      const bridge = window.__claudeBridge;
      if (!bridge) {
        if (Date.now() - started >= timeoutMs) {
          resolve({ error: "Bridge not initialized — internal error, please reload the page" });
          return;
        }
        setTimeout(attempt, 150);
        return;
      }

      if (ref !== null && ref !== undefined) {
        if (!bridge.refs || !Array.isArray(bridge.refs)) {
          resolve({ error: `Bridge refs array not initialized — take a new snapshot first` });
          return;
        }
        el = bridge.refs[ref] || null;
        if (el && !el.isConnected) { el = null; stale = true; }
      } else {
        el = document.querySelector(sel);
      }
      if (!el) {
        if (Date.now() - started >= timeoutMs) {
          resolve({
            error: ref !== null && ref !== undefined
              ? stale
                ? `ref_${ref} is stale (element was removed from the DOM) — take a new snapshot`
                : `ref_${ref} not found — take a new snapshot first`
              : `No element matched selector "${sel}" within ${timeoutMs}ms`,
          });
          return;
        }
        setTimeout(attempt, 150);
        return;
      }

      // Actionability checks (like Playwright)
      try {
        const cs = window.getComputedStyle(el);
        if (cs.display === "none") {
          if (Date.now() - started >= timeoutMs) {
            resolve({ error: "Element is hidden (display:none) — trigger it to become visible first" });
            return;
          }
          setTimeout(attempt, 200);
          return;
        }
        if (cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) {
          if (Date.now() - started >= timeoutMs) {
            resolve({ error: "Element is invisible (visibility:hidden or opacity:0)" });
            return;
          }
          setTimeout(attempt, 200);
          return;
        }
        if (el.disabled && action === "click") {
          resolve({ error: "Element is disabled — cannot click" });
          return;
        }
      } catch {}

      try {
        el.scrollIntoView({ block: "center", behavior: "instant" });
      } catch (scrollErr) {
        resolve({ error: ref !== null && ref !== undefined
          ? `ref_${ref} is stale (element was garbage collected) — take a new snapshot`
          : `Element no longer accessible: ${scrollErr.message}` });
        return;
      }

      try {
        const rect = el.getBoundingClientRect();
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;

        if (action === "click") {
          // Full realistic event sequence matching Playwright's approach:
          // pointer events → mouse events → focus → release → click
          const base = { bubbles: true, cancelable: true, view: window,
            clientX: cx, clientY: cy, screenX: cx, screenY: cy, button: 0 };
          el.dispatchEvent(new PointerEvent("pointerover", { ...base, pointerId: 1, pointerType: "mouse" }));
          el.dispatchEvent(new MouseEvent("mouseover", base));
          el.dispatchEvent(new PointerEvent("pointerenter", { ...base, bubbles: false, pointerId: 1, pointerType: "mouse" }));
          el.dispatchEvent(new MouseEvent("mouseenter", { ...base, bubbles: false }));
          el.dispatchEvent(new PointerEvent("pointermove", { ...base, pointerId: 1, pointerType: "mouse" }));
          el.dispatchEvent(new MouseEvent("mousemove", base));
          el.dispatchEvent(new PointerEvent("pointerdown", { ...base, buttons: 1, pointerId: 1, pointerType: "mouse" }));
          el.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
          if (typeof el.focus === "function") el.focus();
          el.dispatchEvent(new PointerEvent("pointerup", { ...base, pointerId: 1, pointerType: "mouse" }));
          el.dispatchEvent(new MouseEvent("mouseup", base));
          el.dispatchEvent(new MouseEvent("click", base));
        } else if (el.isContentEditable) {
          el.focus();
          el.textContent = value;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          el.focus();
          const proto =
            el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
            : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) setter.call(el, value);
          else el.value = value;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: value }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        resolve({
          ok: true,
          waitedMs: Date.now() - started,
          rect: { x: Math.round(rect.x), y: Math.round(rect.y),
                  w: Math.round(rect.width), h: Math.round(rect.height),
                  cx: Math.round(cx), cy: Math.round(cy) },
        });
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg.includes("Illegal invocation") && ref !== null && ref !== undefined) {
          resolve({ error: `ref_${ref} is stale (element was garbage collected) — take a new snapshot` });
        } else {
          resolve({ error: msg });
        }
      }
    };
    attempt();
  });
}

function pageSnapshot(maxElements) {
  const bridge = window.__claudeBridge;
  if (!bridge) return null;
  // FIX: Clear refs safely — create a new array instead of mutating in place
  // to avoid race conditions when other tools are reading refs concurrently
  bridge.refs = [];
  const SELECTOR =
    'a[href], button, input, select, textarea, summary, ' +
    '[role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], ' +
    '[role="menuitem"], [role="option"], [role="switch"], [role="combobox"], ' +
    '[contenteditable="true"], [onclick]';
  const accessibleName = (el) => {
    return el.getAttribute("aria-label")
      || (el.labels?.[0]?.innerText?.trim().slice(0, 80))
      || el.placeholder
      || (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 80)
      || el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("name") || "";
  };
  const lines = [];
  const added = new Set();
  const addEl = (el) => {
    if (added.has(el) || lines.length >= maxElements) return;
    if (!el.offsetParent && el.tagName !== "BODY" && !el.closest('[role="dialog"],[role="listbox"],[role="menu"],dialog[open]')) return;
    added.add(el);
    const idx = bridge.refs.length;
    bridge.refs.push(el);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const kind = role || (tag === "input" ? `input[${el.type || "text"}]` : tag);
    const state = [];
    if (el.disabled) state.push("disabled");
    if (el.checked) state.push("checked");
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const v = String(el.value ?? "");
      if (v) state.push(`value="${v.slice(0, 40)}"`);
    }
    if (tag === "a") {
      const href = el.getAttribute("href");
      if (href && href !== "#") state.push(`href="${href.slice(0, 80)}"`);
    }
    lines.push(
      `ref_${idx} <${kind}> "${accessibleName(el)}"${state.length ? " (" + state.join(", ") + ")" : ""}`
    );
  };

  // Phase 1: Standard interactive element scan
  for (const el of document.querySelectorAll(SELECTOR)) addEl(el);

  // Phase 2: Portal/overlay containers (React portals, Radix, MUI, Headless UI, GitHub Primer)
  const portalSelectors = [
    '[role="dialog"]', '[role="listbox"]', '[role="menu"]', '[role="menubar"]',
    '[role="tooltip"]', '[role="alertdialog"]', '[data-portal]',
    '[data-radix-popper-content-wrapper]', '[data-floating-ui-portal]',
    '[data-headlessui-portal]', '.MuiPopover-root', '.MuiModal-root', '.MuiMenu-root',
    '[class*="Overlay--"]', '[class*="ActionList"]', 'dialog[open]',
    '[popover]:not([popover=""])', '[data-tippy-root]',
  ];
  for (const ps of portalSelectors) {
    try {
      for (const container of document.querySelectorAll(ps)) {
        for (const el of container.querySelectorAll(SELECTOR)) addEl(el);
      }
    } catch {}
  }

  // Phase 3: Walk open shadow roots
  const walkShadow = (root, depth) => {
    if (depth > 3 || lines.length >= maxElements) return;
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) {
        for (const child of el.shadowRoot.querySelectorAll(SELECTOR)) addEl(child);
        walkShadow(el.shadowRoot, depth + 1);
      }
    }
  };
  try { walkShadow(document, 0); } catch {}

  if (lines.length >= maxElements) lines.push(`… truncated at ${maxElements} elements`);
  // Cross-origin iframe detection.
  let crossOriginCount = 0;
  for (const f of document.querySelectorAll("iframe")) {
    try { f.contentDocument; } catch { crossOriginCount++; }
  }
  if (crossOriginCount) {
    lines.push(`\n⚠ ${crossOriginCount} cross-origin iframe(s) detected — content not accessible.`);
  }
  // CAPTCHA detection.
  const captchaSelectors = [
    "iframe[src*='recaptcha']", "iframe[src*='hcaptcha']", "iframe[src*='captcha']",
    "[class*='captcha']", "[id*='captcha']", ".g-recaptcha", ".h-captcha",
    "iframe[src*='challenges.cloudflare']", "[id='cf-turnstile']",
  ];
  if (captchaSelectors.some(s => document.querySelector(s))) {
    lines.push(`\n🛑 CAPTCHA DETECTED — ask the user to solve it manually, then retry.`);
  }
  return lines.join("\n");
}

function pageWaitFor(sel, text, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (sel) {
        const el = document.querySelector(sel);
        return Boolean(el) && (!text || (el.innerText || "").includes(text));
      }
      return text ? Boolean(document.body?.innerText?.includes(text)) : false;
    };
    if (check()) return resolve({ ok: true, waitedMs: 0 });
    // Use MutationObserver for instant detection instead of polling
    const observer = new MutationObserver(() => {
      if (check()) { observer.disconnect(); resolve({ ok: true, waitedMs: Date.now() - started }); }
    });
    observer.observe(document.body || document.documentElement, {
      childList: true, subtree: true, characterData: true, attributes: true,
    });
    setTimeout(() => {
      observer.disconnect();
      if (check()) resolve({ ok: true, waitedMs: Date.now() - started });
      else resolve({
        error: `Timed out after ${timeoutMs}ms waiting for ${sel ? `selector "${sel}"` : ""}${sel && text ? " containing " : ""}${text ? `text "${text}"` : ""}`,
      });
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------

function parseRef(ref) {
  if (ref === null || ref === undefined) return null;
  const n = Number(String(ref).replace(/^ref_/, ""));
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid ref: ${ref}`);
  return n;
}

// ---------------------------------------------------------------------------
// CDP-level input: real isTrusted mouse/keyboard events (like Playwright)
// ---------------------------------------------------------------------------

async function cdpClick(tabId, x, y) {
  return withCDP(tabId, async () => {
    await cdpSend(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x, y, button: "none", buttons: 0, pointerType: "mouse",
    });
    await cdpSend(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", buttons: 1,
      clickCount: 1, pointerType: "mouse",
    });
    await cdpSend(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", buttons: 0,
      clickCount: 1, pointerType: "mouse",
    });
  });
}

async function cdpType(tabId, text) {
  return withCDP(tabId, async () => {
    for (const char of text) {
      const code = char.charCodeAt(0);
      if (code > 127) {
        await cdpSend(tabId, "Input.insertText", { text: char });
      } else {
        await cdpSend(tabId, "Input.dispatchKeyEvent", {
          type: "keyDown", text: char, key: char,
          code: char === " " ? "Space" : "Key" + char.toUpperCase(),
          windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
        });
        await cdpSend(tabId, "Input.dispatchKeyEvent", {
          type: "keyUp", key: char,
          code: char === " " ? "Space" : "Key" + char.toUpperCase(),
          windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
        });
      }
    }
  });
}

async function cdpHover(tabId, x, y) {
  return withCDP(tabId, async () => {
    await cdpSend(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x, y, button: "none", buttons: 0, pointerType: "mouse",
    });
  });
}

// ---------------------------------------------------------------------------
// Element position helper: scrolls into view and returns center coordinates
// ---------------------------------------------------------------------------

async function getElementCenter(tabId, selector, ref) {
  return execInTab(tabId, (sel, refIdx) => {
    const bridge = window.__claudeBridge;
    let el = refIdx !== null ? bridge?.refs?.[refIdx] : (sel ? document.querySelector(sel) : null);
    if (!el || !el.isConnected) return null;
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return {
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
  }, [selector || null, ref], "MAIN");
}

// ---------------------------------------------------------------------------
// actOnElement: orchestrates cursor animation + CDP input + visual effects
// ---------------------------------------------------------------------------

async function actOnElement(tab, params, action) {
  const ref = parseRef(params.ref);
  if (ref === null && !params.selector) throw new Error("Provide either 'selector' or 'ref'");
  if (ref !== null) await ensureRecorder(tab.id);

  // Step 1: Get element position (scroll into view + get coordinates)
  const waitMs = Math.min(params.wait_ms ?? 5000, 15000);
  const started = Date.now();
  let pos = null;
  while (!pos && Date.now() - started < waitMs) {
    pos = await getElementCenter(tab.id, params.selector, ref);
    if (!pos) await new Promise(r => setTimeout(r, 150));
  }

  // Actionability check
  if (!pos) {
    // Fall back to the JS-based function for better error messages
    const result = await execInTab(tab.id, pageLocateAndAct,
      [params.selector || null, ref, 100, action, params.value ?? null], "MAIN");
    throw new Error(result?.error || `Element not found within ${waitMs}ms`);
  }

  // Step 2: Cursor animation (if cursor mode)
  if (cursorMode) {
    const actionLabel = action === "click" ? "Clicking..." : "Typing...";
    await execInTab(tab.id, pageCursorSystem, ["move", { x: pos.x, y: pos.y, label: actionLabel }], "MAIN");
    await new Promise(r => setTimeout(r, 400));
    if (action === "click") {
      await execInTab(tab.id, pageCursorSystem, ["ripple", { x: pos.x, y: pos.y }], "MAIN");
    }
  }

  // Step 3: Perform action via CDP (isTrusted: true)
  if (action === "click") {
    await cdpClick(tab.id, pos.x, pos.y);
    // Wait for DOM to stabilize after click (dropdowns, modals, SPA navigation)
    await execInTab(tab.id, () => {
      return new Promise(resolve => {
        let timer = null;
        const done = () => { obs.disconnect(); resolve(true); };
        const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, 80); });
        obs.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true });
        timer = setTimeout(done, 80);
        setTimeout(done, 500); // hard cap
      });
    }, [], "MAIN").catch(() => {});
  } else {
    // Fill: focus the element via CDP click, clear, then type
    await cdpClick(tab.id, pos.x, pos.y);
    await new Promise(r => setTimeout(r, 50));

    // Select all existing text and replace with new value
    await withCDP(tab.id, async () => {
      await cdpSend(tab.id, "Input.dispatchKeyEvent", {
        type: "rawKeyDown", key: "a", code: "KeyA",
        windowsVirtualKeyCode: 65, modifiers: 2, // Ctrl+A
      });
      await cdpSend(tab.id, "Input.dispatchKeyEvent", {
        type: "keyUp", key: "a", code: "KeyA",
        windowsVirtualKeyCode: 65, modifiers: 2,
      });
    });
    await new Promise(r => setTimeout(r, 30));

    // Type the new value character by character
    await cdpType(tab.id, params.value);
  }

  // Step 4: Visual effects (cursor mode)
  if (cursorMode) {
    if (action !== "click") {
      await execInTab(tab.id, (sel, refIdx) => {
        const bridge = window.__claudeBridge;
        const el = refIdx !== null ? bridge?.refs?.[refIdx] : (sel ? document.querySelector(sel) : null);
        if (el) {
          el.classList.add('__claude_typing_indicator__');
          setTimeout(() => el.classList.remove('__claude_typing_indicator__'), 800);
        }
      }, [params.selector || null, ref], "MAIN");
    }
    setTimeout(() => {
      execInTab(tab.id, pageCursorSystem, ["hide"], "MAIN").catch(() => {});
    }, 700);
  }

  const response = {
    [action === "click" ? "clicked" : "filled"]: params.selector || `ref_${ref}`,
    waitedMs: Date.now() - started,
    elementRect: pos.rect,
    isTrusted: true,
  };
  return attachScreenshot(response, await autoCapture(tab.id));
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

async function handle(msg) {
  const params = msg.params || {};

  if (msg.method === "list_tabs") {
    const tabs = await chrome.tabs.query({});
    return tabs.map((t) => ({
      tab_id: t.id,
      active: t.active,
      selected: t.id === targetTabId || undefined,
      title: t.title,
      url: t.url,
    }));
  }

  if (msg.method === "observe_mode") {
    observeMode = Boolean(params.enabled);
    return { observe_mode: observeMode, note: observeMode
      ? "Observe mode ON — click, fill, hover, scroll, navigate will auto-capture screenshots in their response. Claude sees the result of every action without separate screenshot calls."
      : "Observe mode OFF — interactions return data only, call screenshot separately."
    };
  }

  if (msg.method === "cursor_mode") {
    cursorMode = Boolean(params.enabled);
    const speed = params.speed || "normal";
    // If turning off, clean up any existing cursor overlays
    if (!cursorMode) {
      try {
        const allTabs = await chrome.tabs.query({});
        for (const t of allTabs) {
          execInTab(t.id, pageCursorSystem, ["destroy"], "MAIN").catch(() => {});
        }
      } catch {}
    }
    return { cursor_mode: cursorMode, speed, note: cursorMode
      ? "Cursor mode ON — a visual pointer will animate to each target before click/fill/hover actions. " +
        "Users can see exactly what Claude is doing. Actions take ~400ms longer per interaction for the animation."
      : "Cursor mode OFF — interactions happen instantly without visual cursor."
    };
  }

  if (msg.method === "select_tab" && params.clear) {
    targetTabId = null;
    chrome.storage.session.remove("targetTabId");
    setMarker(null); // fire-and-forget
    return { selected: null, note: "Target unpinned; tools default to the active tab again." };
  }

  if (msg.method === "new_tab") {
    const newTab = await chrome.tabs.create({ url: params.url || "about:blank" });
    // FIX: Don't auto-mark the new tab — user explicitly opened it for isolated research.
    // Subsequent tools should still target the original targetTabId, not this new tab.
    return { tab_id: newTab.id, url: newTab.pendingUrl || params.url };
  }

  const tab = await resolveTab(params);

  // Early bail for chrome:// and other protected pages
  const isProtectedPage = tab.url &&
    (tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://") ||
     tab.url.startsWith("devtools://") || tab.url.startsWith("view-source:") ||
     tab.url.startsWith("chrome-untrusted://") ||
     tab.url.includes("chromewebstore.google.com"));
  if (isProtectedPage && msg.method !== "select_tab" && msg.method !== "close_tab") {
    throw new Error(
      `Cannot access ${tab.url.split("/").slice(0, 3).join("/")} — Chrome blocks all extension ` +
      `access to this page type. No tools will work here (not eval, snapshot, screenshot, etc.). ` +
      `Only list_tabs can see this tab exists. Navigate to a regular web page to use bridge tools.`
    );
  }

  // For select_tab, apply marker synchronously (user needs to see it).
  // For everything else, defer it so it doesn't block the response.
  if (msg.method === "select_tab") {
    targetTabId = tab.id;
    chrome.storage.session.set({ targetTabId });
    await setMarker(tab.id);
    return { selected: { tab_id: tab.id, title: tab.title, url: tab.url } };
  }

  deferMarker(tab.id);

  switch (msg.method) {
    case "get_page_text": {
      const text = await execInTab(tab.id, () =>
        document.body ? document.body.innerText.slice(0, 50000) : ""
      );
      return { tab_id: tab.id, url: tab.url, title: tab.title, text };
    }

    case "get_html": {
      const html = await execInTab(
        tab.id,
        (sel) => {
          const el = sel ? document.querySelector(sel) : document.documentElement;
          return el ? el.outerHTML.slice(0, 100000) : null;
        },
        [params.selector || null]
      );
      if (html === null) throw new Error(`No element matches selector: ${params.selector}`);
      return { tab_id: tab.id, url: tab.url, html };
    }

    case "snapshot": {
      await ensureRecorder(tab.id);
      const max = Math.min(params.max_elements ?? 300, 1000);
      const snapshot = await execInTab(tab.id, pageSnapshot, [max], "MAIN");
      if (snapshot === null) throw new Error("Could not access this page (chrome:// and store pages are not scriptable)");
      return { tab_id: tab.id, url: tab.url, title: tab.title, elements: snapshot || "(no visible interactive elements found)" };
    }

    case "wait_for": {
      if (!params.selector && !params.text) throw new Error("Provide 'selector' and/or 'text'");
      const timeoutMs = Math.min(params.timeout_ms ?? 10000, 15000);
      const result = await execInTab(tab.id, pageWaitFor, [params.selector || null, params.text || null, timeoutMs], "MAIN");
      if (result?.error) throw new Error(result.error);
      return result;
    }

    case "click":
      return await actOnElement(tab, params, "click");

    case "fill": {
      if (params.value === undefined || params.value === null) throw new Error("'value' is required");
      return await actOnElement(tab, params, "fill");
    }

    case "eval": {
      // Try CDP Runtime.evaluate first — bypasses CSP on all sites
      try {
        const value = await withCDP(tab.id, async () => {
          const { result: r, exceptionDetails } = await cdpSend(
            tab.id, "Runtime.evaluate",
            { expression: params.code, returnByValue: true, awaitPromise: true, generatePreview: true }
          );
          if (exceptionDetails) {
            const errMsg = exceptionDetails.exception?.description || exceptionDetails.text || "Evaluation failed";
            return "Error: " + errMsg;
          }
          if (r.type === "undefined") return "undefined";
          if (r.value !== undefined) {
            return typeof r.value === "object" ? JSON.stringify(r.value, null, 2)?.slice(0, 20000) : String(r.value).slice(0, 20000);
          }
          return String(r.description || r.unserializableValue || r.type).slice(0, 20000);
        });
        return { value };
      } catch (cdpErr) {
        // CDP unavailable (protected page) — fall back to script injection
        const value = await execInTab(
          tab.id,
          (code) => {
            try {
              const result = window.eval(code);
              if (typeof result === "object" && result !== null) return JSON.stringify(result, null, 2)?.slice(0, 20000);
              return String(result).slice(0, 20000);
            } catch (e) {
              return "Error: " + (e?.stack || String(e));
            }
          },
          [params.code],
          "MAIN"
        );
        return { value };
      }
    }

    case "get_console": {
      await ensureRecorder(tab.id);
      const logs = await execInTab(
        tab.id,
        (clear) => {
          const b = window.__claudeBridge;
          const out = b.logs.slice(-200);
          if (clear) b.logs.length = 0;
          return out;
        },
        [Boolean(params.clear)],
        "MAIN"
      );
      return { tab_id: tab.id, url: tab.url, logs };
    }

    case "get_network": {
      await ensureRecorder(tab.id);
      let requests = await execInTab(
        tab.id,
        (clear) => {
          const b = window.__claudeBridge;
          const out = b.requests.slice(-500);
          if (clear) b.requests.length = 0;
          return out;
        },
        [Boolean(params.clear)],
        "MAIN"
      );
      if (params.url_contains) requests = requests.filter((r) => r.url?.includes(params.url_contains));
      if (params.only_failures) requests = requests.filter((r) => r.error || (r.status && r.status >= 400));
      return { tab_id: tab.id, url: tab.url, requests: requests.slice(-200) };
    }

    case "screenshot": {
      // Use CDP Page.captureScreenshot — works on background tabs without stealing focus
      try {
        if (markedTabId === tab.id) await applyMarker(tab.id, false);
        const dataUrl = await withCDP(tab.id, async () => {
          const { data } = await cdpSend(tab.id, "Page.captureScreenshot", { format: "png" });
          return "data:image/png;base64," + data;
        });
        if (markedTabId === tab.id) applyMarker(tab.id, true);
        return { tab_id: tab.id, url: tab.url, dataUrl };
      } catch {
        // Fallback to captureVisibleTab if CDP fails (e.g. protected pages)
        if (!tab.active) {
          await chrome.tabs.update(tab.id, { active: true });
          await new Promise((r) => setTimeout(r, 200));
        }
        if (markedTabId === tab.id) await applyMarker(tab.id, false);
        try {
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
          return { tab_id: tab.id, url: tab.url, dataUrl };
        } finally {
          if (markedTabId === tab.id) applyMarker(tab.id, true);
        }
      }
    }

    case "navigate": {
      injectedTabs.delete(tab.id);
      await chrome.tabs.update(tab.id, { url: params.url });
      if (observeMode) {
        await new Promise(r => setTimeout(r, 2000));
        return attachScreenshot({ tab_id: tab.id, navigating_to: params.url }, await autoCapture(tab.id));
      }
      return { tab_id: tab.id, navigating_to: params.url };
    }

    case "hover": {
      const ref = parseRef(params.ref);
      if (ref === null && !params.selector) throw new Error("Provide 'ref' or 'selector'");
      if (ref !== null) await ensureRecorder(tab.id);

      const pos = await getElementCenter(tab.id, params.selector, ref);
      if (!pos) throw new Error("Element not found");

      // Cursor mode: animate cursor to hover target
      if (cursorMode) {
        await execInTab(tab.id, pageCursorSystem, ["move", { x: pos.x, y: pos.y, label: "Hovering..." }], "MAIN");
        await new Promise(r => setTimeout(r, 400));
      }

      // CDP hover: real isTrusted mouseMoved event
      await cdpHover(tab.id, pos.x, pos.y);

      if (cursorMode) {
        setTimeout(() => {
          execInTab(tab.id, pageCursorSystem, ["hide"], "MAIN").catch(() => {});
        }, 1500);
      }

      return attachScreenshot({ hovered: params.selector || `ref_${ref}`, elementRect: pos.rect, isTrusted: true }, await autoCapture(tab.id));
    }

    case "select_option": {
      const ref = parseRef(params.ref);
      if (ref === null && !params.selector) throw new Error("Provide 'ref' or 'selector'");
      if (!params.values?.length) throw new Error("'values' array is required");
      if (ref !== null) await ensureRecorder(tab.id);
      const result = await execInTab(
        tab.id,
        (sel, refIdx, values) => {
          // FIX: Safely access bridge and refs
          const bridge = window.__claudeBridge;
          if (!bridge) return { error: "Bridge not initialized" };
          let el = refIdx !== null ? (bridge.refs?.[refIdx] || null) : document.querySelector(sel);
          if (!el || el.tagName !== "SELECT") return { error: "No <select> found" };
          for (const opt of el.options) {
            opt.selected = values.includes(opt.value) || values.includes(opt.textContent.trim());
          }
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true, selected: [...el.selectedOptions].map(o => o.value) };
        },
        [params.selector || null, ref, params.values],
        "MAIN"
      );
      if (result?.error) throw new Error(result.error);
      return result;
    }

    case "press_key": {
      if (!params.key) throw new Error("'key' is required");
      const KEY_CODES = {
        Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32,
        ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
        Home: 36, End: 35, PageUp: 33, PageDown: 34,
        F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
        F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
      };
      try {
        await withCDP(tab.id, async () => {
          const key = params.key;
          const vk = KEY_CODES[key] || key.toUpperCase().charCodeAt(0);
          const mods = (params.modifiers || []);
          const modBits = mods.reduce((m, mod) =>
            m | (mod === "Control" ? 2 : mod === "Shift" ? 8 : mod === "Alt" ? 1 : mod === "Meta" ? 4 : 0), 0);
          await cdpSend(tab.id, "Input.dispatchKeyEvent", {
            type: "rawKeyDown", key, code: key, windowsVirtualKeyCode: vk, modifiers: modBits,
          });
          await cdpSend(tab.id, "Input.dispatchKeyEvent", {
            type: "keyUp", key, code: key, windowsVirtualKeyCode: vk, modifiers: modBits,
          });
        });
        return { ok: true, key: params.key, isTrusted: true };
      } catch {
        // Fallback to DOM events if CDP unavailable
        return await execInTab(tab.id, (key, modifiers) => {
          const target = document.activeElement || document.body;
          const opts = {
            key, code: key, bubbles: true, cancelable: true,
            ctrlKey: modifiers.includes("Control"), shiftKey: modifiers.includes("Shift"),
            altKey: modifiers.includes("Alt"), metaKey: modifiers.includes("Meta"),
          };
          target.dispatchEvent(new KeyboardEvent("keydown", opts));
          target.dispatchEvent(new KeyboardEvent("keyup", opts));
          return { ok: true, key, target: target.tagName, isTrusted: false };
        }, [params.key, params.modifiers || []], "MAIN");
      }
    }

    case "scroll": {
      return await execInTab(
        tab.id,
        (sel, refIdx, direction, amount) => {
          let el = null;
          // FIX: Safely access bridge and refs
          const bridge = window.__claudeBridge;
          if (refIdx !== null) {
            if (!bridge || !bridge.refs) return { error: "Bridge not initialized" };
            el = bridge.refs[refIdx] || null;
          } else if (sel) {
            el = document.querySelector(sel);
          }
          const target = el || document.documentElement;
          const dx = direction === "left" ? -amount : direction === "right" ? amount : 0;
          const dy = direction === "up" ? -amount : direction === "down" ? amount : 0;
          target.scrollBy({ left: dx, top: dy, behavior: "smooth" });
          return { ok: true, scrolled: { direction, amount } };
        },
        [params.selector || null, parseRef(params.ref), params.direction || "down", params.amount ?? 400],
        "MAIN"
      );
    }

    case "go_back": {
      await chrome.tabs.goBack(tab.id);
      return { tab_id: tab.id, action: "back" };
    }

    case "go_forward": {
      await chrome.tabs.goForward(tab.id);
      return { tab_id: tab.id, action: "forward" };
    }

    case "reload": {
      if (!tab || typeof tab.id !== 'number') {
        throw new Error("reload: No valid tab resolved — cannot reload without a target tab ID");
      }
      console.log(`[bridge] reloading tab ${tab.id} (${tab.url}) — bypass_cache: ${Boolean(params.bypass_cache)}`);
      injectedTabs.delete(tab.id);
      await chrome.tabs.reload(tab.id, { bypassCache: Boolean(params.bypass_cache) });
      return { tab_id: tab.id, action: "reload", url: tab.url };
    }

    case "close_tab": {
      await chrome.tabs.remove(tab.id);
      return { closed: tab.id };
    }

    case "detach_debugger": {
      releaseCDP(tab.id);
      return { detached: tab.id, note: "Debugger detached — yellow bar removed." };
    }

    case "get_cookies": {
      const cookies = await chrome.cookies.getAll({ url: tab.url });
      return {
        tab_id: tab.id,
        url: tab.url,
        cookies: cookies.map((c) => ({
          name: c.name,
          value: /^(session|token|auth|jwt|sid|csrf)/i.test(c.name) ? "[redacted]" : c.value.slice(0, 200),
          domain: c.domain,
          httpOnly: c.httpOnly,
          secure: c.secure,
        })),
      };
    }

    case "get_storage": {
      return {
        tab_id: tab.id,
        url: tab.url,
        storage: await execInTab(
          tab.id,
          (storageType, keyFilter) => {
            const store = storageType === "session" ? sessionStorage : localStorage;
            const out = {};
            for (let i = 0; i < store.length; i++) {
              const k = store.key(i);
              if (keyFilter && !k.includes(keyFilter)) continue;
              out[k] = store.getItem(k)?.slice(0, 2000);
            }
            return out;
          },
          [params.storage_type || "local", params.key_filter || null],
          "MAIN"
        ),
      };
    }

    case "upload_file": {
      const ref = parseRef(params.ref);
      if (ref === null && !params.selector) throw new Error("Provide 'ref' or 'selector' for the file input");
      if (!params.file_path) throw new Error("'file_path' is required");
      return await withCDP(tab.id, async () => {
        await cdpSend(tab.id, "DOM.enable");
        const { root } = await cdpSend(tab.id, "DOM.getDocument");
        let nodeId;
        if (ref !== null) {
          const uniqSel = await execInTab(
            tab.id,
            (refIdx) => {
              const el = window.__claudeBridge && window.__claudeBridge.refs?.[refIdx];
              if (!el) return null;
              const tmpId = "__claude_upload_" + Date.now();
              el.setAttribute("data-claude-upload", tmpId);
              return `[data-claude-upload="${tmpId}"]`;
            },
            [ref],
            "MAIN"
          );
          if (!uniqSel) throw new Error(`ref_${ref} not found`);
          ({ nodeId } = await cdpSend(
            tab.id, "DOM.querySelector", { nodeId: root.nodeId, selector: uniqSel }
          ));
        } else {
          ({ nodeId } = await cdpSend(
            tab.id, "DOM.querySelector", { nodeId: root.nodeId, selector: params.selector }
          ));
        }
        if (!nodeId) throw new Error("File input element not found in DOM");
        await cdpSend(
          tab.id, "DOM.setFileInputFiles", { files: [params.file_path], nodeId }
        );
        return { uploaded: params.file_path, to: params.selector || `ref_${ref}` };
      });
    }

    case "get_page_info": {
      await ensureRecorder(tab.id);
      return {
        tab_id: tab.id,
        ...(await execInTab(
          tab.id,
          () => {
            const b = window.__claudeBridge;
            const captchaSelectors = [
              "iframe[src*='recaptcha']", "iframe[src*='hcaptcha']", "iframe[src*='captcha']",
              "[class*='captcha']", "[id*='captcha']", ".g-recaptcha", ".h-captcha",
              "iframe[src*='challenges.cloudflare']", "[id='cf-turnstile']",
            ];
            return {
              url: location.href,
              title: document.title,
              errors: b.logs.filter(l => ["error", "uncaught", "unhandledrejection"].includes(l.level)).slice(-10),
              failedRequests: b.requests.filter(r => r.error || (r.status && r.status >= 400)).slice(-10),
              hasCaptcha: captchaSelectors.some(s => document.querySelector(s)),
            };
          },
          [],
          "MAIN"
        )),
      };
    }

    case "diagnose": {
      await ensureRecorder(tab.id);
      const data = await execInTab(
        tab.id,
        (maxEls) => {
          const b = window.__claudeBridge;
          // --- snapshot ---
          b.refs = [];
          const SEL =
            'a[href], button, input, select, textarea, summary, ' +
            '[role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], ' +
            '[role="menuitem"], [role="option"], [role="switch"], [role="combobox"], ' +
            '[contenteditable="true"], [onclick]';
          const name = (el) =>
            el.getAttribute("aria-label")
            || el.labels?.[0]?.innerText?.trim().slice(0, 80)
            || el.placeholder
            || (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 80)
            || el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("name") || "";
          const snapLines = [];
          const allEls = document.querySelectorAll(SEL);
          for (let i = 0; i < allEls.length && snapLines.length < maxEls; i++) {
            const el = allEls[i];
            if (!el.offsetParent && el.tagName !== "BODY") continue;
            const idx = b.refs.length;
            b.refs.push(el);
            const tag = el.tagName.toLowerCase();
            const role = el.getAttribute("role");
            const kind = role || (tag === "input" ? `input[${el.type || "text"}]` : tag);
            const st = [];
            if (el.disabled) st.push("disabled");
            if (el.checked) st.push("checked");
            if ((tag === "input" || tag === "textarea" || tag === "select") && el.value) st.push(`value="${String(el.value).slice(0, 40)}"`);
            if (tag === "a" && el.getAttribute("href") && el.getAttribute("href") !== "#") st.push(`href="${el.getAttribute("href").slice(0, 80)}"`);
            snapLines.push(`ref_${idx} <${kind}> "${name(el)}"${st.length ? " (" + st.join(", ") + ")" : ""}`);
          }
          // --- console errors ---
          const errors = b.logs
            .filter(l => ["error", "uncaught", "unhandledrejection"].includes(l.level))
            .slice(-15)
            .map(l => ({ level: l.level, args: l.args.map(a => String(a).slice(0, 300)) }));
          // --- failed network ---
          const failedReqs = b.requests
            .filter(r => r.error || (r.status && r.status >= 400))
            .slice(-15)
            .map(r => ({ method: r.method, url: r.url, status: r.status, error: r.error, responseBody: r.responseBody?.slice(0, 500) }));
          // --- recent API responses (last 20 JSON) ---
          const apiCalls = b.requests
            .filter(r => r.responseBody && r.status && r.status < 400)
            .slice(-20)
            .map(r => ({ method: r.method, url: r.url, status: r.status, durationMs: r.durationMs, bodyPreview: r.responseBody?.slice(0, 300) }));
          // --- captcha ---
          const captchaSelectors = [
            "iframe[src*='recaptcha']", "iframe[src*='hcaptcha']", "iframe[src*='captcha']",
            "[class*='captcha']", "[id*='captcha']", ".g-recaptcha", ".h-captcha",
            "iframe[src*='challenges.cloudflare']", "[id='cf-turnstile']",
          ];
          // --- CSP detection ---
          let cspBlocksEval = false;
          try { new Function("return 1")(); } catch(e) {
            if (String(e).includes("Content Security Policy") || String(e).includes("Trusted Type"))
              cspBlocksEval = true;
          }
          // --- cross-origin iframes ---
          const iframes = document.querySelectorAll("iframe");
          const crossOriginIframes = [];
          for (const f of iframes) {
            try { f.contentDocument; } catch(e) {
              crossOriginIframes.push(f.src?.slice(0, 150) || "(no src)");
            }
          }
          return {
            url: location.href,
            title: document.title,
            snapshot: snapLines.join("\n"),
            consoleErrors: errors,
            failedRequests: failedReqs,
            recentAPICalls: apiCalls,
            hasCaptcha: captchaSelectors.some(s => document.querySelector(s)),
            localStorage_keys: Object.keys(localStorage).slice(0, 30),
            cspBlocksEval: cspBlocksEval || undefined,
            crossOriginIframes: crossOriginIframes.length ? crossOriginIframes : undefined,
          };
        },
        [params.max_elements ?? 200],
        "MAIN"
      );
      return { tab_id: tab.id, ...data };
    }

    // =====================================================================
    // Advanced DevTools-powered tools (use chrome.debugger CDP protocol)
    // =====================================================================

    case "get_styles": {
      const ref = parseRef(params.ref);
      if (ref === null && !params.selector) throw new Error("Provide 'ref' or 'selector'");
      const styles = await execInTab(
        tab.id,
        (sel, refIdx, props) => {
          const el = refIdx !== null ? window.__claudeBridge && window.__claudeBridge.refs?.[refIdx] : document.querySelector(sel);
          if (!el) return { error: "Element not found" };
          const cs = window.getComputedStyle(el);
          const defaultProps = [
            "display", "position", "width", "height", "margin", "padding",
            "font-family", "font-size", "font-weight", "line-height", "letter-spacing",
            "color", "background-color", "background-image",
            "border", "border-radius", "box-shadow",
            "opacity", "z-index", "overflow", "flex-direction", "justify-content",
            "align-items", "gap", "grid-template-columns",
          ];
          const keys = props && props.length ? props : defaultProps;
          const result = {};
          for (const k of keys) result[k] = cs.getPropertyValue(k);
          const rect = el.getBoundingClientRect();
          result.__box = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
          result.__tag = el.tagName.toLowerCase();
          result.__classes = el.className?.toString().slice(0, 200);
          return result;
        },
        [params.selector || null, ref, params.properties || null],
        "MAIN"
      );
      if (styles?.error) throw new Error(styles.error);
      return { tab_id: tab.id, styles };
    }

    case "get_accessibility_tree": {
      return await withCDP(tab.id, async () => {
        await cdpSend(tab.id, "Accessibility.enable");
        const { nodes } = await cdpSend(
          tab.id, "Accessibility.getFullAXTree", { max_depth: params.max_depth ?? 5 }
        );
        const filtered = nodes
          .filter(n => n.role?.value && n.role.value !== "none" && n.role.value !== "GenericContainer")
          .slice(0, params.max_nodes ?? 300)
          .map(n => ({
            role: n.role?.value,
            name: n.name?.value?.slice(0, 100),
            description: n.description?.value?.slice(0, 100),
            properties: n.properties?.filter(p => ["disabled", "checked", "expanded", "selected", "required"].includes(p.name))
              .map(p => `${p.name}=${p.value?.value}`),
          }))
          .filter(n => n.name || n.role !== "StaticText");
        return { tab_id: tab.id, url: tab.url, nodes: filtered };
      });
    }

    case "performance_trace": {
      return await withCDP(tab.id, async () => {
        await cdpSend(tab.id, "Performance.enable");
        // Collect metrics
        const { metrics } = await cdpSend(tab.id, "Performance.getMetrics");
        const metricsObj = {};
        for (const m of metrics) metricsObj[m.name] = Math.round(m.value * 1000) / 1000;
        // Also get navigation timing from the page
        const timing = await execInTab(
          tab.id,
          () => {
            const nav = performance.getEntriesByType("navigation")[0];
            const paint = performance.getEntriesByType("paint");
            const lcp = performance.getEntriesByType("largest-contentful-paint");
            const cls = performance.getEntriesByType("layout-shift");
            const longtasks = performance.getEntriesByType("longtask");
            return {
              domContentLoaded: Math.round(nav?.domContentLoadedEventEnd || 0),
              loadComplete: Math.round(nav?.loadEventEnd || 0),
              firstPaint: Math.round(paint.find(p => p.name === "first-paint")?.startTime || 0),
              firstContentfulPaint: Math.round(paint.find(p => p.name === "first-contentful-paint")?.startTime || 0),
              largestContentfulPaint: Math.round(lcp[lcp.length - 1]?.startTime || 0),
              cumulativeLayoutShift: Math.round(cls.reduce((s, e) => s + (e.hadRecentInput ? 0 : e.value), 0) * 1000) / 1000,
              longTaskCount: longtasks.length,
              longTaskTotalMs: Math.round(longtasks.reduce((s, t) => s + t.duration, 0)),
              resourceCount: performance.getEntriesByType("resource").length,
              transferSizeKB: Math.round(performance.getEntriesByType("resource").reduce((s, r) => s + (r.transferSize || 0), 0) / 1024),
            };
          },
          [],
          "MAIN"
        );
        await cdpSend(tab.id, "Performance.disable").catch(() => {});
        return { tab_id: tab.id, url: tab.url, webVitals: timing, cdpMetrics: metricsObj };
      });
    }

    case "heap_snapshot_summary": {
      return await withCDP(tab.id, async () => {
        await cdpSend(tab.id, "HeapProfiler.enable");
        // Collect heap stats without a full snapshot (faster)
        const { result } = await cdpSend(tab.id, "Runtime.evaluate",
          { expression: "JSON.stringify({usedJSHeapSize: performance.memory?.usedJSHeapSize, totalJSHeapSize: performance.memory?.totalJSHeapSize, jsHeapSizeLimit: performance.memory?.jsHeapSizeLimit})", returnByValue: true }
        );
        const memory = JSON.parse(result.value || "{}");
        // Get object counts by type
        const { result: objCount } = await cdpSend(tab.id, "Runtime.evaluate",
          { expression: "JSON.stringify({domNodes: document.getElementsByTagName('*').length, eventListeners: 'see DevTools for count', detachedNodes: 'requires full heap snapshot'})", returnByValue: true }
        );
        const domInfo = JSON.parse(objCount.value || "{}");
        return {
          tab_id: tab.id,
          url: tab.url,
          memory: {
            usedMB: Math.round((memory.usedJSHeapSize || 0) / 1048576 * 10) / 10,
            totalMB: Math.round((memory.totalJSHeapSize || 0) / 1048576 * 10) / 10,
            limitMB: Math.round((memory.jsHeapSizeLimit || 0) / 1048576 * 10) / 10,
          },
          dom: domInfo,
        };
        await cdpSend(tab.id, "HeapProfiler.disable").catch(() => {});
      });
    }

    case "emulate_device": {
      return await withCDP(tab.id, async () => {
        const presets = {
          "mobile": { width: 375, height: 812, scale: 3, mobile: true, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
          "tablet": { width: 768, height: 1024, scale: 2, mobile: true, ua: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
          "desktop": { width: 1440, height: 900, scale: 1, mobile: false, ua: "" },
        };
        const device = params.device?.toLowerCase();
        const preset = presets[device];
        if (params.clear || device === "reset") {
          await cdpSend(tab.id, "Emulation.clearDeviceMetricsOverride");
          await cdpSend(tab.id, "Emulation.setUserAgentOverride", { userAgent: "" });
          return { tab_id: tab.id, emulation: "cleared" };
        }
        const w = params.width || preset?.width || 1440;
        const h = params.height || preset?.height || 900;
        const scale = params.device_scale || preset?.scale || 1;
        const mobile = params.mobile ?? preset?.mobile ?? false;
        await cdpSend(tab.id, "Emulation.setDeviceMetricsOverride", {
          width: w, height: h, deviceScaleFactor: scale, mobile,
        });
        if (preset?.ua || params.user_agent) {
          await cdpSend(tab.id, "Emulation.setUserAgentOverride", {
            userAgent: params.user_agent || preset.ua,
          });
        }
        return { tab_id: tab.id, emulation: { width: w, height: h, scale, mobile, device: device || "custom" } };
      });
    }

    case "network_throttle": {
      return await withCDP(tab.id, async () => {
        await cdpSend(tab.id, "Network.enable");
        const presets = {
          "offline": { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
          "slow-3g": { offline: false, latency: 2000, downloadThroughput: 50000, uploadThroughput: 50000 },
          "fast-3g": { offline: false, latency: 562.5, downloadThroughput: 180000, uploadThroughput: 84375 },
          "4g": { offline: false, latency: 20, downloadThroughput: 4000000, uploadThroughput: 3000000 },
          "none": { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
        };
        const preset = presets[params.preset?.toLowerCase()] || presets.none;
        await cdpSend(tab.id, "Network.emulateNetworkConditions", preset);
        return { tab_id: tab.id, throttle: params.preset || "none" };
      });
    }

    case "full_page_screenshot": {
      return await withCDP(tab.id, async () => {
        if (markedTabId === tab.id) await applyMarker(tab.id, false);
        const { data } = await cdpSend(tab.id, "Page.captureScreenshot", { format: "png", captureBeyondViewport: true, fromSurface: true }
        );
        if (markedTabId === tab.id) applyMarker(tab.id, true);
        return { tab_id: tab.id, url: tab.url, dataUrl: "data:image/png;base64," + data };
      });
    }

    case "export_pdf": {
      return await withCDP(tab.id, async () => {
        const { data } = await cdpSend(tab.id, "Page.printToPDF", {
            printBackground: true,
            preferCSSPageSize: true,
            format: params.format || "A4",
          }
        );
        return { tab_id: tab.id, url: tab.url, pdfBase64: data.slice(0, 50000), totalLength: data.length };
      });
    }

    case "watch_dom_changes": {
      const duration = Math.min(params.duration_ms ?? 5000, 15000);
      const changes = await execInTab(
        tab.id,
        (sel, durationMs) => {
          return new Promise(resolve => {
            const target = sel ? document.querySelector(sel) : document.body;
            if (!target) { resolve({ error: "Target not found" }); return; }
            const mutations = [];
            const observer = new MutationObserver(list => {
              for (const m of list) {
                mutations.push({
                  type: m.type,
                  target: m.target.tagName?.toLowerCase() + (m.target.className ? "." + String(m.target.className).split(" ")[0] : ""),
                  added: m.addedNodes.length,
                  removed: m.removedNodes.length,
                  attribute: m.attributeName || undefined,
                  oldValue: m.oldValue?.slice(0, 100) || undefined,
                });
              }
            });
            observer.observe(target, { childList: true, attributes: true, subtree: true, characterData: true, attributeOldValue: true });
            setTimeout(() => {
              observer.disconnect();
              resolve(mutations.slice(-50));
            }, durationMs);
          });
        },
        [params.selector || null, duration],
        "MAIN"
      );
      if (changes?.error) throw new Error(changes.error);
      return { tab_id: tab.id, duration_ms: duration, changes };
    }

    case "check_contrast": {
      const result = await execInTab(
        tab.id,
        (sel, refIdx) => {
          const el = refIdx !== null ? window.__claudeBridge && window.__claudeBridge.refs?.[refIdx] : (sel ? document.querySelector(sel) : null);
          if (!el) return { error: "Element not found" };
          const cs = window.getComputedStyle(el);
          const fg = cs.color;
          let bg = cs.backgroundColor;
          const fontSize = parseFloat(cs.fontSize);
          const fontWeight = parseInt(cs.fontWeight) || 400;
          const isLarge = fontSize >= 18 || (fontSize >= 14 && fontWeight >= 700);
          const parse = (c) => {
            const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
            return m ? { rgb: [+m[1], +m[2], +m[3]], a: m[4] !== undefined ? +m[4] : 1 } : null;
          };
          // Walk up parent chain to find actual visible background
          let effectiveBg = bg;
          let bgWalked = false;
          const parsed = parse(bg);
          if (parsed && parsed.a < 0.1) {
            let parent = el.parentElement;
            while (parent) {
              const pBg = window.getComputedStyle(parent).backgroundColor;
              const pParsed = parse(pBg);
              if (pParsed && pParsed.a >= 0.1) {
                effectiveBg = pBg;
                bgWalked = true;
                break;
              }
              parent = parent.parentElement;
            }
            if (!bgWalked) { effectiveBg = "rgb(255, 255, 255)"; bgWalked = true; }
          }
          const luminance = ([r, g, b]) => {
            const [rs, gs, bs] = [r, g, b].map(c => {
              c = c / 255;
              return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
            });
            return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
          };
          const fgRgb = parse(fg)?.rgb;
          const bgRgb = parse(effectiveBg)?.rgb;
          if (!fgRgb || !bgRgb) return { fg, bg: effectiveBg, ratio: "unknown", note: "Could not parse colors" };
          const l1 = luminance(fgRgb);
          const l2 = luminance(bgRgb);
          const ratio = Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
          const aaPass = isLarge ? ratio >= 3 : ratio >= 4.5;
          const aaaPass = isLarge ? ratio >= 4.5 : ratio >= 7;
          const res = { fg, bg: effectiveBg, ratio, isLargeText: isLarge, fontSize, fontWeight, wcag_AA: aaPass ? "PASS" : "FAIL", wcag_AAA: aaaPass ? "PASS" : "FAIL" };
          if (bgWalked) { res.bg_source = "inherited from parent (element has transparent background)"; res.bg_original = bg; }
          return res;
        },
        [params.selector || null, parseRef(params.ref)],
        "MAIN"
      );
      if (result?.error) throw new Error(result.error);
      return { tab_id: tab.id, ...result };
    }

    case "handle_dialog": {
      return await withCDP(tab.id, async () => {
        await cdpSend(tab.id, "Page.enable");
        // Set up handler for the next dialog
        const accept = params.accept !== false;
        const promptText = params.prompt_text || "";
        chrome.debugger.onEvent.addListener(function handler(source, method, eventParams) {
          if (method === "Page.javascriptDialogOpening") {
            cdpSend(tab.id, "Page.handleJavaScriptDialog", { accept, promptText });
            chrome.debugger.onEvent.removeListener(handler);
          }
        });
        return { tab_id: tab.id, action: accept ? "will accept" : "will dismiss", note: "Waiting for the next dialog" };
      });
    }

    case "get_clipboard": {
      const text = await execInTab(
        tab.id,
        async () => {
          try { return await navigator.clipboard.readText(); }
          catch { return "Clipboard access denied — page must be focused and have permission"; }
        },
        [],
        "MAIN"
      );
      return { tab_id: tab.id, clipboard: text };
    }

    // =====================================================================
    // TIER 1 — Unique differentiators
    // =====================================================================

    case "visual_diff": {
      // Compare two screenshots and highlight pixel differences.
      await execInTab(tab.id, () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 100))), [], "MAIN");
      if (markedTabId === tab.id) await applyMarker(tab.id, false);
      let afterUrl;
      try {
        afterUrl = await withCDP(tab.id, async () => {
          const { data } = await cdpSend(tab.id, "Page.captureScreenshot", { format: "png" });
          return "data:image/png;base64," + data;
        });
      } catch {
        if (!tab.active) { await chrome.tabs.update(tab.id, { active: true }); await new Promise(r => setTimeout(r, 200)); }
        afterUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      }
      if (markedTabId === tab.id) applyMarker(tab.id, true);
      const diff = await execInTab(
        tab.id,
        (beforeSrc, afterSrc) => {
          return new Promise(resolve => {
            if (!beforeSrc) { resolve({ error: "No 'before' screenshot provided. Call screenshot first, then make changes, then call visual_diff with before_dataUrl." }); return; }
            const imgA = new Image(); const imgB = new Image();
            let loaded = 0;
            const onLoad = () => {
              if (++loaded < 2) return;
              const w = Math.min(imgA.width, imgB.width);
              const h = Math.min(imgA.height, imgB.height);
              const canvas = document.createElement("canvas");
              canvas.width = w; canvas.height = h;
              const ctx = canvas.getContext("2d");
              ctx.drawImage(imgA, 0, 0);
              const dataA = ctx.getImageData(0, 0, w, h);
              ctx.drawImage(imgB, 0, 0);
              const dataB = ctx.getImageData(0, 0, w, h);
              let diffCount = 0; const regions = [];
              for (let i = 0; i < dataA.data.length; i += 4) {
                const dr = Math.abs(dataA.data[i] - dataB.data[i]);
                const dg = Math.abs(dataA.data[i+1] - dataB.data[i+1]);
                const db = Math.abs(dataA.data[i+2] - dataB.data[i+2]);
                if (dr + dg + db > 30) {
                  dataB.data[i] = 255; dataB.data[i+1] = 0; dataB.data[i+2] = 0; dataB.data[i+3] = 200;
                  diffCount++;
                }
              }
              ctx.putImageData(dataB, 0, 0);
              const totalPixels = w * h;
              resolve({ diffPercent: Math.round(diffCount / totalPixels * 10000) / 100, diffPixels: diffCount, totalPixels, diffImage: canvas.toDataURL("image/png") });
            };
            imgA.onload = onLoad; imgB.onload = onLoad;
            imgA.src = beforeSrc; imgB.src = afterSrc;
          });
        },
        [params.before_dataUrl || null, afterUrl],
        "MAIN"
      );
      if (diff?.error) throw new Error(diff.error);
      return { tab_id: tab.id, ...diff };
    }

    case "inject_css": {
      const result = await execInTab(
        tab.id,
        (css, id) => {
          const existing = document.getElementById(id);
          if (existing) existing.remove();
          if (!css) return { removed: id };
          const style = document.createElement("style");
          style.id = id;
          style.textContent = css;
          document.head.appendChild(style);
          return { injected: css.length + " chars", id };
        },
        [params.css || null, params.id || "__claude_inject_css__"],
        "MAIN"
      );
      return { tab_id: tab.id, ...result };
    }

    case "record_actions": {
      if (params.stop) {
        const actions = await execInTab(
          tab.id,
          () => {
            const rec = window.__claudeBridgeRecorder;
            if (!rec) return [];
            rec.observer?.disconnect();
            document.removeEventListener("click", rec.clickHandler, true);
            document.removeEventListener("input", rec.inputHandler, true);
            const result = rec.actions;
            delete window.__claudeBridgeRecorder;
            return result;
          },
          [],
          "MAIN"
        );
        return { tab_id: tab.id, actions };
      }
      await execInTab(
        tab.id,
        () => {
          if (window.__claudeBridgeRecorder) return;
          const rec = { actions: [] };
          const selector = (el) => {
            if (el.id) return "#" + el.id;
            if (el.getAttribute("data-testid")) return `[data-testid="${el.getAttribute("data-testid")}"]`;
            const tag = el.tagName.toLowerCase();
            const text = el.textContent?.trim().slice(0, 30);
            if (text && el.children.length === 0) return `${tag}:has-text("${text}")`;
            return tag + (el.className ? "." + String(el.className).split(" ")[0] : "");
          };
          rec.clickHandler = (e) => {
            rec.actions.push({ type: "click", selector: selector(e.target), text: e.target.textContent?.trim().slice(0, 50), time: Date.now() });
          };
          rec.inputHandler = (e) => {
            if (e.target.value !== undefined) {
              rec.actions.push({ type: "fill", selector: selector(e.target), value: e.target.value?.slice(0, 100), time: Date.now() });
            }
          };
          document.addEventListener("click", rec.clickHandler, true);
          document.addEventListener("input", rec.inputHandler, true);
          window.__claudeBridgeRecorder = rec;
        },
        [],
        "MAIN"
      );
      return { tab_id: tab.id, recording: true, note: "Recording clicks and inputs. Call with stop=true to get the recorded actions." };
    }

    case "replay_actions": {
      if (!params.actions?.length) throw new Error("'actions' array required");
      const results = [];
      for (const action of params.actions) {
        const r = await execInTab(
          tab.id,
          (act) => {
            const el = document.querySelector(act.selector);
            if (!el) return { error: "Not found: " + act.selector };
            if (act.type === "click") { el.scrollIntoView({ block: "center" }); el.click(); return { ok: true }; }
            if (act.type === "fill") {
              el.focus();
              const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
              if (setter) setter.call(el, act.value); else el.value = act.value;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
              return { ok: true };
            }
            return { error: "Unknown action: " + act.type };
          },
          [action],
          "MAIN"
        );
        results.push({ ...action, result: r });
        if (params.delay_ms) await new Promise(r => setTimeout(r, params.delay_ms));
      }
      return { tab_id: tab.id, replayed: results };
    }

    case "mock_network": {
      return await withCDP(tab.id, async () => {
        await cdpSend(tab.id, "Fetch.enable", {
          patterns: [{ urlPattern: params.url_pattern || "*", requestStage: "Response" }],
        });
        const mockBody = params.response_body ? btoa(typeof params.response_body === "string" ? params.response_body : JSON.stringify(params.response_body)) : null;
        chrome.debugger.onEvent.addListener(function handler(source, method, eventParams) {
          if (source.tabId !== tab.id || method !== "Fetch.requestPaused") return;
          if (params.url_pattern && !eventParams.request.url.includes(params.url_pattern.replace("*", ""))) {
            cdpSend(tab.id, "Fetch.continueRequest", { requestId: eventParams.requestId });
            return;
          }
          cdpSend(tab.id, "Fetch.fulfillRequest", {
            requestId: eventParams.requestId,
            responseCode: params.status_code || 200,
            responseHeaders: [{ name: "Content-Type", value: params.content_type || "application/json" }],
            body: mockBody || btoa("{}"),
          });
        });
        return { tab_id: tab.id, mocking: params.url_pattern, status: params.status_code || 200, note: "Network mock active. Reload or navigate to trigger. Detach debugger to stop." };
      });
    }

    case "highlight_element": {
      const ref = parseRef(params.ref);
      const result = await execInTab(
        tab.id,
        (sel, refIdx, color, duration) => {
          const el = refIdx !== null ? window.__claudeBridge && window.__claudeBridge.refs?.[refIdx] : (sel ? document.querySelector(sel) : null);
          if (!el) return { error: "Element not found" };
          el.scrollIntoView({ block: "center" });
          const overlay = document.createElement("div");
          const rect = el.getBoundingClientRect();
          overlay.style.cssText = `position:fixed;left:${rect.left-3}px;top:${rect.top-3}px;width:${rect.width+6}px;height:${rect.height+6}px;border:3px solid ${color};border-radius:4px;z-index:2147483646;pointer-events:none;animation:_claudePulse 0.6s ease-in-out 3;box-sizing:border-box;`;
          if (!document.getElementById("__claudePulseStyle")) {
            const s = document.createElement("style");
            s.id = "__claudePulseStyle";
            s.textContent = "@keyframes _claudePulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }";
            document.head.appendChild(s);
          }
          document.body.appendChild(overlay);
          setTimeout(() => overlay.remove(), duration);
          return { highlighted: sel || "ref_" + refIdx, tag: el.tagName, text: el.textContent?.trim().slice(0, 50), box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } };
        },
        [params.selector || null, ref, params.color || "#D97757", params.duration_ms || 3000],
        "MAIN"
      );
      if (result?.error) throw new Error(result.error);
      return { tab_id: tab.id, ...result };
    }

    // =====================================================================
    // TIER 2 — Productivity multipliers
    // =====================================================================

    case "save_form_profile": {
      const data = await execInTab(
        tab.id,
        (profileName) => {
          const inputs = document.querySelectorAll("input, select, textarea");
          const fields = [];
          for (const inp of inputs) {
            if (!inp.name && !inp.id && !inp.getAttribute("aria-label")) continue;
            const key = inp.name || inp.id || inp.getAttribute("aria-label");
            let value = inp.type === "checkbox" ? inp.checked : inp.type === "radio" ? (inp.checked ? inp.value : null) : inp.value;
            if (value === null || value === "") continue;
            fields.push({ key, value, type: inp.type || "text", selector: inp.id ? "#" + inp.id : (inp.name ? `[name="${inp.name}"]` : null) });
          }
          const profiles = JSON.parse(localStorage.getItem("__claudeBridgeProfiles") || "{}");
          profiles[profileName] = { fields, url: location.href, savedAt: new Date().toISOString() };
          localStorage.setItem("__claudeBridgeProfiles", JSON.stringify(profiles));
          return { saved: profileName, fieldCount: fields.length };
        },
        [params.name || "default"],
        "MAIN"
      );
      return { tab_id: tab.id, ...data };
    }

    case "load_form_profile": {
      const data = await execInTab(
        tab.id,
        (profileName) => {
          const profiles = JSON.parse(localStorage.getItem("__claudeBridgeProfiles") || "{}");
          const profile = profiles[profileName];
          if (!profile) return { error: "Profile not found: " + profileName, available: Object.keys(profiles) };
          let filled = 0;
          for (const field of profile.fields) {
            const el = field.selector ? document.querySelector(field.selector) : null;
            if (!el) continue;
            if (field.type === "checkbox") { el.checked = field.value; }
            else {
              const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
              if (setter) setter.call(el, field.value); else el.value = field.value;
            }
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            filled++;
          }
          return { loaded: profileName, totalFields: profile.fields.length, filledFields: filled };
        },
        [params.name || "default"],
        "MAIN"
      );
      if (data?.error) throw new Error(data.error);
      return { tab_id: tab.id, ...data };
    }

    case "get_load_timeline": {
      const timeline = await execInTab(
        tab.id,
        () => {
          const nav = performance.getEntriesByType("navigation")[0];
          const resources = performance.getEntriesByType("resource");
          const paint = performance.getEntriesByType("paint");
          const lcp = performance.getEntriesByType("largest-contentful-paint");
          const phases = [];
          if (nav) {
            phases.push({ phase: "DNS", start: Math.round(nav.domainLookupStart), end: Math.round(nav.domainLookupEnd), ms: Math.round(nav.domainLookupEnd - nav.domainLookupStart) });
            phases.push({ phase: "TCP", start: Math.round(nav.connectStart), end: Math.round(nav.connectEnd), ms: Math.round(nav.connectEnd - nav.connectStart) });
            phases.push({ phase: "Request", start: Math.round(nav.requestStart), end: Math.round(nav.responseStart), ms: Math.round(nav.responseStart - nav.requestStart) });
            phases.push({ phase: "Response", start: Math.round(nav.responseStart), end: Math.round(nav.responseEnd), ms: Math.round(nav.responseEnd - nav.responseStart) });
            phases.push({ phase: "DOM Processing", start: Math.round(nav.responseEnd), end: Math.round(nav.domComplete), ms: Math.round(nav.domComplete - nav.responseEnd) });
            phases.push({ phase: "Load Event", start: Math.round(nav.loadEventStart), end: Math.round(nav.loadEventEnd), ms: Math.round(nav.loadEventEnd - nav.loadEventStart) });
          }
          const waterfall = resources
            .sort((a, b) => a.startTime - b.startTime)
            .slice(0, 30)
            .map(r => ({
              name: r.name.split("/").pop().split("?")[0].slice(0, 40),
              type: r.initiatorType,
              start: Math.round(r.startTime),
              duration: Math.round(r.duration),
              size: Math.round(r.transferSize / 1024) + "KB",
            }));
          return {
            phases,
            milestones: {
              firstPaint: Math.round(paint.find(p => p.name === "first-paint")?.startTime || 0),
              fcp: Math.round(paint.find(p => p.name === "first-contentful-paint")?.startTime || 0),
              lcp: Math.round(lcp[lcp.length - 1]?.startTime || 0),
              domContentLoaded: Math.round(nav?.domContentLoadedEventEnd || 0),
              loadComplete: Math.round(nav?.loadEventEnd || 0),
            },
            waterfall,
            totalResources: resources.length,
            totalTransferKB: Math.round(resources.reduce((s, r) => s + (r.transferSize || 0), 0) / 1024),
          };
        },
        [],
        "MAIN"
      );
      return { tab_id: tab.id, url: tab.url, ...timeline };
    }

    case "get_grouped_console": {
      await ensureRecorder(tab.id);
      const grouped = await execInTab(
        tab.id,
        () => {
          const b = window.__claudeBridge;
          const groups = {};
          for (const log of b.logs) {
            const key = log.level + ":" + (log.args[0] || "").slice(0, 80);
            if (!groups[key]) groups[key] = { level: log.level, message: (log.args[0] || "").slice(0, 200), count: 0, firstTime: log.time, lastTime: log.time, sample: log.args };
            groups[key].count++;
            groups[key].lastTime = log.time;
          }
          return Object.values(groups).sort((a, b) => b.count - a.count).slice(0, 30);
        },
        [],
        "MAIN"
      );
      return { tab_id: tab.id, url: tab.url, groups: grouped };
    }

    case "generate_selector": {
      const ref = parseRef(params.ref);
      const result = await execInTab(
        tab.id,
        (sel, refIdx) => {
          const el = refIdx !== null ? window.__claudeBridge && window.__claudeBridge.refs?.[refIdx] : (sel ? document.querySelector(sel) : null);
          if (!el) return { error: "Element not found" };
          const selectors = [];
          if (el.id) selectors.push({ type: "id", selector: "#" + el.id, specificity: "unique" });
          if (el.getAttribute("data-testid")) selectors.push({ type: "data-testid", selector: `[data-testid="${el.getAttribute("data-testid")}"]`, specificity: "unique" });
          if (el.getAttribute("aria-label")) selectors.push({ type: "aria-label", selector: `[aria-label="${el.getAttribute("aria-label")}"]`, specificity: "likely unique" });
          if (el.name) selectors.push({ type: "name", selector: `[name="${el.name}"]`, specificity: "likely unique" });
          // Build a path selector
          const path = [];
          let node = el;
          while (node && node !== document.body) {
            let seg = node.tagName.toLowerCase();
            if (node.id) { path.unshift("#" + node.id); break; }
            const siblings = node.parentElement ? [...node.parentElement.children].filter(c => c.tagName === node.tagName) : [];
            if (siblings.length > 1) seg += `:nth-of-type(${siblings.indexOf(node) + 1})`;
            path.unshift(seg);
            node = node.parentElement;
          }
          selectors.push({ type: "path", selector: path.join(" > "), specificity: "exact" });
          // Text-based
          const text = el.textContent?.trim();
          if (text && text.length < 50 && el.children.length === 0) {
            selectors.push({ type: "text", selector: `${el.tagName.toLowerCase()}:has-text("${text}")`, specificity: "fragile" });
          }
          return { tag: el.tagName.toLowerCase(), selectors };
        },
        [params.selector || null, ref],
        "MAIN"
      );
      if (result?.error) throw new Error(result.error);
      return { tab_id: tab.id, ...result };
    }

    case "save_tab_session": {
      const tabs = await chrome.tabs.query({});
      const session = tabs.map(t => ({ url: t.url, title: t.title, pinned: t.pinned, active: t.active })).filter(t => !t.url.startsWith("chrome://"));
      const key = params.name || "default";
      await chrome.storage.local.set({ ["session_" + key]: { tabs: session, savedAt: new Date().toISOString() } });
      return { saved: key, tabCount: session.length };
    }

    case "restore_tab_session": {
      const key = params.name || "default";
      const data = await chrome.storage.local.get("session_" + key);
      const session = data["session_" + key];
      if (!session) {
        const all = await chrome.storage.local.get(null);
        const available = Object.keys(all).filter(k => k.startsWith("session_")).map(k => k.replace("session_", ""));
        throw new Error("Session not found: " + key + ". Available: " + available.join(", "));
      }
      const opened = [];
      for (const t of session.tabs) {
        const newTab = await chrome.tabs.create({ url: t.url, pinned: t.pinned });
        opened.push({ tab_id: newTab.id, url: t.url });
      }
      return { restored: key, tabCount: opened.length, tabs: opened };
    }

    // =====================================================================
    // TIER 3 — Polish and edge cases
    // =====================================================================

    case "set_geolocation": {
      return await withCDP(tab.id, async () => {
        if (params.clear) {
          await cdpSend(tab.id, "Emulation.clearGeolocationOverride");
            return { tab_id: tab.id, geolocation: "cleared" };
        }
        await cdpSend(tab.id, "Emulation.setGeolocationOverride", {
          latitude: params.latitude || 28.6139, longitude: params.longitude || 77.2090, accuracy: params.accuracy || 100,
        });
        return { tab_id: tab.id, geolocation: { lat: params.latitude || 28.6139, lng: params.longitude || 77.2090 } };
      });
    }

    case "toggle_dark_mode": {
      return await withCDP(tab.id, async () => {
        const isDark = params.dark !== false;
        await cdpSend(tab.id, "Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: isDark ? "dark" : "light" }],
        });
        return { tab_id: tab.id, darkMode: isDark };
      });
    }

    case "edit_cookie": {
      if (params.delete) {
        await chrome.cookies.remove({ url: tab.url, name: params.name });
        return { tab_id: tab.id, deleted: params.name };
      }
      if (!params.name) throw new Error("'name' is required");
      const url = new URL(tab.url);
      const cookie = await chrome.cookies.set({
        url: tab.url,
        name: params.name,
        value: params.value || "",
        domain: params.domain || url.hostname,
        path: params.path || "/",
        secure: params.secure ?? url.protocol === "https:",
        httpOnly: params.httpOnly ?? false,
        expirationDate: params.expirationDate || (Date.now() / 1000 + 86400 * 30),
      });
      return { tab_id: tab.id, set: cookie };
    }

    case "search_network_bodies": {
      await ensureRecorder(tab.id);
      const matches = await execInTab(
        tab.id,
        (query) => {
          const b = window.__claudeBridge;
          const results = [];
          for (const req of b.requests) {
            const inUrl = req.url?.includes(query);
            const inReqBody = req.requestBody?.includes(query);
            const inResBody = req.responseBody?.includes(query);
            if (inUrl || inReqBody || inResBody) {
              results.push({
                method: req.method,
                url: req.url?.slice(0, 100),
                status: req.status,
                matchIn: [inUrl && "url", inReqBody && "requestBody", inResBody && "responseBody"].filter(Boolean),
                context: (req.responseBody || req.requestBody || "")
                  .slice(Math.max(0, (req.responseBody || req.requestBody || "").indexOf(query) - 50), (req.responseBody || req.requestBody || "").indexOf(query) + query.length + 50)
                  .slice(0, 200),
              });
            }
          }
          return results.slice(0, 20);
        },
        [params.query],
        "MAIN"
      );
      return { tab_id: tab.id, query: params.query, matches };
    }

    // =====================================================================
    // Session-requested tools (#1-#6 from debugging feedback)
    // =====================================================================

    case "inspect_pixel": {
      // #1: Sample RGBA at a coordinate on any rendered element (bypasses CORS on images)
      return await withCDP(tab.id, async () => {
        // Use CDP to screenshot just the element region, then read the pixel from the image
        const x = params.x ?? 0;
        const y = params.y ?? 0;
        const sel = params.selector;
        const ref = parseRef(params.ref);

        // Get element's viewport position
        const rect = await execInTab(
          tab.id,
          (sel, refIdx) => {
            const el = refIdx !== null ? window.__claudeBridge && window.__claudeBridge.refs?.[refIdx] : (sel ? document.querySelector(sel) : null);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
          },
          [sel || null, ref],
          "MAIN"
        );
        if (!rect) throw new Error("Element not found");

        // Calculate absolute pixel position
        const pixelX = params.percent ? Math.round(rect.x + rect.w * (x / 100)) : Math.round(rect.x + x);
        const pixelY = params.percent ? Math.round(rect.y + rect.h * (y / 100)) : Math.round(rect.y + y);

        // Capture a 1x1 screenshot at that exact pixel using CDP
        const { data } = await cdpSend(tab.id, "Page.captureScreenshot",
          { format: "png", clip: { x: pixelX, y: pixelY, width: 1, height: 1, scale: 1 } }
        );

        // Decode PNG to get RGBA — the 1x1 PNG has a known structure
        // Simpler: capture a small region and use canvas
        const rgba = await execInTab(
          tab.id,
          async (imgData, px, py, elRect) => {
            const img = new Image();
            const canvas = document.createElement("canvas");
            canvas.width = 10; canvas.height = 10;
            return new Promise(resolve => {
              img.onload = () => {
                const ctx = canvas.getContext("2d");
                ctx.drawImage(img, 0, 0);
                const pixel = ctx.getImageData(0, 0, 1, 1).data;
                resolve({ r: pixel[0], g: pixel[1], b: pixel[2], a: pixel[3], hex: "#" + [pixel[0], pixel[1], pixel[2]].map(v => v.toString(16).padStart(2, "0")).join(""), opacity: Math.round(pixel[3] / 255 * 100) + "%", at: { x: px, y: py }, elementBox: elRect });
              };
              img.onerror = () => resolve({ error: "Failed to decode pixel" });
              img.src = "data:image/png;base64," + imgData;
            });
          },
          [data, pixelX, pixelY, rect],
          "MAIN"
        );
        return { tab_id: tab.id, ...rgba };
      });
    }

    case "get_element_rect": {
      // #2: Get exact computed position, size, and relationship to parent/viewport
      const ref = parseRef(params.ref);
      const result = await execInTab(
        tab.id,
        (sel, refIdx, includeChildren) => {
          const el = refIdx !== null ? window.__claudeBridge && window.__claudeBridge.refs?.[refIdx] : (sel ? document.querySelector(sel) : null);
          if (!el) return { error: "Element not found" };
          const vr = el.getBoundingClientRect();
          const parent = el.offsetParent;
          const pr = parent?.getBoundingClientRect();
          const result = {
            tag: el.tagName.toLowerCase(),
            id: el.id || undefined,
            className: el.className?.toString().slice(0, 100) || undefined,
            viewport: { x: Math.round(vr.x), y: Math.round(vr.y), width: Math.round(vr.width), height: Math.round(vr.height), bottom: Math.round(vr.bottom), right: Math.round(vr.right) },
            offset: { top: el.offsetTop, left: el.offsetLeft, width: el.offsetWidth, height: el.offsetHeight },
            scroll: { top: el.scrollTop, left: el.scrollLeft, width: el.scrollWidth, height: el.scrollHeight },
            parent: parent ? { tag: parent.tagName.toLowerCase(), viewport: { x: Math.round(pr.x), y: Math.round(pr.y), width: Math.round(pr.width), height: Math.round(pr.height) } } : null,
            zIndex: window.getComputedStyle(el).zIndex,
            position: window.getComputedStyle(el).position,
            display: window.getComputedStyle(el).display,
            visibility: window.getComputedStyle(el).visibility,
            opacity: window.getComputedStyle(el).opacity,
            overflow: window.getComputedStyle(el).overflow,
            isVisible: vr.width > 0 && vr.height > 0 && window.getComputedStyle(el).visibility !== "hidden" && window.getComputedStyle(el).display !== "none",
          };
          if (includeChildren) {
            result.children = [...el.children].slice(0, 20).map(c => {
              const cr = c.getBoundingClientRect();
              return { tag: c.tagName.toLowerCase(), className: c.className?.toString().slice(0, 60), viewport: { x: Math.round(cr.x), y: Math.round(cr.y), w: Math.round(cr.width), h: Math.round(cr.height) }, zIndex: window.getComputedStyle(c).zIndex };
            });
          }
          return result;
        },
        [params.selector || null, ref, Boolean(params.include_children)],
        "MAIN"
      );
      if (result?.error) throw new Error(result.error);
      return { tab_id: tab.id, ...result };
    }

    case "compare_tabs": {
      // #3: Screenshot two tabs and return both images for side-by-side comparison
      const tab1 = params.tab_id_1;
      const tab2 = params.tab_id_2;
      if (!tab1 || !tab2) throw new Error("Both tab_id_1 and tab_id_2 are required");

      // Capture tab 1 via CDP (no focus stealing)
      if (markedTabId === tab1) await applyMarker(tab1, false);
      const img1 = await withCDP(tab1, async () => {
        const { data } = await cdpSend(tab1, "Page.captureScreenshot", { format: "png" });
        return "data:image/png;base64," + data;
      });
      if (markedTabId === tab1) applyMarker(tab1, true);

      // Capture tab 2 via CDP (no focus stealing)
      if (markedTabId === tab2) await applyMarker(tab2, false);
      const img2 = await withCDP(tab2, async () => {
        const { data } = await cdpSend(tab2, "Page.captureScreenshot", { format: "png" });
        return "data:image/png;base64," + data;
      });
      if (markedTabId === tab2) applyMarker(tab2, true);

      // Compute diff
      const diff = await execInTab(
        tab2,
        (src1, src2) => {
          return new Promise(resolve => {
            const imgA = new Image(); const imgB = new Image();
            let loaded = 0;
            const onLoad = () => {
              if (++loaded < 2) return;
              const w = Math.min(imgA.width, imgB.width);
              const h = Math.min(imgA.height, imgB.height);
              const canvas = document.createElement("canvas");
              canvas.width = w; canvas.height = h;
              const ctx = canvas.getContext("2d");
              ctx.drawImage(imgA, 0, 0);
              const dataA = ctx.getImageData(0, 0, w, h);
              ctx.drawImage(imgB, 0, 0);
              const dataB = ctx.getImageData(0, 0, w, h);
              let diffCount = 0;
              for (let i = 0; i < dataA.data.length; i += 4) {
                const d = Math.abs(dataA.data[i] - dataB.data[i]) + Math.abs(dataA.data[i+1] - dataB.data[i+1]) + Math.abs(dataA.data[i+2] - dataB.data[i+2]);
                if (d > 30) { dataB.data[i] = 255; dataB.data[i+1] = 0; dataB.data[i+2] = 0; dataB.data[i+3] = 200; diffCount++; }
              }
              ctx.putImageData(dataB, 0, 0);
              resolve({ diffPercent: Math.round(diffCount / (w * h) * 10000) / 100, diffPixels: diffCount, diffImage: canvas.toDataURL("image/png") });
            };
            imgA.onload = onLoad; imgB.onload = onLoad;
            imgA.src = src1; imgB.src = src2;
          });
        },
        [img1, img2],
        "MAIN"
      );

      return { tab_id_1: tab1, tab_id_2: tab2, screenshot1: img1, screenshot2: img2, ...diff };
    }

    case "annotate": {
      // #4: Draw persistent labeled overlays on elements for visual debugging
      const annotations = params.annotations || [{ selector: params.selector, ref: params.ref, label: params.label || "", color: params.color || "#D97757" }];
      const result = await execInTab(
        tab.id,
        (annList) => {
          // Clear previous annotations
          document.querySelectorAll(".__claude_annotation__").forEach(e => e.remove());
          const results = [];
          for (const ann of annList) {
            const refIdx = ann.ref !== null && ann.ref !== undefined ? Number(String(ann.ref).replace(/^ref_/, "")) : null;
            const el = refIdx !== null ? window.__claudeBridge && window.__claudeBridge.refs?.[refIdx] : (ann.selector ? document.querySelector(ann.selector) : null);
            if (!el) { results.push({ error: "Not found: " + (ann.selector || "ref_" + refIdx) }); continue; }
            const rect = el.getBoundingClientRect();
            const overlay = document.createElement("div");
            overlay.className = "__claude_annotation__";
            overlay.style.cssText = `position:fixed;left:${rect.left-2}px;top:${rect.top-2}px;width:${rect.width+4}px;height:${rect.height+4}px;border:2px solid ${ann.color};z-index:2147483646;pointer-events:none;box-sizing:border-box;`;
            if (ann.label) {
              const lbl = document.createElement("div");
              lbl.textContent = ann.label;
              lbl.style.cssText = `position:absolute;top:-18px;left:0;background:${ann.color};color:#fff;font:bold 10px/1.6 sans-serif;padding:0 6px;border-radius:3px 3px 0 0;white-space:nowrap;`;
              overlay.appendChild(lbl);
            }
            document.body.appendChild(overlay);
            results.push({ label: ann.label, tag: el.tagName.toLowerCase(), box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } });
          }
          return results;
        },
        [annotations],
        "MAIN"
      );
      return { tab_id: tab.id, annotations: result };
    }

    case "clear_annotations": {
      await execInTab(tab.id, () => { document.querySelectorAll(".__claude_annotation__").forEach(e => e.remove()); return true; }, [], "MAIN");
      return { tab_id: tab.id, cleared: true };
    }

    case "capture_canvas": {
      // #5: Flatten stacked elements into a single canvas capture, return as PNG
      const ref = parseRef(params.ref);
      const result = await execInTab(
        tab.id,
        async (sel, refIdx) => {
          const el = refIdx !== null ? window.__claudeBridge && window.__claudeBridge.refs?.[refIdx] : (sel ? document.querySelector(sel) : null);
          if (!el) return { error: "Element not found" };
          const rect = el.getBoundingClientRect();
          // Use html2canvas-like approach: draw to an offscreen canvas via drawImage
          const canvas = document.createElement("canvas");
          const dpr = window.devicePixelRatio || 1;
          canvas.width = Math.round(rect.width * dpr);
          canvas.height = Math.round(rect.height * dpr);
          const ctx = canvas.getContext("2d");
          ctx.scale(dpr, dpr);
          // Collect all child images and draw them in order (z-index stacking)
          const images = el.querySelectorAll("img");
          const draws = [];
          for (const img of images) {
            if (!img.complete || img.naturalWidth === 0) continue;
            const ir = img.getBoundingClientRect();
            draws.push({ img, x: ir.x - rect.x, y: ir.y - rect.y, w: ir.width, h: ir.height, zIndex: parseInt(window.getComputedStyle(img).zIndex) || 0 });
          }
          draws.sort((a, b) => a.zIndex - b.zIndex);
          for (const d of draws) {
            try {
              ctx.drawImage(d.img, d.x, d.y, d.w, d.h);
            } catch (e) {
              // CORS — try with crossOrigin
            }
          }
          return {
            dataUrl: canvas.toDataURL("image/png"),
            width: canvas.width,
            height: canvas.height,
            imageCount: draws.length,
            elementBox: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          };
        },
        [params.selector || null, ref],
        "MAIN"
      );
      if (result?.error) throw new Error(result.error);
      return { tab_id: tab.id, ...result };
    }

    case "set_storage": {
      // #6: Write to localStorage/sessionStorage (eval was fragile for complex JSON)
      const result = await execInTab(
        tab.id,
        (storageType, key, value, action) => {
          const store = storageType === "session" ? sessionStorage : localStorage;
          if (action === "clear") { store.clear(); return { cleared: storageType }; }
          if (action === "remove") { store.removeItem(key); return { removed: key }; }
          store.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
          return { set: key, length: store.getItem(key)?.length };
        },
        [params.storage_type || "local", params.key, params.value, params.action || "set"],
        "MAIN"
      );
      return { tab_id: tab.id, ...result };
    }

    // =====================================================================
    // Video understanding tools — read YouTube videos through the browser
    // =====================================================================

    case "video_get_captions": {
      // Extract ALL captions/subtitles from the current YouTube video at once
      const captions = await execInTab(
        tab.id,
        () => {
          const video = document.querySelector("video");
          if (!video) return { error: "No video element found on this page" };
          const tracks = video.textTracks;
          if (!tracks || tracks.length === 0) return { error: "No caption tracks available" };
          // Find the best track (prefer English, then first available)
          let track = null;
          for (let i = 0; i < tracks.length; i++) {
            if (tracks[i].language === "en" || tracks[i].kind === "captions" || tracks[i].kind === "subtitles") {
              track = tracks[i]; break;
            }
          }
          if (!track) track = tracks[0];
          // Enable the track to load cues
          track.mode = "showing";
          const cues = [];
          if (track.cues) {
            for (let i = 0; i < Math.min(track.cues.length, 2000); i++) {
              const c = track.cues[i];
              cues.push({
                start: Math.round(c.startTime * 10) / 10,
                end: Math.round(c.endTime * 10) / 10,
                text: c.text?.replace(/<[^>]*>/g, "").trim(),
              });
            }
          }
          track.mode = "hidden";
          return {
            url: location.href,
            title: document.title,
            language: track.language || track.label,
            totalCues: cues.length,
            duration: Math.round(video.duration || 0),
            captions: cues,
          };
        },
        [],
        "MAIN"
      );
      if (captions?.error) throw new Error(captions.error);
      return { tab_id: tab.id, ...captions };
    }

    case "video_control": {
      // Control video playback: play, pause, seek to timestamp, get current state
      const result = await execInTab(
        tab.id,
        (action, seekTo) => {
          const video = document.querySelector("video");
          if (!video) return { error: "No video element found" };
          if (action === "play") { video.play(); return { action: "play", currentTime: video.currentTime }; }
          if (action === "pause") { video.pause(); return { action: "pause", currentTime: video.currentTime }; }
          if (action === "seek") { video.currentTime = seekTo; return { action: "seek", currentTime: seekTo }; }
          if (action === "status") {
            return {
              currentTime: Math.round(video.currentTime * 10) / 10,
              duration: Math.round(video.duration),
              paused: video.paused,
              playbackRate: video.playbackRate,
              volume: video.volume,
            };
          }
          if (action === "speed") { video.playbackRate = seekTo; return { action: "speed", playbackRate: seekTo }; }
          return { error: "Unknown action: " + action + ". Use: play, pause, seek, status, speed" };
        },
        [params.action || "status", params.value || 0],
        "MAIN"
      );
      if (result?.error) throw new Error(result.error);
      return { tab_id: tab.id, ...result };
    }

    case "video_capture_frame": {
      // Pause video at a specific timestamp and screenshot the frame
      // This lets Claude "see" what's on screen at any point in the video
      await execInTab(
        tab.id,
        (seekTo) => {
          const video = document.querySelector("video");
          if (!video) return false;
          video.pause();
          if (seekTo !== null && seekTo !== undefined) video.currentTime = seekTo;
          return true;
        },
        [params.timestamp ?? null],
        "MAIN"
      );
      // Wait for frame to render
      await new Promise(r => setTimeout(r, 500));
      // Take screenshot via CDP (no focus stealing)
      if (markedTabId === tab.id) await applyMarker(tab.id, false);
      let dataUrl;
      try {
        dataUrl = await withCDP(tab.id, async () => {
          const { data } = await cdpSend(tab.id, "Page.captureScreenshot", { format: "png" });
          return "data:image/png;base64," + data;
        });
      } catch {
        if (!tab.active) { await chrome.tabs.update(tab.id, { active: true }); await new Promise(r => setTimeout(r, 200)); }
        dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      }
      if (markedTabId === tab.id) applyMarker(tab.id, true);
      // Get current caption at this timestamp
      const caption = await execInTab(
        tab.id,
        () => {
          const video = document.querySelector("video");
          if (!video) return null;
          const tracks = video.textTracks;
          for (let i = 0; i < tracks.length; i++) {
            const t = tracks[i];
            if (t.activeCues && t.activeCues.length > 0) {
              return t.activeCues[0].text?.replace(/<[^>]*>/g, "").trim();
            }
          }
          return null;
        },
        [],
        "MAIN"
      );
      return { tab_id: tab.id, timestamp: params.timestamp, caption, dataUrl };
    }

    case "video_get_chapters": {
      // Extract chapter markers from YouTube video description or progress bar
      const chapters = await execInTab(
        tab.id,
        () => {
          // Method 1: Try structured chapter data from YouTube's DOM
          const chapterEls = document.querySelectorAll("ytd-macro-markers-list-item-renderer, [class*='chapter']");
          if (chapterEls.length > 0) {
            return [...chapterEls].map(el => ({
              title: el.querySelector("#details h4, .macro-markers")?.textContent?.trim() || el.textContent?.trim().slice(0, 80),
              time: el.querySelector("#time, .timestamp")?.textContent?.trim(),
            })).filter(c => c.title);
          }
          // Method 2: Parse description for timestamp patterns (0:00, 1:23, 10:45)
          const desc = document.querySelector("#description-inner, #description ytd-text-inline-expander, [id*=description]")?.textContent || "";
          const lines = desc.split("\n");
          const chapters = [];
          for (const line of lines) {
            const match = line.match(/(\d{1,2}:\d{2}(?::\d{2})?)\s*[-–—]?\s*(.+)/);
            if (match) {
              chapters.push({ time: match[1], title: match[2].trim() });
            }
          }
          return chapters.length > 0 ? chapters : [{ note: "No chapters found in video" }];
        },
        [],
        "MAIN"
      );
      return { tab_id: tab.id, url: tab.url, chapters };
    }

    case "video_listen": {
      // When no transcript/captions exist: use Chrome's Web Speech API
      // to listen to the audio playing in the tab and transcribe it live.
      // Records for `duration_ms` (default 30s, max 120s) and returns text.
      const duration = Math.min(params.duration_ms ?? 30000, 120000);
      const result = await execInTab(
        tab.id,
        (durationMs) => {
          return new Promise((resolve) => {
            if (!("webkitSpeechRecognition" in window) && !("SpeechRecognition" in window)) {
              resolve({ error: "Speech recognition not available in this browser. Use Chrome." });
              return;
            }
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            const recognition = new SpeechRecognition();
            recognition.continuous = true;
            recognition.interimResults = false;
            recognition.lang = "en-US";
            recognition.maxAlternatives = 1;
            const transcript = [];
            const startTime = Date.now();
            recognition.onresult = (event) => {
              for (let i = event.resultIndex; i < event.results.length; i++) {
                if (event.results[i].isFinal) {
                  transcript.push({
                    text: event.results[i][0].transcript.trim(),
                    confidence: Math.round(event.results[i][0].confidence * 100),
                    timeOffset: Math.round((Date.now() - startTime) / 1000),
                  });
                }
              }
            };
            recognition.onerror = (event) => {
              if (event.error === "no-speech") return; // just silence, keep going
              resolve({ error: "Speech recognition error: " + event.error, partialTranscript: transcript });
            };
            recognition.onend = () => {
              // Restart if duration not reached (Chrome stops after ~60s of silence)
              if (Date.now() - startTime < durationMs) {
                try { recognition.start(); } catch {}
              }
            };
            recognition.start();
            setTimeout(() => {
              try { recognition.stop(); } catch {}
              resolve({
                transcript: transcript.map(t => t.text).join(" "),
                segments: transcript,
                durationListened: Math.round((Date.now() - startTime) / 1000) + "s",
                note: transcript.length === 0
                  ? "No speech detected. Make sure the video is playing with audio unmuted."
                  : undefined,
              });
            }, durationMs);
          });
        },
        [duration],
        "MAIN"
      );
      if (result?.error) throw new Error(result.error);
      return { tab_id: tab.id, ...result };
    }

    case "video_smart_read": {
      // Intelligent video reader: tries captions first, falls back to speech recognition
      // This is the "just give me what the video says" tool
      const captions = await execInTab(
        tab.id,
        () => {
          const video = document.querySelector("video");
          if (!video) return { hasVideo: false };
          const tracks = video.textTracks;
          let hasCaptions = false;
          let captionData = [];
          if (tracks) {
            for (let i = 0; i < tracks.length; i++) {
              const t = tracks[i];
              if (t.kind === "captions" || t.kind === "subtitles") {
                t.mode = "showing";
                if (t.cues && t.cues.length > 0) {
                  hasCaptions = true;
                  for (let j = 0; j < Math.min(t.cues.length, 2000); j++) {
                    captionData.push({
                      start: Math.round(t.cues[j].startTime * 10) / 10,
                      text: t.cues[j].text?.replace(/<[^>]*>/g, "").trim(),
                    });
                  }
                }
                t.mode = "hidden";
                if (hasCaptions) break;
              }
            }
          }
          return {
            hasVideo: true,
            hasCaptions,
            duration: Math.round(video.duration || 0),
            title: document.title,
            url: location.href,
            captions: captionData,
          };
        },
        [],
        "MAIN"
      );

      if (!captions.hasVideo) throw new Error("No video found on this page");

      if (captions.hasCaptions && captions.captions.length > 0) {
        return {
          tab_id: tab.id,
          method: "captions",
          ...captions,
          fullText: captions.captions.map(c => c.text).join(" "),
        };
      }

      // No captions — fall back to speech recognition
      // Play the video and listen
      await execInTab(tab.id, () => {
        const v = document.querySelector("video");
        if (v) { v.currentTime = 0; v.play(); }
      }, [], "MAIN");

      const listenDuration = Math.min(params.listen_duration_ms ?? 60000, 120000);
      const speech = await execInTab(
        tab.id,
        (durationMs) => {
          return new Promise((resolve) => {
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            if (!SpeechRecognition) { resolve({ error: "No speech recognition" }); return; }
            const recognition = new SpeechRecognition();
            recognition.continuous = true;
            recognition.interimResults = false;
            recognition.lang = "en-US";
            const transcript = [];
            const start = Date.now();
            recognition.onresult = (e) => {
              for (let i = e.resultIndex; i < e.results.length; i++) {
                if (e.results[i].isFinal) transcript.push(e.results[i][0].transcript.trim());
              }
            };
            recognition.onend = () => { if (Date.now() - start < durationMs) try { recognition.start(); } catch {} };
            recognition.onerror = () => {};
            recognition.start();
            setTimeout(() => {
              try { recognition.stop(); } catch {}
              const v = document.querySelector("video");
              if (v) v.pause();
              resolve({ transcript: transcript.join(" "), segments: transcript.length });
            }, durationMs);
          });
        },
        [listenDuration],
        "MAIN"
      );

      return {
        tab_id: tab.id,
        method: "speech_recognition",
        title: captions.title,
        url: captions.url,
        duration: captions.duration,
        fullText: speech.transcript || "",
        segmentCount: speech.segments || 0,
        note: !speech.transcript
          ? "No speech detected. The video may need to be unmuted, or it may not have spoken content."
          : "Transcribed via Chrome Speech Recognition (may have minor inaccuracies).",
      };
    }

    default:
      throw new Error("Unknown method: " + msg.method);
  }
}

ensureConnected();
