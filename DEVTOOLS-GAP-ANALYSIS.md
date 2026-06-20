# Chrome DevTools vs Browser Bridge — Complete Feature Gap Analysis

Based on systematic review of https://developer.chrome.com/docs/devtools

## Feature-by-Feature Mapping

### Elements Panel
| DevTools Feature | Bridge Tool | Status | CDP Method to Add |
|-----------------|-------------|--------|-------------------|
| View DOM tree | `get_html` | COVERED | — |
| Edit DOM live | `eval` (DOM manipulation) | COVERED | — |
| Search DOM by string/CSS/XPath | `eval` + `get_html` | COVERED | `DOM.performSearch` |
| View computed styles | `get_styles` | COVERED | — |
| View matched CSS rules (which rule applies) | — | **MISSING** | `CSS.getMatchedStylesForNode` |
| Edit CSS live | `inject_css` | COVERED | — |
| View event listeners on element | — | **MISSING** | `DOMDebugger.getEventListeners` |
| Force element state (:hover, :focus, :active) | `hover` (hover only) | PARTIAL | `CSS.forcePseudoState` |
| View box model (margin/padding/border visual) | `get_element_rect` | PARTIAL | `DOM.getBoxModel` |
| DOM breakpoints (subtree modified, attribute changed) | — | **MISSING** | `DOMDebugger.setDOMBreakpoint` |
| Accessibility properties per element | `get_accessibility_tree` | COVERED | — |
| Track element focus | — | **MISSING** | eval `document.activeElement` |
| Badge overlays (grid, flex, container, scroll-snap) | — | **MISSING** | `Overlay.setShowGridOverlines` etc. |

### Console Panel
| DevTools Feature | Bridge Tool | Status | CDP Method to Add |
|-----------------|-------------|--------|-------------------|
| View console messages | `get_console` | COVERED | — |
| Group by frequency | `get_grouped_console` | COVERED | — |
| Run JavaScript | `eval` (CDP Runtime.evaluate) | COVERED | — |
| Live expressions (watch values update) | — | **MISSING** | Poll with `Runtime.evaluate` |
| Monitor function calls | — | **MISSING** | `Runtime.evaluate` with `console.monitor()` |
| Console API (table, group, time, count, assert) | `get_console` captures all | COVERED | — |

### Sources Panel
| DevTools Feature | Bridge Tool | Status | CDP Method to Add |
|-----------------|-------------|--------|-------------------|
| View page source files | — | **MISSING** | `Debugger.getScriptSource` |
| JavaScript breakpoints | — | **MISSING** | `Debugger.setBreakpoint` |
| Step through code (step over/into/out) | — | **MISSING** | `Debugger.stepOver/stepInto/stepOut` |
| Watch expressions | — | MISSING (LOW priority) | `Debugger.evaluateOnCallFrame` |
| Call stack inspection | — | MISSING (LOW) | `Debugger.getStackTrace` |
| Source maps | — | MISSING (LOW) | — |
| Local overrides (modify served files) | — | MISSING | `Fetch.enable` + `Fetch.fulfillRequest` |
| Snippets (save and run JS) | `eval` covers this use case | COVERED | — |

### Network Panel
| DevTools Feature | Bridge Tool | Status | CDP Method to Add |
|-----------------|-------------|--------|-------------------|
| View all requests | `get_network` | COVERED | — |
| Filter by type/URL/status | `get_network` (url_contains, only_failures) | COVERED | — |
| Request/response headers | `get_network` (partial — request headers redacted) | PARTIAL | `Network.getResponseBody` |
| Response bodies | `get_network` (failures only) + `search_network_bodies` | PARTIAL | `Network.getResponseBody` for ALL |
| Request initiator chain | — | **MISSING** | `Network.requestWillBeSent` (initiator field) |
| Timing breakdown (DNS, TCP, TLS, TTFB, download) | `get_load_timeline` | COVERED | — |
| WebSocket frames | — | **MISSING** | `Network.webSocketFrameReceived/Sent` |
| Block specific requests | `mock_network` (can return errors) | PARTIAL | `Network.setBlockedURLs` |
| Throttle network | `network_throttle` | COVERED | — |
| HAR export | — | MISSING (LOW) | Build from network events |
| Copy as cURL/fetch | — | MISSING (LOW) | Build from request data |
| Replay XHR | — | MISSING (LOW) | `eval` + `fetch()` |

### Performance Panel
| DevTools Feature | Bridge Tool | Status | CDP Method to Add |
|-----------------|-------------|--------|-------------------|
| Core Web Vitals (LCP, FCP, CLS) | `performance_trace` | COVERED | — |
| Long tasks detection | `performance_trace` (count + total ms) | COVERED | — |
| Resource count/transfer size | `performance_trace` | COVERED | — |
| CPU profiling / flame chart | — | **MISSING** | `Profiler.start/stop` |
| Resource waterfall | `get_load_timeline` | COVERED | — |
| Screenshot timeline during load | — | **MISSING** | CDP screenshots at intervals |
| Rendering performance (paint, layout, composite) | — | **MISSING** | `Tracing` domain |
| CSS selector performance analysis | — | MISSING (LOW) | `CSS.takeCoverageDelta` |
| Performance monitor (real-time CPU, heap, DOM, etc.) | `heap_snapshot_summary` (partial) | PARTIAL | `Performance.getMetrics` on interval |
| INP (Interaction to Next Paint) | — | **MISSING** | `PerformanceObserver` via eval |

### Memory Panel
| DevTools Feature | Bridge Tool | Status | CDP Method to Add |
|-----------------|-------------|--------|-------------------|
| JS heap size (used/total/limit) | `heap_snapshot_summary` | COVERED | — |
| DOM node count | `heap_snapshot_summary` | COVERED | — |
| Full heap snapshot | — | **MISSING** | `HeapProfiler.takeHeapSnapshot` |
| Detached DOM nodes detection | — | **MISSING** | Heap snapshot + filter "Detached" |
| Allocation timeline (where memory is allocated) | — | **MISSING** | `HeapProfiler.startTrackingHeapObjects` |
| Allocation sampling (by function) | — | **MISSING** | `HeapProfiler.startSampling` |
| Memory leak detection pattern | Documented in `bridge_knowledge` | COVERED (guidance) | — |
| Garbage collection forcing | — | **MISSING** | `HeapProfiler.collectGarbage` |

### Application Panel
| DevTools Feature | Bridge Tool | Status | CDP Method to Add |
|-----------------|-------------|--------|-------------------|
| localStorage | `get_storage` / `set_storage` | COVERED | — |
| sessionStorage | `get_storage({storage_type:"session"})` | COVERED | — |
| Cookies | `get_cookies` / `edit_cookie` | COVERED | — |
| IndexedDB inspection | — | **MISSING** | `IndexedDB.requestDatabaseNames` |
| Cache API (Cache Storage) | — | **MISSING** | `CacheStorage.requestCacheNames` |
| Service worker status/lifecycle | — | **MISSING** | `ServiceWorker.enable` |
| Service worker registration/unregister | — | **MISSING** | `ServiceWorker.unregister` |
| Manifest inspection (PWA) | — | MISSING (LOW) | eval `document.querySelector('link[rel=manifest]')` |
| Background sync / push events | — | MISSING (LOW) | `BackgroundService.startObserving` |
| bfcache test | eval-based detection | PARTIAL | — |

### Rendering Panel
| DevTools Feature | Bridge Tool | Status | CDP Method to Add |
|-----------------|-------------|--------|-------------------|
| Paint flashing (highlight repainted areas) | — | **MISSING** | `Overlay.setShowPaintRects` |
| Layout shift regions | — | **MISSING** | `Overlay.setShowLayoutShiftRegions` |
| Layer borders | — | **MISSING** | `Overlay.setShowDebugBorders` |
| FPS meter | — | **MISSING** | `Overlay.setShowFPSCounter` |
| Scrolling performance issues | — | **MISSING** | `Overlay.setShowScrollBottleneckRects` |
| Emulate CSS media (print, screen) | — | **MISSING** | `Emulation.setEmulatedMedia` |
| Emulate prefers-color-scheme | `toggle_dark_mode` | COVERED | — |
| Emulate prefers-reduced-motion | — | **MISSING** | `Emulation.setEmulatedMedia` |
| Emulate forced-colors | — | **MISSING** | `Emulation.setEmulatedMedia` |
| CSS Grid/Flexbox overlay | — | **MISSING** | `Overlay.setShowGridOverlines` |

### Other Panels
| DevTools Feature | Bridge Tool | Status | CDP Method to Add |
|-----------------|-------------|--------|-------------------|
| Lighthouse audit (perf, a11y, SEO, PWA, best practices) | — | **MISSING** | Needs Lighthouse library |
| Security panel (certificate info, mixed content) | Partial via `get_network` + eval | PARTIAL | `Security.enable` |
| Coverage (unused CSS/JS percentage) | — | **MISSING** | `Profiler.startPreciseCoverage` + `CSS.startRuleUsageTracking` |
| Animations panel (inspect/modify CSS animations) | — | **MISSING** | `Animation.enable` + `Animation.getPlaybackRate` |
| Changes panel (track live edits) | — | MISSING (LOW) | Track inject_css/eval changes |
| Layers panel (3D layer view) | — | MISSING (LOW) | `LayerTree.enable` |
| CSS Overview (all colors, fonts, unused declarations) | eval-based in `bridge_knowledge` | PARTIAL | `CSS.getStyleSheetText` |
| Issues panel (auto-detected issues) | `diagnose` (CSP, CAPTCHA, errors) | PARTIAL | `Audits.enable` |
| Media panel (video/audio debugging) | Video tools | PARTIAL | `Media.enable` |
| Sensors (geolocation, orientation, touch) | `set_geolocation`, `emulate_device` | PARTIAL | `DeviceOrientation.setDeviceOrientationOverride` |

---

## Priority Gaps Summary

### HIGH Priority (Commonly needed, big impact)
1. **CSS matched rules** — `CSS.getMatchedStylesForNode` — shows which CSS rules apply and their specificity
2. **Event listeners per element** — `DOMDebugger.getEventListeners` — debug "why doesn't click work"
3. **Force pseudo-state** — `CSS.forcePseudoState` — test :hover/:focus/:active without mouse
4. **WebSocket frame capture** — `Network.webSocketFrameReceived/Sent` — debug real-time apps
5. **Response bodies for ALL requests** — `Network.getResponseBody` — not just failures
6. **Paint flashing** — `Overlay.setShowPaintRects` — visual rendering performance debug
7. **Layout shift regions** — `Overlay.setShowLayoutShiftRegions` — debug CLS
8. **FPS meter** — `Overlay.setShowFPSCounter` — real-time frame rate
9. **INP measurement** — `PerformanceObserver` for interaction delays
10. **Service worker management** — `ServiceWorker.enable/unregister` — debug PWAs and caching

### MEDIUM Priority (Useful for specific scenarios)
11. **CPU profiling** — `Profiler.start/stop` — find slow functions
12. **Full heap snapshot** — `HeapProfiler.takeHeapSnapshot` — deep memory analysis
13. **Detached DOM detection** — heap snapshot + filter — find memory leaks
14. **Garbage collection** — `HeapProfiler.collectGarbage` — force GC for testing
15. **IndexedDB inspection** — `IndexedDB.requestDatabaseNames` — debug offline storage
16. **Cache Storage inspection** — `CacheStorage.requestCacheNames` — debug PWA caching
17. **Code coverage** — `Profiler.startPreciseCoverage` — find unused JS/CSS
18. **CSS media emulation** — `Emulation.setEmulatedMedia` — print preview, reduced-motion
19. **Request blocking** — `Network.setBlockedURLs` — test without specific resources
20. **Request initiator chain** — who triggered each request

### LOW Priority (Niche, can use eval workarounds)
21. Source map resolution, JS breakpoints, step debugging
22. HAR export, copy as cURL
23. Animation inspection/modification
24. Layer visualization
25. WebAuthn emulation
26. Background service debugging

---

## What to Integrate Into bridge_knowledge

The gaps above should be added to the knowledge system so Claude knows:
1. What DevTools can do that the bridge can't yet
2. How to work around the gaps using existing tools
3. Which CDP methods would implement each gap (for future bridge versions)
