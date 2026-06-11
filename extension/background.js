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

setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "ping" }));
  }
}, 25000);

chrome.alarms.create("bridge-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => ensureConnected());
chrome.runtime.onStartup.addListener(() => ensureConnected());
chrome.runtime.onInstalled.addListener(() => ensureConnected());

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
const injectedTabs = new Set(); // tracks tabs with inject.js already present

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

async function applyMarker(tabId, show) {
  try {
    const t = await chrome.tabs.get(tabId);
    if (t.url?.startsWith("file://") || t.url?.startsWith("chrome://")) return;
    await chrome.scripting.executeScript({ target: { tabId }, func: pageMarker, args: [show] });
  } catch {}
}

async function setMarker(tabId) {
  if (markedTabId === tabId) return;
  if (markedTabId !== null) {
    applyMarker(markedTabId, false); // fire-and-forget for old tab
    if (markerGrouped) {
      chrome.tabs.ungroup(markedTabId).catch(() => {});
      markerGrouped = false;
    }
  }
  markedTabId = tabId;
  if (tabId !== null) {
    applyMarker(tabId, true); // fire-and-forget — don't block the tool call
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

// Deferred marker: call after response is already sent.
function deferMarker(tabId) {
  setTimeout(() => setMarker(tabId), 0);
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
  await chrome.scripting.executeScript({ target: { tabId }, files: ["inject.js"], world: "MAIN" });
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
      if (ref !== null && ref !== undefined) {
        el = window.__claudeBridge?.refs?.[ref] || null;
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
        setTimeout(attempt, 150); // was 200 — faster polling
        return;
      }
      el.scrollIntoView({ block: "center" });
      try {
        if (action === "click") {
          el.click();
        } else if (el.isContentEditable) {
          el.focus();
          el.textContent = value;
          el.dispatchEvent(new InputEvent("input", { bubbles: true }));
        } else {
          el.focus();
          const proto =
            el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
            : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) setter.call(el, value);
          else el.value = value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        resolve({ ok: true, waitedMs: Date.now() - started });
      } catch (e) {
        resolve({ error: String(e) });
      }
    };
    attempt();
  });
}

function pageSnapshot(maxElements) {
  const bridge = window.__claudeBridge;
  if (!bridge) return null;
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
  const els = document.querySelectorAll(SELECTOR);
  for (let i = 0; i < els.length && lines.length < maxElements; i++) {
    const el = els[i];
    if (!el.offsetParent && el.tagName !== "BODY") continue; // faster than getClientRects
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
  }
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
      let found = false;
      if (sel) {
        const el = document.querySelector(sel);
        found = Boolean(el) && (!text || (el.innerText || "").includes(text));
      } else if (text) {
        found = Boolean(document.body?.innerText?.includes(text));
      }
      if (found) return resolve({ ok: true, waitedMs: Date.now() - started });
      if (Date.now() - started >= timeoutMs) {
        return resolve({
          error: `Timed out after ${timeoutMs}ms waiting for ${sel ? `selector "${sel}"` : ""}${sel && text ? " containing " : ""}${text ? `text "${text}"` : ""}`,
        });
      }
      setTimeout(check, 150); // was 200
    };
    check();
  });
}

// ---------------------------------------------------------------------------

function parseRef(ref) {
  if (ref === null || ref === undefined) return null;
  const n = Number(String(ref).replace(/^ref_/, ""));
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid ref: ${ref}`);
  return n;
}

async function actOnElement(tab, params, action) {
  const ref = parseRef(params.ref);
  if (ref === null && !params.selector) throw new Error("Provide either 'selector' or 'ref'");
  if (ref !== null) await ensureRecorder(tab.id);
  const waitMs = Math.min(params.wait_ms ?? 5000, 15000);
  const result = await execInTab(
    tab.id, pageLocateAndAct,
    [params.selector || null, ref, waitMs, action, params.value ?? null],
    "MAIN"
  );
  if (result?.error) throw new Error(result.error);
  return { [action === "click" ? "clicked" : "filled"]: params.selector || `ref_${ref}`, waitedMs: result.waitedMs };
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

  if (msg.method === "select_tab" && params.clear) {
    targetTabId = null;
    chrome.storage.session.remove("targetTabId");
    setMarker(null); // fire-and-forget
    return { selected: null, note: "Target unpinned; tools default to the active tab again." };
  }

  if (msg.method === "new_tab") {
    const newTab = await chrome.tabs.create({ url: params.url || "about:blank" });
    return { tab_id: newTab.id, url: newTab.pendingUrl || params.url };
  }

  const tab = await resolveTab(params);

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
      if (!tab.active) {
        await chrome.tabs.update(tab.id, { active: true });
        await new Promise((r) => setTimeout(r, 200)); // was 300
      }
      if (markedTabId === tab.id) await applyMarker(tab.id, false);
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        return { tab_id: tab.id, url: tab.url, dataUrl };
      } finally {
        if (markedTabId === tab.id) applyMarker(tab.id, true); // fire-and-forget restore
      }
    }

    case "navigate": {
      injectedTabs.delete(tab.id);
      await chrome.tabs.update(tab.id, { url: params.url });
      return { tab_id: tab.id, navigating_to: params.url };
    }

    case "hover": {
      const ref = parseRef(params.ref);
      if (ref === null && !params.selector) throw new Error("Provide 'ref' or 'selector'");
      if (ref !== null) await ensureRecorder(tab.id);
      const result = await execInTab(
        tab.id,
        (sel, refIdx) => {
          let el = refIdx !== null ? window.__claudeBridge?.refs?.[refIdx] : document.querySelector(sel);
          if (!el) return { error: "Element not found" };
          el.scrollIntoView({ block: "center" });
          el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
          return { ok: true };
        },
        [params.selector || null, ref],
        "MAIN"
      );
      if (result?.error) throw new Error(result.error);
      return { hovered: params.selector || `ref_${ref}` };
    }

    case "select_option": {
      const ref = parseRef(params.ref);
      if (ref === null && !params.selector) throw new Error("Provide 'ref' or 'selector'");
      if (!params.values?.length) throw new Error("'values' array is required");
      if (ref !== null) await ensureRecorder(tab.id);
      const result = await execInTab(
        tab.id,
        (sel, refIdx, values) => {
          let el = refIdx !== null ? window.__claudeBridge?.refs?.[refIdx] : document.querySelector(sel);
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
      return await execInTab(
        tab.id,
        (key, modifiers) => {
          const target = document.activeElement || document.body;
          const opts = {
            key, code: key, bubbles: true, cancelable: true,
            ctrlKey: modifiers.includes("Control"), shiftKey: modifiers.includes("Shift"),
            altKey: modifiers.includes("Alt"), metaKey: modifiers.includes("Meta"),
          };
          target.dispatchEvent(new KeyboardEvent("keydown", opts));
          target.dispatchEvent(new KeyboardEvent("keypress", opts));
          target.dispatchEvent(new KeyboardEvent("keyup", opts));
          return { ok: true, key, target: target.tagName };
        },
        [params.key, params.modifiers || []],
        "MAIN"
      );
    }

    case "scroll": {
      return await execInTab(
        tab.id,
        (sel, refIdx, direction, amount) => {
          let el = null;
          if (refIdx !== null) el = window.__claudeBridge?.refs?.[refIdx];
          else if (sel) el = document.querySelector(sel);
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
      injectedTabs.delete(tab.id);
      await chrome.tabs.reload(tab.id, { bypassCache: Boolean(params.bypass_cache) });
      return { tab_id: tab.id, action: "reload" };
    }

    case "close_tab": {
      await chrome.tabs.remove(tab.id);
      return { closed: tab.id };
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
      await chrome.debugger.attach({ tabId: tab.id }, "1.3");
      try {
        await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.enable");
        const { root } = await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.getDocument");
        let nodeId;
        if (ref !== null) {
          const uniqSel = await execInTab(
            tab.id,
            (refIdx) => {
              const el = window.__claudeBridge?.refs?.[refIdx];
              if (!el) return null;
              const tmpId = "__claude_upload_" + Date.now();
              el.setAttribute("data-claude-upload", tmpId);
              return `[data-claude-upload="${tmpId}"]`;
            },
            [ref],
            "MAIN"
          );
          if (!uniqSel) throw new Error(`ref_${ref} not found`);
          ({ nodeId } = await chrome.debugger.sendCommand(
            { tabId: tab.id }, "DOM.querySelector", { nodeId: root.nodeId, selector: uniqSel }
          ));
        } else {
          ({ nodeId } = await chrome.debugger.sendCommand(
            { tabId: tab.id }, "DOM.querySelector", { nodeId: root.nodeId, selector: params.selector }
          ));
        }
        if (!nodeId) throw new Error("File input element not found in DOM");
        await chrome.debugger.sendCommand(
          { tabId: tab.id }, "DOM.setFileInputFiles", { files: [params.file_path], nodeId }
        );
        return { uploaded: params.file_path, to: params.selector || `ref_${ref}` };
      } finally {
        await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
      }
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
          return {
            url: location.href,
            title: document.title,
            snapshot: snapLines.join("\n"),
            consoleErrors: errors,
            failedRequests: failedReqs,
            recentAPICalls: apiCalls,
            hasCaptcha: captchaSelectors.some(s => document.querySelector(s)),
            localStorage_keys: Object.keys(localStorage).slice(0, 30),
          };
        },
        [params.max_elements ?? 200],
        "MAIN"
      );
      return { tab_id: tab.id, ...data };
    }

    default:
      throw new Error("Unknown method: " + msg.method);
  }
}

ensureConnected();
