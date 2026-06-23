# Claude Browser Bridge — Complete Feature & Implementation Reference

**Branch**: `version-1.0.0`
**Total Tools**: 75
**Codebase**: 5,350 lines across 4 core files

---

## Release Notes

### v6.0.1 (2026-06-23) — Bug Fix Release

**Fixed**: Reload affecting all tabs instead of just target tab
- Added strict validation: `typeof tab.id !== 'number'` check before reload
- Added debug logging: Console logs show which tab is being reloaded
- Enhanced response: Returns tab URL for verification
- Better error messages: Clear error if tab resolution fails
- **Files modified**: `extension/background.js:1267-1276`
- **Testing**: See `RELOAD-FIX.md` and `test-reload.md`

---

## Architecture

```
Claude Code ──stdio──► MCP Server (server/index.js, 2350 lines)
                            ▲
                            │ WebSocket (ws://localhost:8787)
                            ▼
                    Chrome Extension (MV3)
                    ├── background.js (2851 lines) — service worker, all tool handlers
                    ├── inject.js (135 lines) — content script, console/network recording
                    ├── popup.js — connection status UI
                    └── manifest.json — permissions, content script config
```

---

## Part 1: Core Infrastructure

### 1.1 CDP Session Manager
**File**: `extension/background.js` lines 95–170
**What**: Persistent Chrome DevTools Protocol sessions per tab with automatic queuing.
**How**: `withCDP(tabId, fn)` queues all CDP operations per tab through a single debugger session. Auto-attaches on first use, auto-detaches after 30 seconds of idle.
**Why**: Eliminates the old attach→command→detach pattern (28 cycles removed). Fixes batch debugger conflicts entirely.
**Test**:
```
batch([performance_trace, get_accessibility_tree, screenshot])
→ All three should succeed (previously the 2nd/3rd would fail with "Another debugger attached")
```

### 1.2 Deterministic Token Auth
**File**: `server/index.js` lines 27–63
**What**: Auth token derived from `sha256(username@hostname:port)` — same token every time on the same machine.
**How**: Falls back to file-based token for backwards compatibility, auto-generates canonical token on first run.
**Test**:
```
# Kill server, delete token file, restart — should still authenticate
rm ~/.claude/browser-bridge-token
# Server auto-regenerates the same deterministic token
```

### 1.3 MV3 Service Worker Keepalive
**File**: `extension/background.js` lines 59–83
**What**: Three-layer keepalive to prevent Chrome from killing the service worker.
**How**: WebSocket pings every 20s + chrome.alarms every 20s + tab activation listeners.
**Test**:
```
# Leave Claude idle for 5 minutes, then call diagnose
# Worker should still be alive and respond
diagnose → should return snapshot without reconnection delay
```

### 1.4 Multi-Session Relay
**File**: `server/index.js` lines 66–100
**What**: Multiple Claude Code sessions can share one bridge. First session "owns" the WebSocket port; subsequent sessions relay through it.
**How**: On startup, tries to bind port. If EADDRINUSE, connects to the owner as a relay client. If owner exits, a relay takes over.
**Test**:
```
# Open two Claude Code sessions, both should be able to use bridge tools
# Kill the first session — second should continue working
```

---

## Part 2: Interaction Tools (CDP-Based, isTrusted)

### 2.1 click
**File**: `extension/background.js` — `actOnElement()` + `cdpClick()`
**What**: Click via CDP `Input.dispatchMouseEvent` (isTrusted:true). Full mouse sequence: mouseMoved → mousePressed → mouseReleased.
**How**: Gets element center coordinates via `getElementCenter()`, scrolls into view, dispatches CDP events. Includes post-click DOM stability wait (MutationObserver, 80ms quiet / 500ms cap).
**Features**:
- Auto-waits up to `wait_ms` (default 5s) for element to appear
- Actionability checks: display, visibility, opacity, disabled state
- Cursor mode: animated pointer with click ripple effect
- Observe mode: auto-screenshot in response
- **Post-click stability wait**: waits for DOM to settle before returning
**Test**:
```
# Basic click
diagnose → click({ref: "ref_0"})
→ Should click, wait for DOM changes, return element rect

# Dropdown click (the GitHub test that previously failed)
# 1. Click a button that opens a dropdown
click({ref: "ref_X"})  // the dropdown trigger
# 2. Take snapshot — dropdown items should now appear as refs
snapshot → should include [role="menu"] items from the portal
```

### 2.2 fill
**File**: `extension/background.js` — `actOnElement()` + `cdpClick()` + `cdpType()`
**What**: Focus element via CDP click, select-all (Ctrl+A), then type character by character via CDP `Input.dispatchKeyEvent`.
**How**: CDP click to focus → CDP Ctrl+A to select existing text → CDP type each character (keyDown + keyUp for ASCII, insertText for unicode/emoji).
**Test**:
```
# Fill a search box
fill({ref: "ref_3", value: "test query"})
→ Should clear existing text and type new value with isTrusted events

# Fill on CSP-strict site (GitHub search)
# Navigate to GitHub → diagnose → fill the search ref
→ Should work (CDP events bypass CSP)

# Unicode/emoji
fill({ref: "ref_X", value: "hello 🌍"})
→ Should type emoji correctly via insertText
```

### 2.3 hover
**File**: `extension/background.js` — `cdpHover()`
**What**: CDP `Input.dispatchMouseEvent` with type "mouseMoved" (isTrusted:true).
**How**: Gets element center, scrolls into view, dispatches mouseMoved at coordinates.
**Test**:
```
hover({ref: "ref_X"})
→ Should trigger tooltip/dropdown appearance
→ screenshot after hover should show the hover state
```

### 2.4 press_key (CDP-upgraded)
**File**: `extension/background.js` — `press_key` case
**What**: Keyboard events via CDP `Input.dispatchKeyEvent` (isTrusted:true). Falls back to DOM KeyboardEvent if CDP unavailable.
**How**: Maps key names to virtual key codes, calculates modifier bits, dispatches rawKeyDown + keyUp.
**Supported keys**: Enter, Tab, Escape, Backspace, Delete, Space, Arrow keys, Home/End, Page Up/Down, F1-F12, all printable characters.
**Modifiers**: Control, Shift, Alt, Meta (any combination).
**Test**:
```
# Close a modal
press_key({key: "Escape"})
→ isTrusted:true, should dismiss dialogs that ignore synthetic events

# Submit a form
fill({ref: "ref_X", value: "search term"})
press_key({key: "Enter"})
→ Should submit the form

# Keyboard shortcut
press_key({key: "a", modifiers: ["Control"]})
→ Should select all text

# Tab navigation
press_key({key: "Tab"})
→ Should move focus to next element
```

### 2.5 scroll
**File**: `extension/background.js` — `scroll` case
**What**: Smooth scrolling via DOM `scrollBy()`. Supports window or specific container scrolling.
**Directions**: up, down, left, right. Default amount: 400px.
**Test**:
```
# Scroll page down
scroll({direction: "down", amount: 800})
→ screenshot should show scrolled content

# Scroll specific container
scroll({selector: ".sidebar", direction: "down", amount: 200})
→ Should scroll only the sidebar

# Scroll via ref
scroll({ref: "ref_X", direction: "up"})
→ Should scroll the container that ref_X is in
```

### 2.6 select_option
**File**: `extension/background.js` — `select_option` case
**What**: Select options in `<select>` dropdowns by value or visible text.
**Test**:
```
select_option({ref: "ref_X", values: ["Option 2"]})
→ Should select by text content

select_option({selector: "#country", values: ["US", "UK"]})
→ Should multi-select by value
```

### 2.7 upload_file
**File**: `extension/background.js` — `upload_file` case
**What**: CDP `DOM.setFileInputFiles` to programmatically set file input values.
**Test**:
```
upload_file({ref: "ref_X", file_path: "/path/to/image.png"})
→ Should set the file on the input element
```

---

## Part 3: Snapshot & Element Discovery

### 3.1 snapshot (Portal + Shadow DOM aware)
**File**: `extension/background.js` — `pageSnapshot()`
**What**: Scans ALL interactive elements including React portals, open shadow DOM, and overlay containers. Returns ref-tagged list for click/fill.
**3-Phase scan**:
1. Standard `querySelectorAll` for links, buttons, inputs, ARIA roles
2. Portal/overlay containers: `[role="dialog"]`, `[role="listbox"]`, `[role="menu"]`, `[data-radix-popper-content-wrapper]`, `[data-floating-ui-portal]`, `.MuiPopover-root`, `dialog[open]`, `[popover]`, GitHub Primer classes
3. Open shadow root traversal (recursive, depth-limited to 3)
**Element info**: tag, role, accessible name, disabled/checked state, value, href.
**Test**:
```
# Basic snapshot
snapshot → should list all interactive elements with refs

# After clicking a dropdown trigger:
click({ref: "ref_X"})  // opens dropdown
snapshot → should include dropdown menu items from portal containers

# On YouTube (shadow DOM):
snapshot → should include elements inside Polymer shadow roots

# On GitHub (strict CSP):
snapshot → should work (doesn't use eval)
```

### 3.2 diagnose (All-in-one)
**File**: `extension/background.js` — `diagnose` case
**What**: Returns snapshot + console errors + failed network + API responses + CAPTCHA detection + CSP detection + cross-origin iframe warnings + localStorage keys in ONE call.
**Fields**:
- `snapshot`: ref-tagged interactive elements
- `consoleErrors`: last 15 errors with stack traces
- `failedRequests`: last 15 4xx/5xx responses with bodies
- `recentAPICalls`: last 20 successful API responses (preview)
- `hasCaptcha`: boolean (reCAPTCHA, hCaptcha, Cloudflare Turnstile)
- `cspBlocksEval`: boolean (true if page CSP blocks eval — informational only, eval now bypasses via CDP)
- `crossOriginIframes`: array of cross-origin iframe URLs
- `localStorage_keys`: first 30 keys
**Test**:
```
diagnose → verify all fields are present and populated
```

### 3.3 wait_for (MutationObserver-based)
**File**: `extension/background.js` — `pageWaitFor()`
**What**: Waits for a CSS selector and/or text to appear. Uses MutationObserver for instant detection.
**How**: Checks immediately (resolves in 0ms if already present). Sets up MutationObserver on document.body with childList + subtree + characterData + attributes. Timeout with max 15s.
**Test**:
```
# Text already present — should resolve instantly
wait_for({text: "something on page"})
→ waitedMs should be 0

# After navigation — wait for content
navigate({url: "..."})
wait_for({selector: "main", text: "Expected content"})
→ Should resolve as soon as content appears (not on 150ms poll cycle)

# Timeout
wait_for({text: "nonexistent", timeout_ms: 2000})
→ Should timeout after exactly 2000ms
```

---

## Part 4: Screenshot & Visual Tools

### 4.1 screenshot (Background tab — no focus stealing)
**File**: `extension/background.js` — `screenshot` case
**What**: PNG screenshot using CDP `Page.captureScreenshot`. Works on BACKGROUND tabs without switching focus.
**How**: Tries CDP first (no tab activation needed). Falls back to `captureVisibleTab` only if CDP fails.
**Test**:
```
# Open a tab, pin it, then switch to another tab manually
select_tab({tab_id: X})
# Switch to a different tab in Chrome manually
screenshot
→ Should capture the pinned tab WITHOUT switching you back to it
→ User's active tab should not change
```

### 4.2 full_page_screenshot
**What**: Captures the entire scrollable page, not just the viewport.
**Note**: Still uses `captureVisibleTab` (requires active tab) because CDP screenshot only captures the viewport.
**Test**:
```
full_page_screenshot → should return a tall image showing the full scrollable content
```

### 4.3 visual_diff
**What**: Compares a "before" screenshot with current state. Returns diff percentage and highlighted image.
**Test**:
```
screenshot → save dataUrl
# Make a CSS change
visual_diff({before_dataUrl: "data:image/png;base64,..."})
→ Returns diff% and red-highlighted image showing changes
```

### 4.4 inject_css
**What**: Inject CSS directly into the live page. Instant visual feedback for CSS fixes.
**Test**:
```
inject_css({css: "body { background: red !important; }"})
→ screenshot → page should have red background
inject_css({css: null, id: "__claude_inject_css__"})
→ Removes the injection
```

### 4.5 annotate / clear_annotations
**What**: Draw persistent colored borders and labels on elements.
**Test**:
```
annotate({annotations: [
  {selector: "header", label: "Header", color: "red"},
  {selector: "main", label: "Main", color: "blue"}
]})
→ screenshot → elements should have colored borders with labels
clear_annotations → removes them
```

### 4.6 inspect_pixel
**What**: Sample RGBA color at specific pixel coordinates on any element. Bypasses CORS.
**Test**:
```
inspect_pixel({selector: "img", x: 50, y: 50, percent: true})
→ Returns hex color, opacity, bounding box
```

### 4.7 capture_canvas
**What**: Flatten stacked child images inside a container into a single composited PNG.

### 4.8 compare_tabs
**What**: Screenshot two tabs side by side and compute pixel diff.

---

## Part 5: Debugging & Inspection

### 5.1 eval (CDP-first, bypasses CSP)
**File**: `extension/background.js` — `eval` case
**What**: Execute JavaScript in the page context. Uses CDP `Runtime.evaluate` as primary (bypasses all CSP). Falls back to `window.eval()` in MAIN world if CDP unavailable.
**Test**:
```
# On GitHub (CSP-strict):
eval({code: "document.title"})
→ Should return "GitHub" (previously returned CSP error)

# Complex object return:
eval({code: "JSON.stringify({a:1, b:[2,3]})"})
→ Should return the JSON string

# On example.com (no CSP):
eval({code: "1 + 1"})
→ Should return "2" (uses CDP primary, same result)

# Error handling:
eval({code: "throw new Error('test')"})
→ Should return "Error: test"
```

### 5.2 get_console
**What**: Console messages, uncaught errors with stack traces, unhandled rejections. Recorded continuously since page load via content script wrappers.
**Test**:
```
get_console → should include any logged messages/errors
get_console({clear: true}) → clears buffer, returns current logs
```

### 5.3 get_grouped_console
**What**: Console messages grouped by frequency. "27x: Font resolve mismatch" instead of 27 individual entries.

### 5.4 get_network
**What**: fetch/XHR requests with method, URL, status, duration. Response bodies for failed requests.
**Test**:
```
get_network → all requests
get_network({url_contains: "/api/"}) → filtered by URL
get_network({only_failures: true}) → only 4xx/5xx/errors
get_network({clear: true}) → reset buffer
```

### 5.5 search_network_bodies
**What**: Search across ALL recorded request/response bodies for a string.
**Test**:
```
search_network_bodies({query: "error"}) → find which API returned error messages
search_network_bodies({query: "token"}) → find where tokens appear
```

### 5.6 get_html
**What**: outerHTML of an element by CSS selector, or whole document.
**Test**:
```
get_html({selector: "nav"}) → HTML of the nav element
get_html → entire document HTML (capped at 100KB)
```

### 5.7 get_styles
**What**: Computed CSS styles for any element. Returns box model, typography, colors, layout properties.
**Test**:
```
get_styles({selector: "h1"}) → font-family, font-size, color, margin, etc.
get_styles({ref: "ref_5"}) → styles for a snapshot ref
```

### 5.8 get_element_rect
**What**: Exact viewport position, size, z-index, visibility, opacity. With `include_children: true`, returns all child element positions.
**Test**:
```
get_element_rect({selector: ".container", include_children: true})
→ Every child's x, y, width, height, z-index
```

### 5.9 get_cookies / edit_cookie
**What**: Read all cookies (including HttpOnly via extension API). Edit or delete cookies.
**Test**:
```
get_cookies → all cookies with flags (HttpOnly, Secure, SameSite)
edit_cookie({name: "test", value: "123"}) → set a cookie
edit_cookie({name: "test", delete: true}) → remove it
```

### 5.10 get_storage / set_storage
**What**: Read/write localStorage and sessionStorage.
**Test**:
```
get_storage → all localStorage keys/values
get_storage({storage_type: "session"}) → sessionStorage
set_storage({key: "test", value: "hello"}) → write
set_storage({key: "test", action: "remove"}) → delete
set_storage({action: "clear"}) → clear all
```

### 5.11 watch_dom_changes
**What**: Record DOM mutations for a duration. Shows added/removed nodes, attribute changes.

### 5.12 generate_selector
**What**: Generate multiple stable CSS selectors for an element (by id, data-testid, aria-label, path, text).

### 5.13 get_clipboard
**What**: Read current clipboard text content.

---

## Part 6: Performance & Accessibility

### 6.1 performance_trace
**What**: Core Web Vitals (LCP, FCP, CLS) + CDP Performance metrics + resource count + long task count.
**Test**:
```
performance_trace
→ webVitals: { domContentLoaded, loadComplete, firstPaint, FCP, LCP, CLS, longTaskCount }
→ cdpMetrics: { Timestamp, Documents, Frames, JSEventListeners, Nodes, JSHeapUsedSize, ... }
```

### 6.2 get_load_timeline
**What**: Full page load timeline with DNS, TCP, request, response, DOM processing phases + resource waterfall.

### 6.3 heap_snapshot_summary
**What**: JS heap memory usage (used/total/limit MB) and DOM node count.
**Test**:
```
heap_snapshot_summary → { memory: { usedMB, totalMB, limitMB }, dom: { domNodes } }
# Interact with page, call again → check for memory growth
```

### 6.4 get_accessibility_tree
**What**: Full accessibility tree from Chrome — ARIA roles, names, states.
**Test**:
```
get_accessibility_tree({max_depth: 4, max_nodes: 100})
→ Hierarchical tree: { role, name, description, properties }
```

### 6.5 check_contrast (Parent-chain aware)
**What**: WCAG color contrast ratio with AA/AAA pass/fail. Now walks up parent chain when element has transparent background.
**Test**:
```
check_contrast({selector: "h1"})
→ { fg, bg, ratio, wcag_AA, wcag_AAA }
→ If element has transparent bg, bg_source: "inherited from parent"
```

---

## Part 7: Navigation & Tab Management

### 7.1 navigate / go_back / go_forward / reload
### 7.2 new_tab / close_tab
**Note**: `new_tab` does NOT auto-mark the new tab. Subsequent tools target the original pinned tab.
### 7.3 list_tabs
### 7.4 select_tab
**What**: Pin a tab as sticky target + visual marker (orange border, "Claude Code" badge, robot emoji in title).
### 7.5 detach_debugger (NEW)
**What**: Explicitly release the CDP session and remove the yellow "being debugged" bar.
**Test**:
```
# After using CDP tools (eval, screenshot, click), the yellow bar appears
detach_debugger
→ Yellow bar should disappear immediately
→ { detached: tabId, note: "Debugger detached — yellow bar removed." }
```

---

## Part 8: Emulation & Testing

### 8.1 emulate_device
**What**: Viewport emulation — mobile (iPhone 375x812), tablet (iPad 768x1024), desktop (1440x900), or custom.
### 8.2 network_throttle
**What**: Slow 3G, Fast 3G, 4G, Offline, or disable.
### 8.3 set_geolocation
### 8.4 toggle_dark_mode
### 8.5 mock_network
**What**: Intercept network requests and return custom responses. For testing error/empty states.
**Test**:
```
mock_network({url_pattern: "/api/data", status_code: 500, response_body: '{"error":"fail"}'})
reload → screenshot → verify error state UI
```
### 8.6 record_actions / replay_actions
### 8.7 handle_dialog

---

## Part 9: Video Tools

### 9.1 video_get_captions / video_get_chapters
### 9.2 video_control (play, pause, seek, speed)
### 9.3 video_capture_frame
### 9.4 video_listen (speech recognition fallback)
### 9.5 video_smart_read (captions → speech fallback)

---

## Part 10: Productivity Tools

### 10.1 save_form_profile / load_form_profile
### 10.2 save_tab_session / restore_tab_session
### 10.3 export_pdf
### 10.4 highlight_element
### 10.5 observe_mode / cursor_mode

---

## Part 11: Knowledge System (Self-Contained)

### 11.1 browser_bridge_help
**What**: Quick-start guide with workflows, Chrome edge cases, and anti-patterns. Available on any device.

### 11.2 bridge_knowledge (11 deep expertise modules)
**What**: Deep methodology by topic. Any Claude session gets full browser expertise on connect.
**Topics**:
| Topic | What It Teaches |
|-------|----------------|
| `full_site_audit` | 8-phase multi-angle sweep: visual → structural → functional → network → performance → security → state |
| `security` | 6 approaches: cookies, XSS, auth bypass, data exposure, CORS, transport |
| `performance` | 6 layers: load metrics, waterfall, runtime, memory, network, simulated |
| `design_validation` | Figma comparison, CSS validation, responsive, typography/color audit |
| `api_testing` | Health, security, contract validation, performance profiling |
| `chrome_internals` | Process architecture, rendering pipeline, CSP levels, navigation lifecycle |
| `element_inspection` | DOM, CSS, z-index, shadow DOM, iframes, mutations |
| `state_debugging` | 7 storage layers, React/Vue/Angular state, clean slate isolation |
| `network_debugging` | CORS, caching, service workers, WebSocket |
| `proactive_patterns` | 6 automated sweeps: broken resources, a11y, security, perf, functional, multi-page |

**Test**:
```
bridge_knowledge({topic: "security"})
→ Should return complete security testing methodology

bridge_knowledge({topic: "full_site_audit"})
→ Should return the 8-phase audit procedure
```

---

## Part 12: Chrome Edge Case Handling

### 12.1 CSP/Trusted Types — RESOLVED
**Before**: eval blocked on GitHub, YouTube, MDN, CodePen.
**After**: CDP `Runtime.evaluate` bypasses all CSP. Transparent fallback.

### 12.2 chrome:// Pages — Detected Early
Protected pages detected immediately with clear error message. No wasted tool calls.

### 12.3 Debugger Conflicts — RESOLVED
**Before**: Two CDP tools in batch() would crash.
**After**: Persistent session with automatic queuing. All tools batchable.

### 12.4 Tab Focus Stealing — RESOLVED
**Before**: screenshot/autoCapture forced tab active, disrupting user.
**After**: CDP Page.captureScreenshot works on background tabs.

### 12.5 Portal/Shadow DOM — RESOLVED
**Before**: React portals, overlays, shadow DOM elements invisible to snapshot.
**After**: 3-phase scan: standard → portal containers → shadow roots.

### 12.6 Post-Action Staleness — RESOLVED
**Before**: Snapshot stale after click, needed manual re-snapshot.
**After**: MutationObserver stability wait after every click.

### 12.7 isTrusted Events — RESOLVED
**Before**: press_key dispatched JS events (isTrusted:false), ignored by frameworks.
**After**: CDP Input.dispatchKeyEvent (isTrusted:true).

### 12.8 wait_for Polling Delay — RESOLVED
**Before**: 150ms polling interval, missed fast changes.
**After**: MutationObserver for instant detection, 0ms if already present.

### 12.9 Cross-Origin Iframes — IMPROVED
Content script now injects into all frames (allFrames:true with fallback).

### 12.10 Transparent Background Contrast — RESOLVED
check_contrast walks up parent chain, reports inherited background.

---

## Testing Checklist

### Core Interaction Tests
- [ ] `click` on a standard button → verify it fires
- [ ] `click` on a dropdown trigger → `snapshot` shows dropdown items
- [ ] `fill` a text input → verify value changed
- [ ] `fill` on GitHub search (CSP-strict) → should work
- [ ] `hover` on an element with tooltip → screenshot shows tooltip
- [ ] `press_key({key: "Escape"})` → dismisses modal
- [ ] `press_key({key: "Enter"})` → submits form
- [ ] `press_key({key: "Tab"})` → moves focus
- [ ] `scroll({direction: "down"})` → page scrolls

### CDP Session Tests
- [ ] `batch([screenshot, performance_trace, get_accessibility_tree])` → all succeed
- [ ] Multiple rapid CDP calls → no attach/detach overhead
- [ ] `detach_debugger` → yellow bar disappears
- [ ] Leave idle 35s → debugger auto-detaches

### CSP Bypass Tests
- [ ] `eval` on GitHub.com → returns result (not CSP error)
- [ ] `eval` on YouTube.com → returns result (not Trusted Types error)
- [ ] `eval` on example.com → returns result (direct eval, no CDP needed)
- [ ] `eval` with complex expression → returns JSON

### No-Focus-Stealing Tests
- [ ] `screenshot` while on a different tab → captures correct tab, doesn't switch
- [ ] `click` + observe_mode → screenshot captured without tab switch
- [ ] Multiple tool calls → user's active tab stays unchanged

### Portal/Shadow DOM Tests
- [ ] GitHub dropdown → snapshot captures portal items
- [ ] YouTube player controls → snapshot captures shadow DOM buttons
- [ ] Material UI dialog → snapshot captures dialog buttons
- [ ] After closing overlay → old portal refs don't appear

### Knowledge System Tests
- [ ] `browser_bridge_help` → returns quick-start guide
- [ ] `bridge_knowledge({topic: "security"})` → returns security methodology
- [ ] `bridge_knowledge({topic: "full_site_audit"})` → returns 8-phase audit
- [ ] `bridge_knowledge({topic: "invalid"})` → lists available topics

### Edge Case Tests
- [ ] Navigate to `chrome://extensions` → clear error message (not cryptic failure)
- [ ] `check_contrast` on element with transparent bg → walks parent chain
- [ ] `wait_for({text: "already here"})` → resolves in 0ms
- [ ] `wait_for({text: "nonexistent", timeout_ms: 2000})` → times out at exactly 2000ms
- [ ] Open 3 tabs → `list_tabs` → all visible with correct titles/URLs
- [ ] `diagnose` → includes cspBlocksEval and crossOriginIframes fields

### Regression Tests
- [ ] `diagnose` on a simple page → all fields populated
- [ ] `get_html`, `get_styles`, `get_page_text` → work on all sites
- [ ] `get_console`, `get_network` → recording since page load
- [ ] `inject_css` → CSS applied, `screenshot` shows change
- [ ] `visual_diff` → returns diff percentage and image
- [ ] `mock_network` → intercepts and returns custom response
