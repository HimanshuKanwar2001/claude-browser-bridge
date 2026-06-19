# Chrome Internals Knowledge Base

Deep technical reference for building and improving the Claude Browser Bridge extension.
Built from live testing + research across Chrome 149.

---

## 1. Chrome Multi-Process Architecture

### Process Types
| Process | Role | Count |
|---------|------|-------|
| **Browser** | UI, tab management, network, storage, IPC hub | 1 |
| **Renderer** | Blink + V8 per site-instance, runs page JS and DOM | 1 per site-instance |
| **GPU** | Compositing, WebGL, video decode | 1 |
| **Network** (Network Service) | All HTTP/DNS, runs in browser or utility process | 1 |
| **Utility** | Audio, video, data decoding | as needed |
| **Extension** | Each extension gets its own renderer process | 1 per extension |

### Site Isolation
- Chrome uses **process-per-site-instance**: each (site, BrowsingInstance) pair gets its own renderer process
- Cross-site iframes run in **separate processes** (out-of-process iframes / OOPIFs)
- This means our content script injected into the main frame does NOT run in iframe processes
- **Impact on bridge**: `eval` can only reach the main frame's JS context, not cross-origin iframe contexts

### IPC: Mojo
- All inter-process communication uses **Mojo** (replaced old IPC::Channel)
- Mojo interfaces are defined in `.mojom` files, compiled to C++ bindings
- Extension API calls from background service worker → browser process → renderer process

### Process Crash Recovery
- If a renderer crashes, Chrome shows "Aw, Snap!" — our content script is lost
- The background service worker survives renderer crashes (separate process)
- On tab reload after crash, content script re-injects automatically via manifest

---

## 2. Rendering Pipeline

### Blink Pipeline: DOM → Style → Layout → Paint → Composite
1. **DOM Parse**: HTML → DOM tree
2. **Style Resolve**: CSS → computed styles per element (what `get_styles` reads)
3. **Layout**: Box tree, positions, sizes (what `get_element_rect` reads)
4. **Paint**: Draw commands for each layer
5. **Composite**: GPU combines layers → pixels on screen (what `screenshot` captures)

### V8 JavaScript Engine
- **Parsing**: Source → AST
- **Ignition**: AST → bytecode (interpreted)
- **TurboFan**: Hot bytecode → optimized machine code (JIT)
- **Garbage Collection**: Generational (young gen + old gen), incremental marking
- **Impact**: Our `eval` executes in the V8 context of the MAIN world. Chrome.scripting.executeScript creates a new script execution context.

### Main Thread vs Compositor Thread
- **Main thread**: JS execution, DOM, style, layout, paint record
- **Compositor thread**: Scrolling, CSS transforms/opacity animations, rasterization
- **Impact**: Our `scroll` tool triggers compositor-thread work. Heavy `eval` calls block the main thread.

---

## 3. Navigation & Page Lifecycle

### Navigation Flow
```
User/click → Browser Process (URL resolution) → Network Process (DNS/TLS/HTTP)
→ Response headers → Security checks → Renderer assignment
→ Document creation → HTML parsing → Subresource loading → DOMContentLoaded → Load
```

### Back-Forward Cache (bfcache)
**Tested behavior**:
- Pages can be frozen in memory and restored instantly on back/forward navigation
- `performance.getEntriesByType('navigation')[0].type` = `"back_forward"` when restored
- **JS state SURVIVES bfcache** (window properties, timers, event listeners persist)
- Our `__claudeBridge` object survives bfcache restoration
- **Disqualifiers** (things that prevent bfcache):
  - `beforeunload` / `unload` event listeners
  - Active WebSocket connections
  - Active `SharedWorker`
  - `Cache-Control: no-store`
  - Active `BroadcastChannel` with listeners
- **Impact on bridge**: Our content script state persists through bfcache. The bridge re-initializes correctly on fresh navigations.

### Tab Discarding
- Chrome discards background tabs under memory pressure
- Discarded tabs lose their renderer process entirely
- On re-focus, the tab reloads from scratch
- **Impact**: Our injected content script is destroyed. On reload, it re-injects via manifest `content_scripts`.

### Tab Freezing
- Background tabs have timers throttled (setTimeout minimum 1s)
- `requestAnimationFrame` paused in background tabs
- Fetch/XHR still run but may be deprioritized
- **Impact**: Our console/network buffers keep recording, but timer-based operations slow down

---

## 4. Content Security Policy (CSP) — Critical for Our Bridge

### Live Test Results — CSP Compatibility Matrix

| Site | CSP Level | `eval` | `snapshot` | `click/fill` | `screenshot` | `get_html` | `get_styles` | `get_console` | `get_network` |
|------|-----------|--------|------------|---------------|--------------|------------|--------------|---------------|---------------|
| example.com | None | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| httpbin.org | None | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| wikipedia.org | Permissive | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **github.com** | `script-src` strict | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **youtube.com** | Trusted Types | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **developer.mozilla.org** | `script-src` strict | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **codepen.io** | `script-src` strict | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| chrome:// pages | Extension blocked | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

### Why `eval` Fails on Strict CSP Sites
- Our `eval` tool uses `chrome.scripting.executeScript` with `world: "MAIN"`
- This injects a script that calls `eval()` or `new Function()` to run user-provided code
- Pages with `script-src` that excludes `'unsafe-eval'` block this at the V8 level
- The **EvalError** is thrown by the JS engine, not by our extension

### CSP Bypass: What DOES Work
- `chrome.scripting.executeScript` with a **function reference** (not string eval) works
- `snapshot`, `click`, `fill` use function references → work everywhere
- `get_html`, `get_styles` use `document.querySelector` via function refs → work everywhere
- `get_console`, `get_network` read from pre-injected `__claudeBridge` object → work everywhere

### Trusted Types (YouTube, etc.)
- A stricter policy than CSP `script-src`
- Blocks `eval()`, `innerHTML` assignments, `document.write()` with untrusted strings
- Same impact as CSP eval restriction for our `eval` tool
- **Growing adoption**: Google properties, modern SPAs

### Improvement Opportunity: CSP-Resistant Eval
The `eval` tool could be reimplemented to use `chrome.scripting.executeScript` with a pre-compiled function instead of string evaluation. This would require a different approach:
1. Parse the user's code server-side
2. Send it as a serializable function + arguments
3. Execute via `func` parameter of `executeScript`
4. Or use CDP `Runtime.evaluate` which bypasses page CSP entirely

---

## 5. Chrome Extension Architecture — MV3

### Service Worker Lifecycle (CRITICAL)
- MV3 replaced persistent background pages with **event-driven service workers**
- Chrome WILL terminate the worker after **30 seconds of inactivity**
- Maximum single execution time: **5 minutes**
- **What keeps the worker alive**:
  - Active WebSocket connection (BUT Chrome may still kill it after 5min)
  - Pending `chrome.*` API calls
  - Active message ports
  - `chrome.alarms` wake the worker but don't keep it alive
- **Our keepalive strategy** (3 layers):
  1. WebSocket ping every 20s
  2. `chrome.alarms` every 20s (minimum interval ~30s actual)
  3. Tab activation listeners

### Content Script Worlds
| World | Access | CSP | Bridge Objects |
|-------|--------|-----|----------------|
| `MAIN` | Full page JS context (`window`, DOM, page's JS vars) | Subject to page CSP | Can set `window.__claudeBridge` |
| `ISOLATED` | Shared DOM, separate JS context | Extension's CSP (permissive) | Cannot access page's `window` |

- Our `inject.js` runs in `MAIN` world → can wrap `console.*`, `fetch`, `XMLHttpRequest`
- Tools using `chrome.scripting.executeScript` default to `ISOLATED` world
- We explicitly use `world: "MAIN"` for tools that need page context

### Permissions Model
| Permission | What it grants | Our usage |
|------------|---------------|-----------|
| `activeTab` | Script injection + screenshot for the current tab | screenshots, script execution |
| `tabs` | Read tab URLs, titles, status | `list_tabs`, tab management |
| `scripting` | `chrome.scripting.executeScript` | All tool execution |
| `debugger` | CDP access via `chrome.debugger` | screenshots, file upload, a11y tree, perf |
| `storage` | `chrome.storage.*` | Persisting targetTabId |
| `cookies` | Read/write cookies for any URL | `get_cookies`, `edit_cookie` |
| `alarms` | Set recurring alarms | Keepalive heartbeat |
| `host_permissions: <all_urls>` | Content script injection on all sites | Universal bridge injection |

### Pages We CANNOT Access
- `chrome://` pages (settings, extensions, flags, etc.)
- `chrome-extension://` pages of other extensions
- Chrome Web Store pages (`https://chromewebstore.google.com/`)
- `devtools://` pages
- `view-source:` pages

---

## 6. chrome.debugger API (CDP via Extension)

### How It Works
1. `chrome.debugger.attach({tabId}, version)` → attaches to a tab's renderer
2. Shows the yellow **"is being debugged"** info bar (CANNOT be suppressed)
3. `chrome.debugger.sendCommand(target, method, params)` → send CDP commands
4. `chrome.debugger.detach(target)` → releases

### Debugger Conflict Bug (Found in Testing)
- **Only ONE debugger can attach to a tab at a time**
- Running `performance_trace` and `get_accessibility_tree` in the same `batch` call FAILS
- The second tool gets: "Another debugger is already attached"
- **Fix needed**: Queue debugger operations or share a single debugger session

### CDP Domains Available via chrome.debugger
Currently used:
- `Page.captureScreenshot` — screenshot tool
- `DOM.setFileInputFiles` — file upload
- `Accessibility.getFullAXTree` — accessibility tree
- `Performance.getMetrics` — performance metrics
- `Emulation.*` — device emulation, geolocation
- `Network.*` — request interception for mock_network

### CDP Domains We Should Use (Untapped Potential)

| Domain | Capability | Current Alternative | Advantage of CDP |
|--------|-----------|-------------------|------------------|
| `Runtime.evaluate` | Execute JS bypassing CSP | `eval` (blocked by CSP) | **Works on ALL sites** |
| `CSS.getComputedStyleForNode` | Get styles without injection | `get_styles` via scripting | No script execution needed |
| `CSS.getMatchedStylesForNode` | See which CSS rules match | None | Shows cascade, specificity |
| `CSS.forcePseudoState` | Force :hover/:focus/:active | `hover` tool | Persistent, no mouse needed |
| `DOM.getBoxModel` | Element geometry | `get_element_rect` via scripting | No script execution needed |
| `Network.enable` + events | Full request/response capture | Content script fetch wrapper | Captures ALL traffic, not just fetch/XHR |
| `Log.enable` | Native console capture | Content script console wrapper | Captures native logs, no injection needed |
| `Overlay.highlightNode` | Native element highlighting | `highlight_element` via inject_css | Proper DevTools-style highlighting |
| `Profiler.start/stop` | CPU profiling | None | New capability |
| `HeapProfiler.takeHeapSnapshot` | Full heap snapshot | `heap_snapshot_summary` | Much more detailed |
| `Input.dispatchMouseEvent` | Synthetic input events | DOM click/fill | More realistic, works in all frames |
| `ServiceWorker.enable` | Track SW lifecycle | None | New capability |

### Critical Improvement: CDP Runtime.evaluate
**This is the single biggest improvement we can make.**
- `Runtime.evaluate` executes JS in the page context but **bypasses CSP**
- It uses the V8 debugger protocol, not page-level eval
- Works on GitHub, YouTube, MDN — everywhere that currently blocks our `eval`
- Requires debugger attachment (yellow bar), but we already use debugger for other tools

---

## 7. Security Considerations

### Our Attack Surface
1. **WebSocket on localhost:8787** — Anyone on the machine could connect
   - Mitigated by: Token-based auth handshake
   - Risk: Other local processes could brute-force or steal the token
   - Improvement: Use a Unix socket instead of TCP

2. **`window.__claudeBridge` is page-visible** — Malicious pages could:
   - Read our console/network buffers (information disclosure)
   - Overwrite our refs array (tool manipulation)
   - Detect our presence (fingerprinting)
   - Improvement: Use `ISOLATED` world for buffer storage, only expose via messaging

3. **`eval` in MAIN world** — We execute arbitrary JS with full page privileges
   - A compromised MCP server could steal cookies, tokens, form data
   - Mitigated by: Only Claude Code (trusted) sends commands
   - Improvement: Consider sandboxing eval or adding a command allowlist

4. **`host_permissions: <all_urls>`** — Broadest possible permission
   - Allows content script on every page including banking, email
   - Improvement: Use optional permissions or scope to specific domains

### Chrome Extension Security Model
- Extensions run in their own process (separate from page renderers)
- Content scripts in `ISOLATED` world can't access page JS (but share DOM)
- Content scripts in `MAIN` world have full page access (our choice for bridge)
- Background service worker can't directly access page DOM
- All cross-process communication goes through Chrome's message passing

### Cookie Security
- `HttpOnly` cookies: Extensions CAN read them via `chrome.cookies` API (special privilege)
- `SameSite` cookies: Normal browser rules apply to page requests
- Partitioned cookies (CHIPS): `chrome.cookies` sees the partitioned versions
- Our `get_cookies` tool correctly accesses HttpOnly cookies that page JS can't

---

## 8. Edge Cases & Known Limitations

### Tested Edge Cases

| Edge Case | Behavior | Impact |
|-----------|----------|--------|
| **chrome:// pages** | All tools blocked | Cannot debug extension page, settings, etc. |
| **CSP strict sites** | `eval` blocked, all other tools work | GitHub, YouTube, MDN, many modern sites |
| **Trusted Types** | Same as CSP strict for eval | YouTube, Google properties |
| **Shadow DOM (open)** | `eval` can access via `.shadowRoot` | YouTube's Polymer components accessible |
| **Shadow DOM (closed)** | Cannot access via JS | Rare, but some components use this |
| **Cross-origin iframes** | Content script injected separately, can't access from parent eval | Ads, embeds, payment frames |
| **Service workers** | Bridge not injected into SW context | Can't intercept SW fetch events |
| **Tab discarding** | Content script lost, re-injects on reload | Buffer history lost |
| **bfcache restoration** | Bridge state survives | Logs/requests buffers preserved |
| **Concurrent debugger** | Only one attachment per tab | batch calls with 2 debugger tools fail |
| **PDF viewer** | Chrome's built-in viewer, limited scripting | Most tools fail |
| **WebSocket pages** | Our bridge doesn't capture WS frames | Chat apps, real-time data invisible |
| **Web Workers** | Bridge not in worker context | Worker console.log not captured |

### Buffer Limitations
- Console logs: 500-entry circular buffer
- Network requests: 500-entry circular buffer
- Response bodies: Only captured for failed requests (status >= 400), capped at 2KB
- Screenshot: Limited to visible viewport (full_page_screenshot for full page)

---

## 9. Improvement Roadmap (Prioritized)

### P0 — Critical (Would fix broken functionality)
1. **CDP `Runtime.evaluate` for eval tool** — Bypasses CSP on all sites. Single biggest improvement.
2. **Debugger session sharing** — Fix concurrent debugger conflicts in batch calls
3. **Offscreen document for WebSocket** — More reliable keepalive than service worker hacks

### P1 — High Value (New capabilities)
4. **CDP `Network.enable`** — Full traffic capture including response bodies for all requests
5. **CDP `CSS.getMatchedStylesForNode`** — See which CSS rules apply, specificity debugging
6. **CDP `CSS.forcePseudoState`** — Force :hover/:focus states for testing
7. **CDP `Input.dispatchMouseEvent/KeyEvent`** — More realistic input simulation
8. **Cross-origin iframe support** — Use `chrome.scripting.executeScript` with `allFrames: true`

### P2 — Nice to Have
9. **CDP `Profiler`** — CPU profiling
10. **CDP `ServiceWorker`** — Track SW lifecycle
11. **WebSocket frame capture** — Via CDP Network domain
12. **`chrome.webNavigation`** — Better navigation event tracking
13. **`chrome.sidePanel`** — Persistent UI for bridge status
14. **Bridge object protection** — Move to ISOLATED world + message passing
15. **Background page check_contrast fix** — Walk up parent chain for transparent backgrounds

### P3 — Future Exploration
16. **`chrome.offscreen`** — Canvas operations, audio processing
17. **`chrome.userScripts`** — User-defined injection scripts
18. **`chrome.commands`** — Keyboard shortcuts for common operations
19. **`chrome.contextMenus`** — Right-click integration
20. **Declarative Net Request** — Performance-optimized request blocking

---

## 10. Quick Reference: What Works Where

### Tool Execution Methods
| Method | CSP Affected? | Debugger Needed? | Cross-Origin? |
|--------|--------------|------------------|---------------|
| `chrome.scripting.executeScript` (func) | No | No | Per-frame |
| `chrome.scripting.executeScript` (eval in MAIN) | **YES** | No | Per-frame |
| `chrome.debugger` + CDP | No | **YES** (yellow bar) | Per-tab |
| Content script (MAIN world) | YES | No | Per-frame |
| Content script (ISOLATED world) | No | No | Per-frame |

### Chrome Version Requirements
- MV3 Service Workers: Chrome 88+
- `chrome.scripting`: Chrome 88+
- `chrome.debugger` (stable CDP): Chrome 80+
- Trusted Types enforcement: Chrome 83+
- `world: "MAIN"` for executeScript: Chrome 95+
- `chrome.offscreen`: Chrome 109+
- `chrome.sidePanel`: Chrome 114+
- `chrome.userScripts`: Chrome 120+
- bfcache NotRestoredReasons API: Chrome 123+
- Current user: **Chrome 149**
