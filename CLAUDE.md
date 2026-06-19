# Global Instructions

## Browser Bridge (browser-bridge MCP — 74 tools)

The `browser-bridge` MCP connects to the user's real Chrome browser via an extension. ALL browser operations MUST use these tools — never use WebFetch, curl, or other workarounds.

**Reference files**: `INVESTIGATION-PLAYBOOK.md` for systematic investigation approaches (bugs, security, performance, accessibility). `CHROME-KNOWLEDGE.md` for Chrome internals reference. `bug-playbook.md` for known patterns from past debugging.

### Decision Tree: Which tool first?

```
Is this about a web page?
├── Investigating a bug/issue → diagnose (ONE call gives you everything)
├── Fixing CSS/visual → batch([screenshot, get_styles, get_html])
├── Checking performance → batch([performance_trace, get_load_timeline])
├── Checking accessibility → batch([get_accessibility_tree, check_contrast])
├── Reading page content → eval (for specific data) or get_page_text (for all text)
├── Interacting with the page → diagnose first (get refs), then click/fill/hover using refs
├── Opening a URL for research → new_tab (NEVER navigate away from the app tab)
└── Don't know yet → diagnose (it covers 80% of what you need)
```

### Critical Rules (break these = slow, bad results)

1. **`diagnose` FIRST, always.** Returns snapshot (refs for click/fill) + console errors + failed network + API responses + CAPTCHA detection in ONE call. Never call snapshot, get_console, get_network separately.
2. **`batch` for parallel calls.** If you're about to make 2+ calls that don't depend on each other, ALWAYS batch them. Every sequential call wastes 2-3 seconds.
3. **`select_tab` once, never again.** Pin the target tab at session start. Stop passing tab_id after that.
4. **`new_tab` for research.** NEVER use navigate on the app tab to open docs/Stack Overflow. Open → read → close_tab.
5. **`screenshot` after EVERY code edit.** Never claim a visual fix works without seeing it. Period.
6. **`inject_css` before editing files.** Test CSS changes instantly in the live page, confirm with screenshot, THEN write to the actual file.
7. **`eval` for state.** Reading React state, Redux store, variables, or specific DOM values is faster than parsing full page text.
8. **`get_styles` for CSS.** Never guess computed values — Less variables, calc(), tokens all resolve unpredictably. Read the actual computed styles.
9. **3 failed attempts = search the web.** Open `new_tab` with Google search, read solutions, close tab. Stop guessing.
10. **Update `bug-playbook.md`** after every fix — the next similar bug gets solved instantly.

### Workflow: Visual/CSS Bug Fix

```
1. batch([screenshot, get_styles({selector:".problem"}), get_html({selector:".problem"})])
   → See the current state + actual CSS values + actual DOM structure

2. inject_css({css: ".problem { padding: 16px; }"})
   → Test the fix instantly, no rebuild needed

3. screenshot
   → Verify it looks right

4. If wrong: get_styles again → find what CSS actually applied → adjust → screenshot

5. If right: write the change to the actual source file, remove inject_css

6. screenshot one more time to confirm the file-based change took effect (after HMR/rebuild)
```

### Workflow: Bug Investigation

```
1. Read bug-playbook.md (if exists) — check for matching patterns

2. diagnose → read errors, failed requests, API responses

3. If need more: batch([get_grouped_console, get_network({url_contains:"/api/"}), eval({code:"..."})])

4. If stuck after 3 attempts: new_tab Google search → read solutions → close_tab

5. Fix → screenshot to verify → append pattern to bug-playbook.md
```

### Workflow: Performance Audit

```
batch([performance_trace, get_load_timeline, heap_snapshot_summary])
→ Web Vitals (LCP/FCP/CLS) + full resource waterfall + memory usage in ONE call
```

### Workflow: Page Interaction (filling forms, clicking buttons)

```
1. diagnose → get refs (ref_0 <button> "Submit", ref_3 <input> "Email")
2. fill({ref:"ref_3", value:"test@example.com"})
3. click({ref:"ref_0"})
4. wait_for({text:"Success"}) or screenshot to verify
```

### Workflow: Multi-tab Research

```
1. select_tab on the app tab (pin it)
2. new_tab({url:"https://google.com/search?q=..."})
3. get_page_text on the research tab
4. close_tab on the research tab
5. Continue working on the pinned app tab — it was never disturbed
```

### Workflow: Testing Error States

```
1. mock_network({url_pattern:"/api/cart", status_code:500, response_body:"{\"error\":\"Server Error\"}"})
2. reload
3. screenshot → see how the app handles the error
4. (debugger detach stops the mock)
```

### Workflow: Regression Testing

```
1. record_actions → interact with the page to reproduce the bug
2. record_actions({stop:true}) → get the action list
3. Fix the code
4. replay_actions({actions: [...]}) → verify the fix
5. screenshot → confirm
```

### Workflow: Visual Diff (before/after comparison)

```
1. screenshot → save the dataUrl
2. Make code changes → wait for rebuild
3. visual_diff({before_dataUrl: "data:image/png;base64,..."})
   → Returns diff % and an image with changes highlighted in red
```

### Workflow: Image Layer / Z-Index Debugging

```
1. annotate({annotations: [
     {selector:".base-img", label:"Base Layer", color:"red"},
     {selector:".overlay-img", label:"Overlay", color:"blue"},
     {selector:".emb-text", label:"Embroidery", color:"green"}
   ]}) → screenshot → visually see which layer is which

2. get_element_rect({selector:".composer", include_children:true})
   → exact position, z-index, opacity of every child element

3. inspect_pixel({selector:".garment-img", x:50, y:30, percent:true})
   → check if that pixel is transparent (a:0) or opaque — bypasses CORS

4. capture_canvas({selector:".composer"})
   → flatten all stacked images into one PNG to see the composited result

5. clear_annotations when done
```

### Workflow: Cross-Product / Cross-Environment Comparison

```
1. new_tab({url:"https://site.com/product-A"})
2. new_tab({url:"https://site.com/product-B"})
3. compare_tabs({tab_id_1: tabA, tab_id_2: tabB})
   → screenshots of both + diff image with changes in red
4. close both tabs
```

### Workflow: State/Cache Manipulation

```
1. set_storage({key:"customization_cache", action:"remove"}) → clear cached state
2. reload({bypass_cache:true}) → fresh page load
3. diagnose → verify behavior with clean state
```

### Workflow: Clear All Session State Before Testing

When debugging requires a clean slate (stale cache, old form data, leaked state from previous sessions):

```
1. eval({code: "(() => { sessionStorage.clear(); const keys = []; for (let i = localStorage.length-1; i>=0; i--) { const k = localStorage.key(i); if (k.includes('session') || k.includes('cache') || k.includes('config')) { keys.push(k); localStorage.removeItem(k); } } return 'Cleared: ' + keys.join(', '); })()"})
2. reload({bypass_cache: true})
3. diagnose → verify clean state
```

### Workflow: Multi-Page Spot Check

When you need to verify the same feature across multiple products/pages/routes:

```
1. Gather your URLs (product variants, different routes, staging vs prod)
2. For each URL:
   a. new_tab({url}) → wait_for({selector:"main"})
   b. Run the test actions (click, fill, scroll)
   c. screenshot → save for comparison
   d. get_page_info → check for errors
   e. close_tab
3. Compare screenshots across pages
```

### Workflow: Verify Visual Changes After Code Edits

After editing CSS, coordinates, layout, or any visual property:

```
1. screenshot → save the dataUrl as "before"
2. Make the code change → wait for HMR rebuild (2-3 seconds)
3. visual_diff({before_dataUrl: savedDataUrl})
   → Returns diff %, pixel count, and highlighted diff image
4. If diff is 0% → change didn't take effect (check the selector/file)
5. If diff is <1% → likely a small positioning adjustment (correct)
6. If diff is >10% → something major moved (review carefully)
```

### Tool Reference (65 tools)

| When you need to... | Use this |
|---|---|
| First look at any page | `diagnose` |
| Run 2+ tools at once | `batch` |
| Pin a tab for the session | `select_tab` |
| See what page looks like | `screenshot` or `full_page_screenshot` |
| Read page text | `get_page_text` or `eval` |
| Read HTML of an element | `get_html` |
| Read CSS of an element | `get_styles` |
| Click a button/link | `click` (use ref from diagnose) |
| Fill an input/form | `fill` (use ref from diagnose) |
| Hover for tooltip/dropdown | `hover` |
| Scroll the page | `scroll` |
| Press keyboard key | `press_key` |
| Select dropdown option | `select_option` |
| Upload a file | `upload_file` |
| Show user which element | `highlight_element` |
| Open URL without leaving app | `new_tab` |
| Close a research tab | `close_tab` |
| Go back in history | `go_back` |
| Reload the page | `reload` |
| Wait for element/text | `wait_for` |
| List all browser tabs | `list_tabs` |
| Navigate to a URL | `navigate` |
| See console errors | `get_console` or `get_grouped_console` |
| See network requests | `get_network` |
| Search in API responses | `search_network_bodies` |
| Read cookies | `get_cookies` |
| Edit/delete a cookie | `edit_cookie` |
| Read localStorage | `get_storage` |
| Read clipboard | `get_clipboard` |
| Watch DOM mutations | `watch_dom_changes` |
| Generate CSS selectors | `generate_selector` |
| Test CSS without rebuild | `inject_css` |
| Compare before/after | `visual_diff` |
| Record user actions | `record_actions` |
| Replay recorded actions | `replay_actions` |
| Mock an API response | `mock_network` |
| Handle alert/confirm dialog | `handle_dialog` |
| Get Web Vitals + perf | `performance_trace` |
| Get memory usage | `heap_snapshot_summary` |
| Get load waterfall | `get_load_timeline` |
| Get accessibility tree | `get_accessibility_tree` |
| Check color contrast | `check_contrast` |
| Emulate mobile/tablet | `emulate_device` |
| Throttle network speed | `network_throttle` |
| Spoof GPS location | `set_geolocation` |
| Toggle dark mode | `toggle_dark_mode` |
| Export page as PDF | `export_pdf` |
| Save form answers for reuse | `save_form_profile` |
| Load saved form answers | `load_form_profile` |
| Save all open tabs | `save_tab_session` |
| Restore saved tabs | `restore_tab_session` |
| Quick error check | `get_page_info` |
| Get element snapshot | `snapshot` |
| Run JS in the page | `eval` |
| Check pixel color on image | `inspect_pixel` (bypasses CORS) |
| Get exact element position/box | `get_element_rect` (viewport + parent + children) |
| Compare two tabs visually | `compare_tabs` (screenshots + diff) |
| Label elements for debugging | `annotate` (persistent borders + labels) |
| Remove labels | `clear_annotations` |
| Flatten stacked images | `capture_canvas` (composited PNG) |
| Write to localStorage/sessionStorage | `set_storage` |
| Get video captions (non-YouTube) | `video_get_captions` |
| Control video playback | `video_control` (play, pause, seek, speed) |
| Screenshot video at timestamp | `video_capture_frame` (Claude sees code/slides) |
| Get video chapter markers | `video_get_chapters` |
| Transcribe via speech recognition | `video_listen` (when no captions exist) |
| Auto-read video content | `video_smart_read` (captions → speech fallback) |
| Read the full usage guide | `browser_bridge_help` |

---

### Chrome Edge Cases — Know Before You Hit Them

#### CSP & Trusted Types: When `eval` Won't Work

**Major sites that block eval:** GitHub, YouTube, MDN, CodePen, Google properties, and most modern production sites.

```
eval fails with CSP/Trusted Types error?
├── DON'T retry eval — it will ALWAYS fail on that page
├── For reading state → use get_html + get_styles + get_page_text
├── For finding elements → use snapshot (always works)
├── For interacting → use click/fill/hover with refs (always works)
├── For debugging → use get_console + get_network (always works)
├── For screenshots → use screenshot (always works)
└── For complex queries → combine get_html(selector) + get_styles(selector)
```

**What ALWAYS works on every site (CSP-immune):**
`snapshot`, `click`, `fill`, `hover`, `scroll`, `press_key`, `select_option`,
`get_html`, `get_styles`, `get_page_text`, `get_page_info`, `screenshot`,
`get_console`, `get_network`, `get_element_rect`, `get_cookies`, `get_storage`,
`wait_for`, `diagnose`, `highlight_element`, `annotate`, `inject_css`

**What fails on CSP-strict sites:** `eval` only.

#### Pages You CANNOT Access At All

```
chrome:// pages → ALL tools blocked (settings, extensions, flags, newtab)
chrome-extension:// → blocked (other extensions' pages)
Chrome Web Store → blocked
devtools:// → blocked
view-source: → blocked
```

`list_tabs` can see these tabs exist (title + URL) but cannot interact. Don't waste time trying.

#### Debugger Conflict: Never Batch These Together

These tools all use `chrome.debugger` — only ONE can run at a time per tab:

```
DEBUGGER TOOLS (never batch two of these together):
  performance_trace, get_accessibility_tree, heap_snapshot_summary,
  mock_network, emulate_device, network_throttle, upload_file,
  check_contrast (sometimes), screenshot (CDP mode)

BAD:  batch([performance_trace, get_accessibility_tree])  → second one FAILS
GOOD: performance_trace first → then get_accessibility_tree separately
SAFE TO BATCH: batch([screenshot, get_styles, get_html, eval, get_console])
```

#### Shadow DOM: How to Reach Inside Web Components

YouTube, GitHub, and modern component libraries use Shadow DOM. Elements inside shadow roots may not appear in `snapshot` or `get_html`.

```
1. Check for shadow roots: 
   eval: document.querySelectorAll('*').forEach(el => { if(el.shadowRoot) ... })

2. Query inside open shadow roots:
   eval: document.querySelector('my-component').shadowRoot.querySelector('.target')

3. snapshot DOES find interactive elements (buttons/inputs) inside open shadow roots
   — they get refs and click/fill works

4. Closed shadow roots (mode: "closed") → NOT accessible. Very rare.
```

#### Cross-Origin Iframes: What You Can and Can't Do

```
CAN do:
  - Detect iframes exist: eval("document.querySelectorAll('iframe').length")
  - See iframe position/size: get_element_rect({selector: "iframe"})
  - Screenshot captures iframes visually (they're rendered in viewport)

CANNOT do:
  - Read/modify content inside cross-origin iframes via eval
  - Get elements inside ad iframes, payment frames (Stripe), social widgets

Affected: Ad iframes, payment forms, social embeds, embedded videos
```

#### check_contrast: Transparent Background False Positives

When `check_contrast` returns ratio ~1.0 with `bg: rgba(0, 0, 0, 0)`:
```
The element has transparent background — contrast tool doesn't walk up parents.
Fix: Use get_styles on parent elements to find actual background, or
     use inspect_pixel at the text location for the real rendered color.
```

#### Tab Discarding: Lost Buffer History

Chrome kills background tabs under memory pressure. All `__claudeBridge` buffers (logs, requests) are lost. When refocused, tab reloads fresh.
```
If a background tab has empty console/network history:
1. It was likely discarded by Chrome
2. Accept history is gone — start fresh
3. Use diagnose to establish current state
4. Use get_console({clear: true}) to mark a clean starting point
```

#### After Back/Forward Navigation (bfcache)

```
After browser back/forward:
1. ALWAYS take fresh snapshot before using refs (old refs are stale)
2. Use get_console({clear: true}) to reset stale log buffer
3. Use diagnose (gives fresh snapshot automatically)
```

### Workflow: Investigating a CSP-Strict Site (GitHub, YouTube, etc.)

When eval is blocked, use this complete alternative workflow:

```
1. diagnose → snapshot + console errors + network failures (all work)

2. For DOM structure: get_html({selector: ".target"})
   For CSS values: get_styles({selector: ".target"})
   For text content: get_page_text
   For element geometry: get_element_rect({selector: ".target"})

3. For interaction: use refs from snapshot
   click({ref: "ref_5"}) → wait_for({text: "Expected"}) → screenshot

4. For debugging: get_console + get_network({url_contains: "/api/"})
   For searching API responses: search_network_bodies({query: "error"})

5. For CSS testing: inject_css({css: ".fix { color: red }"}) → screenshot
```

### Workflow: Debugging Shadow DOM Components

```
1. diagnose → check if snapshot found the elements you expect

2. If elements are missing from snapshot:
   get_html({selector: "the-component"}) → check if it's a custom element

3. On eval-friendly sites, traverse shadow DOM:
   eval: document.querySelector('my-el').shadowRoot.innerHTML

4. On CSP-strict sites (eval blocked):
   get_html gives you the custom element's outer HTML
   get_styles gives you computed styles on the host element
   snapshot still finds interactive elements inside open shadow roots
   click/fill refs work for buttons/inputs inside shadow DOM

5. screenshot to visually verify what the shadow content looks like
```

### Workflow: Performance Audit (Debugger-Safe)

```
DON'T: batch([performance_trace, get_accessibility_tree, heap_snapshot_summary])
       → debugger conflicts will cause failures

DO: Run them in sequence:
1. performance_trace → Web Vitals (LCP, FCP, CLS) + CDP metrics
2. get_accessibility_tree → a11y tree (after performance detaches)
3. heap_snapshot_summary → memory usage (after a11y detaches)
4. get_load_timeline → resource waterfall (no debugger needed, safe to batch)

SAFE BATCH: batch([performance_trace, get_load_timeline])
            (only performance_trace uses debugger here)
```

### Investigation Quick Reference (Full playbook: INVESTIGATION-PLAYBOOK.md)

#### Which approach for which problem?

```
Visual bug?
├── Quick: batch([screenshot, get_styles({selector:".broken"})])
├── Standard: inject_css → screenshot loop (test fixes live)
└── Deep: annotate layers + get_element_rect({include_children:true}) + visual_diff

Broken feature?
├── Quick: diagnose (check consoleErrors + failedRequests)
├── Standard: click/fill → get_console → get_network (trace the action)
└── Deep: record_actions → replay → state tracking with eval

Security check?
├── Quick: get_cookies (check HttpOnly/Secure/SameSite flags)
├── Standard: get_network (tokens in URLs?) + get_html (reflected input?)
├── Deep: Full audit — cookie flags + storage audit + API exposure + CORS + mixed content

Slow page?
├── Quick: performance_trace (Web Vitals in one call)
├── Standard: + get_load_timeline (resource waterfall)
└── Deep: network_throttle("slow-3g") → reload → performance_trace

A11y audit?
├── Quick: get_accessibility_tree
├── Standard: + check_contrast on key text elements
└── Deep: keyboard nav test (press_key Tab loop) + full a11y tree review

Wrong data?
├── Quick: get_network({url_contains:"/api/"})
├── Standard: search_network_bodies({query:"the wrong value"})
└── Deep: Storage audit + eval state inspection + clean slate test

API failure?
├── Quick: diagnose (failedRequests with response bodies)
├── Standard: get_network({only_failures:true}) + search_network_bodies
└── Deep: mock_network for error state testing + empty state testing
```

#### Security Testing Checklist (via bridge)

```
1. COOKIES:    get_cookies → check HttpOnly, Secure, SameSite, expiration
2. TOKENS:     get_network → tokens in URLs? search_network_bodies("token")
3. XSS:        fill({value:"<script>..."}) → get_html → check if reflected unescaped
4. DATA LEAK:  get_html → hidden fields, comments, JSON-LD with sensitive data
5. API OVER-FETCH: get_network → do responses contain more fields than UI shows?
6. MIXED:      get_network → any http:// requests on https:// page?
7. CSP:        diagnose → cspBlocksEval? (if false = weaker XSS protection)
8. SOURCE MAPS: eval("fetch(scriptSrc+'.map')...") → exposed source code?
9. STORAGE:    get_storage → tokens in localStorage? (vulnerable to XSS)
10. CORS:      get_network → Access-Control-Allow-Origin: * with credentials?
```
