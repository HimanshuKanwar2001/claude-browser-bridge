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
