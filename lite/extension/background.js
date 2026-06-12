// Browser Bridge Lite — basic browser automation via WebSocket.
// 8 tools: list_tabs, snapshot, get_page_text, get_html, click, fill, screenshot, navigate.

const BRIDGE_URL = "ws://localhost:8787";
let socket = null;
let connecting = false;

function ensureConnected() {
  if (connecting || (socket && socket.readyState <= WebSocket.OPEN)) return;
  connecting = true;
  try { socket = new WebSocket(BRIDGE_URL); } catch { connecting = false; return; }
  socket.onopen = () => { connecting = false; };
  socket.onclose = () => { connecting = false; socket = null; setTimeout(ensureConnected, 3000); };
  socket.onerror = () => {};
  socket.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "pong") return;
    try {
      const result = await handle(msg);
      socket?.send(JSON.stringify({ id: msg.id, ok: true, result }));
    } catch (e) {
      socket?.send(JSON.stringify({ id: msg.id, ok: false, error: String(e?.message || e) }));
    }
  };
}

setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
}, 25000);
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => ensureConnected());
chrome.runtime.onStartup.addListener(() => ensureConnected());
chrome.runtime.onInstalled.addListener(() => ensureConnected());
chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
  if (msg?.type === "status") sendResponse({ connected: socket?.readyState === WebSocket.OPEN });
});

async function resolveTab(params) {
  if (params?.tab_id) return chrome.tabs.get(params.tab_id);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("No active tab found");
  return tab;
}

function execInTab(tabId, func, args = []) {
  return chrome.scripting.executeScript({ target: { tabId }, func, args })
    .then(([{ result }]) => result);
}

function pageSnapshot(maxElements) {
  const SELECTOR =
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
  if (!window.__bridgeLiteRefs) window.__bridgeLiteRefs = [];
  window.__bridgeLiteRefs = [];
  const lines = [];
  const els = document.querySelectorAll(SELECTOR);
  for (let i = 0; i < els.length && lines.length < maxElements; i++) {
    const el = els[i];
    if (!el.offsetParent && el.tagName !== "BODY") continue;
    const idx = window.__bridgeLiteRefs.length;
    window.__bridgeLiteRefs.push(el);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const kind = role || (tag === "input" ? `input[${el.type || "text"}]` : tag);
    const state = [];
    if (el.disabled) state.push("disabled");
    if (el.checked) state.push("checked");
    if ((tag === "input" || tag === "textarea" || tag === "select") && el.value)
      state.push(`value="${String(el.value).slice(0, 40)}"`);
    if (tag === "a" && el.getAttribute("href") && el.getAttribute("href") !== "#")
      state.push(`href="${el.getAttribute("href").slice(0, 80)}"`);
    lines.push(`ref_${idx} <${kind}> "${name(el)}"${state.length ? " (" + state.join(", ") + ")" : ""}`);
  }
  return lines.join("\n");
}

function pageClickOrFill(sel, ref, action, value) {
  let el = null;
  if (ref !== null && ref !== undefined) {
    el = window.__bridgeLiteRefs?.[ref];
    if (el && !el.isConnected) return { error: `ref_${ref} is stale — take a new snapshot` };
  } else {
    el = document.querySelector(sel);
  }
  if (!el) return { error: ref !== null ? `ref_${ref} not found` : `No element: ${sel}` };
  el.scrollIntoView({ block: "center" });
  if (action === "click") {
    el.click();
  } else {
    el.focus();
    if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } else {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, value); else el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  return { ok: true };
}

function parseRef(ref) {
  if (ref === null || ref === undefined) return null;
  const n = Number(String(ref).replace(/^ref_/, ""));
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid ref: ${ref}`);
  return n;
}

async function handle(msg) {
  const params = msg.params || {};

  if (msg.method === "list_tabs") {
    return (await chrome.tabs.query({})).map(t => ({
      tab_id: t.id, active: t.active, title: t.title, url: t.url,
    }));
  }

  const tab = await resolveTab(params);

  switch (msg.method) {
    case "get_page_text": {
      const text = await execInTab(tab.id, () => document.body ? document.body.innerText.slice(0, 50000) : "");
      return { tab_id: tab.id, url: tab.url, title: tab.title, text };
    }

    case "get_html": {
      const html = await execInTab(tab.id, (sel) => {
        const el = sel ? document.querySelector(sel) : document.documentElement;
        return el ? el.outerHTML.slice(0, 100000) : null;
      }, [params.selector || null]);
      if (html === null) throw new Error(`No element: ${params.selector}`);
      return { tab_id: tab.id, url: tab.url, html };
    }

    case "snapshot": {
      const max = Math.min(params.max_elements ?? 200, 500);
      const snap = await execInTab(tab.id, pageSnapshot, [max]);
      return { tab_id: tab.id, url: tab.url, title: tab.title, elements: snap || "(empty)" };
    }

    case "click": {
      const ref = parseRef(params.ref);
      if (ref === null && !params.selector) throw new Error("Provide 'ref' or 'selector'");
      const result = await execInTab(tab.id, pageClickOrFill, [params.selector || null, ref, "click", null]);
      if (result?.error) throw new Error(result.error);
      return { clicked: params.selector || `ref_${ref}` };
    }

    case "fill": {
      const ref = parseRef(params.ref);
      if (ref === null && !params.selector) throw new Error("Provide 'ref' or 'selector'");
      if (params.value === undefined) throw new Error("'value' is required");
      const result = await execInTab(tab.id, pageClickOrFill, [params.selector || null, ref, "fill", params.value]);
      if (result?.error) throw new Error(result.error);
      return { filled: params.selector || `ref_${ref}` };
    }

    case "screenshot": {
      if (!tab.active) {
        await chrome.tabs.update(tab.id, { active: true });
        await new Promise(r => setTimeout(r, 300));
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return { tab_id: tab.id, url: tab.url, dataUrl };
    }

    case "navigate": {
      await chrome.tabs.update(tab.id, { url: params.url });
      return { tab_id: tab.id, navigating_to: params.url };
    }

    default:
      throw new Error("Unknown method: " + msg.method);
  }
}

ensureConnected();
