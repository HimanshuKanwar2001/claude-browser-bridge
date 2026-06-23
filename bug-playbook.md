# Bug Playbook

Patterns from past debugging sessions. Read this BEFORE investigating new bugs — the answer may already be here.

## Pattern: Reload affecting all tabs (FIXED)
**Symptoms:** User reports that calling `reload` refreshes all tabs in Chrome instead of just the target tab.
**Root cause:** Potential edge case where `tab.id` could be undefined or invalid, causing unpredictable Chrome behavior.
**How we found it:** Code review of `chrome.tabs.reload(tab.id, {...})` call — if `tab.id` is falsy, Chrome might reload the wrong tab or all tabs.
**Fix:** Added strict validation `typeof tab.id !== 'number'` before reload. Added debug logging to track which tab is being reloaded. Now returns tab URL in response for verification.
**Testing:** Check extension service worker console (`chrome://extensions/` → "service worker") for logs like `[bridge] reloading tab 12345 (https://example.com)`.
**Date:** 2026-06-23
**Files:** extension/background.js:1267-1276

## Pattern: 404 on local dev server
**Symptoms:** Page shows "Page Not Found", no API calls in network tab.
**Root cause:** Wrong dev server — URL belongs to theme A but dev server is running theme B.
**How we found it:** `get_network` showed zero product/catalog API calls, only auth session 401s. Webpack build warnings referenced the wrong theme's file paths.
**Fix:** Start the correct theme's dev server (`fdk theme serve` or `npm run dev` from the right project directory). Check which project owns the port with `lsof -nP -i :PORT`.

## Pattern: Missing barrel export
**Symptoms:** Webpack warning `export 'X' was not found in 'path'`, function returns undefined at runtime.
**Root cause:** Barrel file (index.jsx) re-exports from subdirectory but omits specific exports.
**How we found it:** `get_console` captured the exact webpack warning with the missing export name and file path.
**Fix:** Add the missing named export to the barrel file. Check if the function exists in the subdirectory's source file first.

## Pattern: Case-sensitive import path
**Symptoms:** Webpack warning about "modules with names that only differ in casing".
**Root cause:** Import path uses `../Drawer` but the actual folder is `../drawer` (lowercase). Works on macOS (case-insensitive) but breaks on Linux CI.
**Fix:** Match the exact filesystem casing in the import path.

## Pattern: Font mismatch (API vs rendered)
**Symptoms:** Embroidery/text preview shows wrong font. Console logs show API font family differs from resolved font family.
**Root cause:** Font mapping table in the component doesn't match the font families returned by the API.
**How we found it:** `get_console` showed repeated `[Embroidery] Font resolve: {apiFont: X, resolved: Y}` where X ≠ Y.
**Fix:** Check the font mapping/resolution logic — either update the mapping or use the API value directly.

## Pattern: Render loop / state oscillation
**Symptoms:** Console shows rapid-fire repeated state changes (same log pattern 10+ times in <2 seconds).
**Root cause:** `useEffect` dependency triggers a state change that re-triggers the effect.
**How we found it:** `get_console` showed 12 consecutive selection changes bouncing between two values within 2 seconds.
**Fix:** Check useEffect dependencies, add proper guards or debounce the handler.

## Pattern: Slow API blocking page render
**Symptoms:** Page takes >1s to show interactive content. `diagnose` shows an API call taking >1000ms.
**Root cause:** Critical-path API call not cached or prefetched.
**How we found it:** `diagnose` → `recentAPICalls` showed the config endpoint taking 1329ms.
**Fix:** Cache the response (if it's not user-specific), prefetch during the previous page, or move to a CDN-cached endpoint.

## Pattern: HMR ChunkLoadError
**Symptoms:** `ChunkLoadError` + unhandled promise rejection after dev server rebuilds.
**Root cause:** Stale hot-update chunk hash — page was loaded before the rebuild.
**Fix:** Hard reload (Cmd+Shift+R), or add HMR error boundary: `module.hot?.accept(err => window.location.reload())`.

## Pattern: Stale session state bleeding across products
**Symptoms:** Wrong values appearing (e.g. threadColor: 'dtm' on a product that doesn't support DTM, old embroidery text persisting, cached config from a different product).
**Root cause:** sessionStorage/localStorage caching values keyed by session or product slug, not cleared between product switches.
**How we found it:** Comparing `eval` output of stored state with the expected API response for the current product.
**Fix:** Before testing, clear session state: `eval({code: "(() => { ['session','customiz','cache','config','embroidery','garment'].forEach(pattern => { for(let i=localStorage.length-1;i>=0;i--) { const k=localStorage.key(i); if(k.includes(pattern)) localStorage.removeItem(k); } }); sessionStorage.clear(); return 'cleared'; })()"})` then `reload({bypass_cache:true})`.

## Pattern: React state inaccessible (minified class names on prod)
**Symptoms:** Can't read component state via DOM class names or data attributes — everything is minified (single letters, hashes).
**Root cause:** Production builds minify CSS class names and strip React DevTools hooks.
**How we found it:** `get_styles` returned hashed class names, `eval` fiber walking returned undefined.
**Fix:** Don't rely on class names. Use `get_element_rect({include_children:true})` for layout state, `get_styles` for computed visual state, `eval` with `document.querySelector('[data-testid]')` for test IDs, or read from the app's global store (`window.fpi`, Redux devtools, etc.).

## Pattern: FDK login expired silently
**Symptoms:** Local dev server returns blank/empty page, no errors in console. API calls return empty `{}` or redirect to login.
**Root cause:** FDK auth token expired (typically after 24h). The dev server doesn't surface auth errors visually.
**How we found it:** `get_network` showed API calls returning empty responses or redirects. `eval({code:"document.cookie"})` showed missing/expired session cookies.
**Fix:** Run `fdk login --host <platform-host>` to re-authenticate. Add a session-start health check: `eval({code: "fetch('/api/service/application/user/authentication/v1.0/session').then(r=>r.json()).then(d=>JSON.stringify(d))"})` — if it returns `{authenticated:false}`, re-login.

## Pattern: Visual change not visible after code edit
**Symptoms:** Made a CSS/coordinate change but screenshot shows no difference.
**Root cause:** Either HMR hasn't rebuilt yet, the change targets the wrong selector/element, or the CSS is being overridden by a more specific rule.
**How we found it:** `visual_diff` returned 0% diff. Then `get_styles` on the target showed the old value — change wasn't applied.
**Fix:** 1) Wait 3s for HMR. 2) Use `inject_css` to test the change live. 3) Use `get_styles` to verify the computed value actually changed. 4) If still unchanged, check specificity with `get_html` to see if a parent or sibling overrides.

---

# Chrome Edge Cases & Bridge Limitations

## Pattern: eval blocked by CSP (Content Security Policy)
**Symptoms:** `eval` returns `EvalError: Evaluating a string as JavaScript violates the following Content Security Policy directive because 'unsafe-eval' is not an allowed source of script`.
**Affected sites:** GitHub, YouTube, MDN, CodePen, and most modern production sites.
**Root cause:** The site's CSP header includes `script-src` without `'unsafe-eval'`. Our `eval` tool uses `chrome.scripting.executeScript` in MAIN world which then calls `eval()` — the page's CSP blocks that call at the V8 engine level.
**What still works:** `snapshot`, `click`, `fill`, `hover`, `get_html`, `get_styles`, `get_console`, `get_network`, `screenshot`, `get_element_rect`, `get_page_text` — all of these use function references (not string eval) and work on every site.
**Workarounds:**
1. Use `get_html` + `get_styles` to read DOM/CSS state instead of eval
2. Use `snapshot` to find interactive elements and their refs
3. Use `get_console` and `get_network` for debugging data
4. Use `get_page_text` to read visible page content
5. Combine `click`/`fill` with `wait_for` for interaction testing
**How to detect:** If eval fails with "Content Security Policy" in the error, switch to the alternatives above. Do NOT retry eval — it will fail every time on that page.

## Pattern: eval blocked by Trusted Types
**Symptoms:** `eval` returns `EvalError: Evaluating a string as JavaScript violates this document's Trusted Type assignment requirements`.
**Affected sites:** YouTube, Google properties, modern SPAs using Trusted Types API.
**Root cause:** Trusted Types is a stricter variant of CSP that blocks `eval()`, `innerHTML` assignments, and `document.write()` with untrusted strings. Same fundamental issue as CSP eval blocking.
**What still works:** Same as CSP — all tools except `eval`.
**Workarounds:** Same as CSP pattern above.
**How to detect:** If eval fails with "Trusted Type" in the error, same behavior as CSP — switch to alternatives.

## Pattern: chrome:// pages completely inaccessible
**Symptoms:** All tools fail. `eval` and `snapshot` return "Cannot access a chrome:// URL". `screenshot` returns "The 'activeTab' permission is not in effect".
**Affected pages:** `chrome://settings`, `chrome://extensions`, `chrome://flags`, `chrome://version`, `chrome://newtab`, all `chrome://` URLs.
**Root cause:** Chrome blocks ALL extension access to chrome:// URLs by design. No permissions, manifest changes, or workarounds can bypass this — it's a hard security boundary in the browser.
**What still works:** Nothing. `list_tabs` can see the tab exists (title + URL) but cannot interact with it.
**Workaround:** If you need information from a chrome:// page (e.g., Chrome version), use alternative approaches like `navigator.userAgent` via eval on a regular page, or `chrome.runtime.getManifest()` for extension info.

## Pattern: Debugger conflict in batch calls
**Symptoms:** One tool in a `batch` call succeeds, another fails with "Another debugger is already attached to the tab with id: XXXXX".
**Affected tools:** Any two tools that use `chrome.debugger` when run in the same batch: `performance_trace`, `get_accessibility_tree`, `heap_snapshot_summary`, `screenshot` (CDP mode), `mock_network`, `emulate_device`, `network_throttle`, `check_contrast`, `upload_file`.
**Root cause:** Chrome only allows ONE `chrome.debugger` attachment per tab at a time. When two debugger-dependent tools run concurrently in a batch, the second one can't attach.
**Fix:** Don't batch debugger-dependent tools together. Run them sequentially:
```
// BAD: batch([performance_trace, get_accessibility_tree])
// GOOD: performance_trace first, then get_accessibility_tree separately
```
**How to detect:** If a batch call returns "Another debugger is already attached", split the failing tool into a separate call.

## Pattern: check_contrast reports FAIL on transparent backgrounds
**Symptoms:** `check_contrast` returns contrast ratio ~1.0 and FAIL for WCAG AA/AAA, even though text is visually readable.
**Root cause:** The tool reads the element's direct `background-color` which is `rgba(0, 0, 0, 0)` (transparent). It doesn't walk up the parent chain to find the actual visible background.
**Example:** Wikipedia headings report contrast ratio 1.14 because the heading itself has transparent background, even though the page background is white.
**Workaround:** When check_contrast reports a transparent background (bg contains `rgba(0, 0, 0, 0)` or `transparent`):
1. Use `get_styles` on parent elements to find the actual background
2. Or use `inspect_pixel` at the text location to read the actual rendered color
3. Or use `screenshot` and visually verify contrast

## Pattern: Shadow DOM traversal
**Symptoms:** `get_html` or `snapshot` doesn't show elements inside web components. Clicking refs inside shadow DOM may fail.
**Affected sites:** YouTube (Polymer/Lit), GitHub (web components), sites using Shoelace, Material Web, etc.
**Root cause:** Elements inside Shadow DOM are not part of the main document's DOM tree. `document.querySelector()` can't reach them.
**How to detect:** If a visible element isn't in the snapshot, it's likely inside a shadow root. Use eval to check:
```
eval: document.querySelectorAll('*').forEach(el => { if(el.shadowRoot) console.log(el.tagName) })
```
**Workaround (open shadow roots):**
1. Use `eval` to traverse: `el.shadowRoot.querySelector('.target')`
2. Use `get_html` on the custom element itself to see its outer structure
3. `snapshot` does find interactive elements inside open shadow roots (buttons, inputs) — they get refs
**Note:** Closed shadow roots (`mode: "closed"`) are NOT accessible via JS. Very rare in practice.

## Pattern: Cross-origin iframe content inaccessible
**Symptoms:** `eval` or `get_html` targeting content inside an iframe returns null or throws a cross-origin error.
**Affected:** Ad iframes, payment frames (Stripe), embedded videos, social widgets (Facebook Like, Twitter embed).
**Root cause:** Cross-origin iframes run in separate renderer processes (Site Isolation). The parent page's JS context cannot access them. Our content script in the parent frame has no reach.
**What you CAN do:**
1. `eval` can detect iframes exist: `document.querySelectorAll('iframe')` — get src, sandbox, dimensions
2. `screenshot` captures the rendered iframe visually (it's in the viewport)
3. `get_element_rect` gives the iframe's position and size
**What you CANNOT do:** Read/modify content inside cross-origin iframes via eval from the parent frame.
**Future fix:** Use `chrome.scripting.executeScript` with `allFrames: true` to inject into each frame independently.

## Pattern: Service Worker not captured by bridge
**Symptoms:** Network requests made by a service worker don't appear in `get_network`. Console logs from service workers don't appear in `get_console`.
**Root cause:** Our bridge (`inject.js`) only runs in page contexts, not in service worker contexts. SWs have their own fetch/console that we don't wrap.
**Workaround:**
1. Check if a SW is active: `eval({code: "navigator.serviceWorker?.controller?.scriptURL"})`
2. Use `get_network` with `only_failures: true` to see requests that failed AFTER SW interception
3. For full SW debugging, open Chrome DevTools → Application → Service Workers

## Pattern: Tab discarded by Chrome — bridge buffers lost
**Symptoms:** After a tab has been in the background for a long time, `get_console` and `get_network` return empty arrays even though you expected history.
**Root cause:** Chrome discards background tabs under memory pressure, killing the renderer process. All in-memory state (our `__claudeBridge.logs` and `.requests` buffers) is lost. When the tab is refocused, it reloads fresh and our content script re-injects — but history starts from zero.
**How to detect:** If a background tab suddenly has empty buffers, it was likely discarded.
**Workaround:** Before investigating a background tab, `diagnose` it first to establish current state. Accept that historical logs may be gone. Use `get_console({clear: true})` to mark a clean starting point.

## Pattern: bfcache restores stale bridge state
**Symptoms:** After using browser back button, `get_console` shows old logs from the previous visit. `snapshot` refs may be stale.
**Root cause:** Back-forward cache restores the entire page state including our `__claudeBridge` object with its old buffers. The refs array points to old DOM elements that may have changed.
**Fix:** After any back/forward navigation:
1. Always take a fresh `snapshot` before using refs
2. Use `get_console({clear: true})` to reset the log buffer
3. Use `diagnose` which gives you a fresh snapshot automatically

## Pattern: WebSocket traffic invisible
**Symptoms:** A real-time app (chat, trading, notifications) is clearly receiving data but `get_network` shows nothing.
**Root cause:** Our bridge only wraps `fetch()` and `XMLHttpRequest`. WebSocket connections and their frames are not captured.
**Workaround:**
1. Use `eval` to check for WS connections: `eval({code: "performance.getEntriesByType('resource').filter(r => r.name.startsWith('wss://'))"})` 
2. For full WS inspection, the CDP `Network` domain can capture WebSocket frames (future improvement)
3. Use `screenshot` + `get_page_text` to observe the effects of WS messages on the UI

## Pattern: Large page snapshot exceeds limits
**Symptoms:** `snapshot` or `get_html` returns truncated content or takes very long.
**Root cause:** Pages with thousands of interactive elements (data tables, infinite scroll, complex SPAs) generate huge snapshots. HTML output is capped at 100KB.
**Workaround:**
1. Use `snapshot` with `max_elements` parameter to limit: `snapshot({max_elements: 50})`
2. Use `get_html` with a specific `selector` to target just the section you need
3. Use `eval` to query specific elements rather than dumping the whole page
4. For infinite scroll pages, scroll to the area of interest first, then snapshot
