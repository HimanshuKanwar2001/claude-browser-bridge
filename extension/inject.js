// Runs in the page's MAIN world at document_start.
// Records console output, JS errors, and fetch/XHR activity into capped
// in-page buffers that background.js reads on demand. Also holds the
// element refs handed out by the snapshot tool.
(() => {
  if (window.__claudeBridge) return;

  const MAX_ENTRIES = 500;
  const bridge = (window.__claudeBridge = { logs: [], requests: [], refs: [] });

  const push = (arr, entry) => {
    arr.push(entry);
    if (arr.length > MAX_ENTRIES) arr.splice(0, arr.length - MAX_ENTRIES);
  };

  const serialize = (value) => {
    try {
      if (value instanceof Error) return value.stack || String(value);
      if (typeof value === "object" && value !== null) {
        return JSON.stringify(value, null, 0)?.slice(0, 2000);
      }
      return String(value).slice(0, 2000);
    } catch {
      return "[unserializable]";
    }
  };

  const REDACT = /^(authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|proxy-authorization)$/i;
  const redactHeaders = (headers) => {
    try {
      if (!headers) return undefined;
      const entries =
        typeof headers.entries === "function"
          ? [...headers.entries()]
          : Array.isArray(headers)
            ? headers
            : Object.entries(headers);
      const out = {};
      for (const [k, v] of entries) {
        out[k] = REDACT.test(k) ? "[redacted]" : String(v).slice(0, 200);
      }
      return Object.keys(out).length ? out : undefined;
    } catch {
      return undefined;
    }
  };

  // --- console ---
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      push(bridge.logs, {
        level,
        time: Date.now(),
        args: args.map(serialize),
      });
      original(...args);
    };
  }

  // --- uncaught errors / rejections (with stacks) ---
  window.addEventListener("error", (e) => {
    const args = [`${e.message} (${e.filename}:${e.lineno}:${e.colno})`];
    if (e.error?.stack) args.push(e.error.stack.slice(0, 3000));
    push(bridge.logs, { level: "uncaught", time: Date.now(), args });
  });
  window.addEventListener("unhandledrejection", (e) => {
    push(bridge.logs, {
      level: "unhandledrejection",
      time: Date.now(),
      args: [e.reason?.stack ? e.reason.stack.slice(0, 3000) : serialize(e.reason)],
    });
  });

  // --- fetch ---
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const started = Date.now();
    const req = args[0];
    const init = args[1];
    const url = typeof req === "string" ? req : req?.url;
    const method = (init?.method || req?.method || "GET").toUpperCase();
    const entry = { kind: "fetch", method, url, time: started };
    entry.requestHeaders = redactHeaders(init?.headers || (req instanceof Request ? req.headers : undefined));
    if (typeof init?.body === "string") entry.requestBody = init.body.slice(0, 1000);
    try {
      const res = await originalFetch(...args);
      entry.status = res.status;
      entry.contentType = res.headers.get("content-type") || undefined;
      entry.durationMs = Date.now() - started;
      const isJson = (entry.contentType || "").includes("json");
      if (res.status >= 400 || isJson) {
        res.clone().text().then(
          (t) => { entry.responseBody = t.slice(0, 4000); },
          () => {}
        );
      }
      push(bridge.requests, entry);
      return res;
    } catch (err) {
      entry.error = String(err);
      entry.durationMs = Date.now() - started;
      push(bridge.requests, entry);
      throw err;
    }
  };

  // --- XHR ---
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__claudeBridge = { kind: "xhr", method: String(method).toUpperCase(), url: String(url) };
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const entry = this.__claudeBridge;
    if (entry) {
      entry.time = Date.now();
      if (typeof args[0] === "string") entry.requestBody = args[0].slice(0, 1000);
      this.addEventListener("loadend", () => {
        entry.status = this.status;
        entry.durationMs = Date.now() - entry.time;
        try {
          entry.contentType = this.getResponseHeader("content-type") || undefined;
          const xhrIsJson = (entry.contentType || "").includes("json");
          if ((this.status >= 400 || xhrIsJson) && (this.responseType === "" || this.responseType === "text")) {
            entry.responseBody = this.responseText.slice(0, 4000);
          }
        } catch {}
        push(bridge.requests, entry);
      });
    }
    return originalSend.apply(this, args);
  };
})();
