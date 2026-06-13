# Bug Playbook

Patterns from past debugging sessions. Read this BEFORE investigating new bugs — the answer may already be here.

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
