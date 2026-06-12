# Global Instructions

## Browser Bridge (browser-bridge MCP — 58 tools)

The `browser-bridge` MCP connects to the user's real Chrome browser via an extension. ALL browser operations MUST use these tools — never use WebFetch, curl, or other workarounds.

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
| Read the full usage guide | `browser_bridge_help` |
| Read the full usage guide | `browser_bridge_help` |
