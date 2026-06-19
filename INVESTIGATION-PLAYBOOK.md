# Browser Bridge Investigation Playbook

Complete methodology for finding bugs, security risks, performance issues, and solutions
using the browser bridge. Each scenario has multiple approaches ranked by effectiveness.

---

## How to Use This Playbook

1. **Identify the scenario** — What type of problem are you investigating?
2. **Start with the Quick Scan** — Every scenario begins with a fast triage
3. **Choose an approach** — Multiple approaches ranked: Quick → Standard → Deep
4. **Recognize patterns** — Symptom → Likely cause → Verification steps
5. **Document findings** — Add new patterns to `bug-playbook.md`

---

## 1. Bug Hunting

### 1A. Visual / CSS Bugs

**Symptoms**: Element looks wrong, misaligned, wrong color/size/spacing, overflow, hidden content.

**Quick Scan** (30 seconds):
```
batch([screenshot, get_styles({selector:".broken"}), get_element_rect({selector:".broken"})])
→ See it + read actual CSS values + exact position/size in one call
```

**Approach 1 — Live CSS Testing** (Best for styling issues):
```
1. screenshot → see the current state
2. get_styles({selector:".target"}) → read ACTUAL computed values (not what you think they are)
3. inject_css({css:".target { ... fix ... }"}) → test fix instantly, no rebuild
4. screenshot → verify fix looks right
5. If wrong: get_styles again → check what actually applied → adjust
6. If right: write to source file → screenshot to confirm after HMR rebuild
```

**Approach 2 — Visual Diff** (Best for regressions):
```
1. screenshot → save the dataUrl as "before"
2. Apply the fix or revert the suspect commit
3. visual_diff({before_dataUrl: "..."}) → exact pixel diff with red highlighting
4. If diff is 0%: change didn't take effect (wrong selector, HMR not done)
5. If diff < 1%: minor positioning change (likely correct)
6. If diff > 10%: something major moved (needs review)
```

**Approach 3 — Element Geometry Deep Dive** (Best for layout/z-index issues):
```
1. get_element_rect({selector:".container", include_children:true})
   → exact position, z-index, opacity, visibility of EVERY child element
2. annotate({annotations:[
     {selector:".layer1", label:"Base", color:"red"},
     {selector:".layer2", label:"Overlay", color:"blue"}
   ]}) → visual labels on each layer
3. screenshot → see the annotated state
4. inspect_pixel({selector:".target", x:50, y:50, percent:true})
   → check exact color at that point (bypasses CORS)
5. clear_annotations
```

**Pattern Recognition**:
| Symptom | Likely Cause | Verify With |
|---------|-------------|-------------|
| Element invisible but in DOM | `display:none`, `opacity:0`, `visibility:hidden`, `height:0` | `get_styles` → check display/opacity/visibility/height |
| Element in wrong position | Missing `position`, wrong `z-index`, flex/grid issue | `get_element_rect({include_children:true})` |
| Text cut off | `overflow:hidden` + fixed height, `text-overflow:ellipsis` | `get_styles` → check overflow + height |
| Style not applying | Specificity war, wrong selector, cached CSS | `get_styles` → if old value still shows, specificity issue |
| Different on mobile | Media query not firing, viewport meta missing | `emulate_device({device:"mobile"})` → screenshot |
| Flicker/flash | Transition timing, z-index repainting | `record_actions` → slow replay → screenshot each step |

---

### 1B. Logic / Functional Bugs

**Symptoms**: Button doesn't work, form submits wrong data, wrong content displayed, feature broken.

**Quick Scan** (30 seconds):
```
diagnose → check snapshot (is the element there?), consoleErrors (JS error?), failedRequests (API down?)
```

**Approach 1 — Interaction Replay** (Best for "click doesn't work" bugs):
```
1. diagnose → get refs for interactive elements
2. observe_mode({enabled:true}) → Claude sees result of every action
3. click({ref:"ref_X"}) → see what happens visually
4. get_console → check for JS errors thrown on click
5. get_network → check if API call was made and what it returned
6. If click does nothing: get_html({selector:"button"}) → check disabled, aria-disabled, pointer-events
```

**Approach 2 — State Tracking** (Best for wrong data / wrong content):
```
1. eval({code: "JSON.stringify(window.__INITIAL_STATE__ || window.__NEXT_DATA__ || {})"})
   → Read app state (Next.js, Nuxt, Redux, etc.)
2. eval({code: "JSON.stringify(Object.fromEntries(new FormData(document.querySelector('form'))))"})
   → Read actual form data being submitted
3. get_network({url_contains:"/api/"}) → check what the server actually sent
4. search_network_bodies({query:"the wrong value"}) → find which API response contains it
```

**Approach 3 — Event Chain Tracing** (Best for race conditions / timing bugs):
```
1. get_console({clear:true}) → clear buffer
2. Perform the action (click, fill, submit)
3. get_console → read the execution trail (console.logs, errors, warnings)
4. get_network → check API call ordering and timing
5. eval({code: "performance.getEntriesByType('measure')"}) → custom timing marks
```

**Pattern Recognition**:
| Symptom | Likely Cause | Verify With |
|---------|-------------|-------------|
| Button click does nothing | JS error, event handler missing, disabled state | `get_console` after click + `get_html` on button |
| Form submits wrong data | Wrong input names, stale state, form not connected | `eval` to read FormData + `get_html` on form |
| Content doesn't update | SPA routing issue, stale cache, state not refreshed | `get_network` to see if API called + `eval` for state |
| Intermittent failure | Race condition, timing dependency | `get_console` for rapid-fire state changes |
| Works locally, fails in prod | Env config, API URL mismatch, CORS | `get_network({only_failures:true})` + `get_console` |

---

### 1C. State / Data Bugs

**Symptoms**: Wrong values persisting, state bleeding between pages, stale cache showing old data.

**Quick Scan**:
```
batch([
  eval({code: "JSON.stringify({localStorage: Object.keys(localStorage), sessionStorage: Object.keys(sessionStorage), cookies: document.cookie})"}),
  get_network({url_contains:"/api/", only_failures:false})
])
```

**Approach 1 — Storage Audit**:
```
1. get_storage → read all localStorage keys and values
2. get_storage({storage_type:"session"}) → read sessionStorage
3. get_cookies → read all cookies (including HttpOnly via extension API)
4. eval({code: "JSON.stringify(Object.keys(window).filter(k => k.startsWith('__')))"})
   → find global state objects
```

**Approach 2 — Clean Slate Test**:
```
1. screenshot → capture current (buggy) state
2. eval({code: "localStorage.clear(); sessionStorage.clear();"})
3. set_storage({action:"clear"})
4. reload({bypass_cache:true}) → fresh load without any cached state
5. screenshot → compare with clean state
6. If bug gone: it's a stale state issue → find which key causes it
```

**Approach 3 — State Diff Between Pages**:
```
1. On page A: eval to capture state → save result
2. Navigate to page B
3. eval to capture state again
4. Compare: which keys changed? Which shouldn't have?
5. Check sessionStorage for values that leaked between products/pages
```

---

## 2. Security Testing

### 2A. XSS (Cross-Site Scripting) Detection

**Quick Scan**:
```
diagnose → check if eval works (CSP blocks XSS too) + check for user-controlled content in snapshot
```

**Approach 1 — Input Reflection Testing**:
```
1. diagnose → find all input fields (refs)
2. fill({ref:"ref_X", value:"<img src=x onerror=alert(1)>"}) → inject XSS payload
3. click submit button
4. get_html({selector:"body"}) → check if payload appears unescaped in DOM
5. get_console → check if error events fired (img onerror)
6. Look for: unescaped <, >, ", ' in the response HTML
```

**Approach 2 — URL Parameter Reflection**:
```
1. navigate({url:"https://site.com/search?q=<script>alert(1)</script>"})
2. get_html({selector:"body"}) → check if parameter reflected unescaped
3. eval({code: "document.querySelectorAll('[value]').forEach(e => console.log(e.tagName, e.value))"})
   → check if URL params appear in form values unescaped
```

**Approach 3 — DOM-Based XSS**:
```
1. eval({code: "document.querySelectorAll('[innerHTML],[outerHTML]').length"})
   → check for dangerous DOM mutations
2. eval({code: "document.querySelectorAll('script:not([src])').forEach(s => console.log(s.textContent.slice(0,200)))"})
   → check for inline scripts using user data
3. get_html → search for template literals containing user input: ${userInput}
```

**What to look for**:
- User input reflected in HTML without encoding
- `innerHTML`, `outerHTML`, `document.write()` with user data
- URL parameters appearing in `<script>` blocks
- No CSP header (cspBlocksEval: false in diagnose means page-level XSS easier)
- Missing `HttpOnly` on session cookies (check via get_cookies)

---

### 2B. Authentication & Session Security

**Quick Scan**:
```
batch([
  get_cookies,
  eval({code: "JSON.stringify({protocol: location.protocol, secureContext: isSecureContext})"})
])
```

**Approach 1 — Cookie Security Audit**:
```
1. get_cookies → examine ALL cookies
2. Check each cookie for:
   - HttpOnly: true? (prevents XSS stealing it)
   - Secure: true? (only sent over HTTPS)
   - SameSite: "Strict" or "Lax"? (CSRF protection)
   - Path: scoped correctly?
   - Expiration: reasonable? (long-lived session = risk)
3. eval({code: "document.cookie"}) → shows only non-HttpOnly cookies
   Compare with get_cookies result → difference = properly protected cookies
```

**Approach 2 — Session Management Testing**:
```
1. get_cookies → capture current session tokens
2. Open new_tab with private/incognito URL of the app
3. Compare: does the session leak? Can you access authenticated content?
4. eval({code: "fetch('/api/user/profile').then(r=>r.json()).then(d=>JSON.stringify(d))"})
   → Check if API requires auth or returns data without session
```

**Approach 3 — Token Exposure Check**:
```
1. get_network → check ALL requests for tokens in URLs (NEVER put tokens in URLs)
2. search_network_bodies({query:"token"}) → find where tokens appear in responses
3. search_network_bodies({query:"api_key"}) → check for exposed API keys
4. get_storage → check if tokens stored in localStorage (vulnerable to XSS)
5. eval({code: "JSON.stringify(performance.getEntriesByType('resource').map(r=>r.name).filter(n=>n.includes('token')||n.includes('key')))"})
   → check if tokens in resource URLs
```

---

### 2C. Data Exposure / Information Leakage

**Quick Scan**:
```
batch([
  get_html({selector:"body"}),
  get_network({only_failures:false}),
  eval({code: "JSON.stringify(Object.keys(window).filter(k => !['location','chrome','ozone'].includes(k) && typeof window[k] === 'object' && window[k] !== null).slice(0,30))"})
])
```

**Approach 1 — Hidden Data in DOM**:
```
1. get_html → search for HTML comments containing sensitive info: <!-- API key: ... -->
2. eval({code: "document.querySelectorAll('[type=hidden]').forEach(e => console.log(e.name, e.value))"})
   → check hidden form fields for tokens, user IDs, internal data
3. eval({code: "document.querySelectorAll('script[type=\"application/json\"]').forEach(s => console.log(s.textContent.slice(0,500)))"})
   → check JSON-LD and hydration data for over-exposure
4. get_html({selector:"head"}) → check meta tags for internal info
```

**Approach 2 — API Response Over-Exposure**:
```
1. get_network → list all API calls
2. search_network_bodies({query:"email"}) → check if emails exposed
3. search_network_bodies({query:"password"}) → check for password hashes
4. search_network_bodies({query:"ssn"}) or search for any PII patterns
5. For each API: does the response contain MORE fields than the UI displays?
   → Over-fetching = data exposure risk
```

**Approach 3 — Source Map / Debug Info Exposure**:
```
1. eval({code: "document.querySelectorAll('script[src]').forEach(s => fetch(s.src+'.map').then(r=>{if(r.ok)console.log('SOURCE MAP EXPOSED: '+s.src+'.map')}).catch(()=>{}))"})
   → Check if source maps are publicly accessible (they expose full source code)
2. get_console → check for debug logging left in production
3. eval({code: "typeof __REDUX_DEVTOOLS_EXTENSION__ !== 'undefined'"})
   → Redux devtools enabled in prod = state exposure
```

---

### 2D. CORS & Cross-Origin Issues

**Approach — CORS Audit**:
```
1. get_network → look at all cross-origin requests
2. eval({code: "fetch('https://api.example.com/data', {credentials:'include'}).then(r=>({status:r.status, cors: r.headers.get('access-control-allow-origin')})).then(d=>JSON.stringify(d))"})
   → Test if API allows credentialed cross-origin requests
3. Check for: Access-Control-Allow-Origin: * WITH credentials (security vulnerability)
4. search_network_bodies({query:"access-control"}) → find CORS headers in responses
```

---

### 2E. Mixed Content & Transport Security

**Approach — HTTPS Audit**:
```
1. eval({code: "JSON.stringify({protocol: location.protocol, secure: isSecureContext})"})
2. get_network → look for http:// requests on an https:// page (mixed content)
3. eval({code: "document.querySelectorAll('[src^=\"http:\"]').forEach(e => console.log('MIXED:', e.tagName, e.src))"})
   → Find mixed content resources (images, scripts, iframes loaded over HTTP)
4. eval({code: "document.querySelectorAll('a[href^=\"http:\"]').length"})
   → Count insecure links
5. get_cookies → check Secure flag on all cookies
```

---

## 3. Performance Analysis

### 3A. Page Load Performance

**Quick Scan** (ONE call):
```
performance_trace → Web Vitals (LCP, FCP, CLS) + resource count + transfer size + long tasks
```

**Approach 1 — Waterfall Analysis**:
```
1. performance_trace → get overview metrics
2. get_load_timeline → full resource waterfall (top 30 by load order)
   → Look for: render-blocking resources, slow DNS, large files, long TTFB
3. eval({code: "JSON.stringify(performance.getEntriesByType('resource').sort((a,b)=>b.duration-a.duration).slice(0,10).map(r=>({name:r.name.slice(-60), duration:Math.round(r.duration), size:r.transferSize, type:r.initiatorType})))"})
   → Top 10 slowest resources
```

**Approach 2 — Network Throttle Test**:
```
1. network_throttle({preset:"slow-3g"}) → simulate slow connection
2. reload → full page load on 3G
3. performance_trace → check how metrics degrade
4. screenshot → see what user sees on slow connection
5. network_throttle({preset:"none"}) → restore
```

**Approach 3 — Critical Path Analysis**:
```
1. eval({code: "JSON.stringify(performance.getEntriesByType('resource').filter(r=>r.renderBlockingStatus==='blocking').map(r=>({name:r.name.slice(-80), type:r.initiatorType, duration:Math.round(r.duration)})))"})
   → Find render-blocking resources
2. get_html({selector:"head"}) → check for synchronous scripts without async/defer
3. eval({code: "document.querySelectorAll('link[rel=stylesheet]:not([media=print])').length"})
   → Count render-blocking stylesheets
```

**Pattern Recognition**:
| Symptom | Likely Cause | Tool Chain |
|---------|-------------|------------|
| LCP > 2.5s | Large hero image, slow API, render-blocking CSS | `get_load_timeline` → find the LCP resource |
| FCP > 1.8s | Synchronous JS in head, large CSS, slow server | `get_html({selector:"head"})` → check blocking resources |
| CLS > 0.1 | Images without width/height, dynamic content injection | `screenshot` at intervals during load |
| Long Tasks > 50ms | Heavy JS computation, large DOM manipulation | `eval` for `performance.getEntriesByType('longtask')` |

---

### 3B. Memory Leaks

**Approach — Memory Profile**:
```
1. heap_snapshot_summary → baseline (used/total/limit MB, DOM node count)
2. Interact with the page (navigate, open/close dialogs, scroll)
3. heap_snapshot_summary → check growth
4. Repeat 3-5 times → if memory keeps growing, leak detected
5. eval({code: "document.querySelectorAll('*').length"}) → DOM node count
   → Compare before/after: growing node count = detached DOM nodes leaking
```

---

## 4. Accessibility Auditing

### 4A. WCAG Compliance Check

**Quick Scan**:
```
get_accessibility_tree({max_depth:4, max_nodes:100}) → see the a11y tree structure
```

**Approach 1 — Structured A11y Audit**:
```
1. get_accessibility_tree → check for proper roles, names, states
2. Look for:
   - Buttons/links without names (""): screen readers can't announce them
   - Images without alt text
   - Form inputs without labels
   - Missing landmark regions (main, nav, banner)
3. check_contrast({selector:"body p"}) → test body text contrast
4. check_contrast({selector:"h1"}) → test heading contrast
5. check_contrast({selector:".button"}) → test interactive element contrast
   Now walks up parent chain for transparent backgrounds
```

**Approach 2 — Keyboard Navigation Test**:
```
1. diagnose → get refs
2. press_key({key:"Tab"}) → start tabbing through the page
3. eval({code: "document.activeElement.tagName + ' ' + document.activeElement.textContent?.slice(0,50)"})
   → check what has focus after each tab
4. Repeat: press_key Tab → eval activeElement → check focus order is logical
5. Look for: focus traps, skipped elements, invisible focus indicators
```

**Approach 3 — Screen Reader Simulation**:
```
1. get_accessibility_tree({max_depth:6, max_nodes:500}) → full tree
2. Check: does the tree tell a coherent story when read top-to-bottom?
3. eval({code: "document.querySelectorAll('[aria-hidden=true]').length"})
   → check for hidden elements (should be intentional)
4. eval({code: "document.querySelectorAll('[role]').forEach(e => console.log(e.role, e.getAttribute('aria-label') || e.textContent?.slice(0,50)))"})
   → verify ARIA roles have proper labels
```

---

## 5. Network Debugging

### 5A. API Failures

**Quick Scan**:
```
diagnose → failedRequests shows all 4xx/5xx responses with response bodies
```

**Approach 1 — API Error Deep Dive**:
```
1. get_network({only_failures:true}) → all failed requests with response bodies
2. For each failure:
   - Status 401/403: auth issue → check cookies, check Authorization header
   - Status 404: wrong URL → compare with docs/expected endpoint
   - Status 500: server error → read response body for stack trace
   - Status 0/ERR: network error → check CORS, check if server is up
3. search_network_bodies({query:"error"}) → find error messages in API responses
```

**Approach 2 — Request/Response Inspection**:
```
1. get_network({url_contains:"/api/"}) → all API calls
2. For suspicious call:
   search_network_bodies({query:"the field name"}) → find which request carries it
3. eval({code: "fetch('/api/endpoint').then(r=>r.headers.get('content-type')+' '+r.status).then(console.log)"})
   → manually test an endpoint
```

**Approach 3 — Error State Simulation**:
```
1. mock_network({url_pattern:"/api/data", status_code:500, response_body:"{\"error\":\"Server Error\"}"})
   → simulate server failure
2. reload → see how app handles the error
3. screenshot → capture error state UI
4. mock_network({url_pattern:"/api/data", status_code:200, response_body:"{}"})
   → simulate empty data response
5. reload → screenshot → check empty state UI
```

---

### 5B. Caching Issues

**Approach — Cache Audit**:
```
1. eval({code: "caches.keys().then(k=>JSON.stringify(k))"}) → list Cache API caches
2. eval({code: "navigator.serviceWorker?.controller?.scriptURL"}) → check if SW controls page
3. reload({bypass_cache:true}) → hard reload without cache
4. Compare: does the bug disappear with cache bypass? → stale cache is the cause
5. eval({code: "caches.keys().then(async keys => { for(const k of keys) await caches.delete(k); return 'cleared'; })"})
   → programmatically clear all caches
```

---

## 6. Cross-Browser / Responsive Testing

**Approach — Multi-Viewport Sweep**:
```
1. screenshot → desktop baseline
2. emulate_device({device:"mobile"}) → screenshot → mobile view
3. emulate_device({device:"tablet"}) → screenshot → tablet view
4. emulate_device({device:"reset"}) → restore

For each viewport:
  - diagnose → check if interactive elements are still accessible
  - get_styles({selector:".nav"}) → check if responsive CSS kicked in
  - scroll({direction:"down", amount:2000}) → screenshot → check below-fold content
```

---

## 7. Regression Testing

### 7A. Before/After Verification

**Approach — Visual Regression**:
```
1. screenshot → save dataUrl as "before"
2. Make the code change
3. Wait for HMR/rebuild (3s)
4. visual_diff({before_dataUrl:"..."}) → get pixel diff percentage + highlighted image
5. If 0%: change didn't take effect
6. If < 5%: targeted change (likely correct)
7. If > 20%: major visual change (review carefully)
```

### 7B. Automated Replay

**Approach — Record and Replay**:
```
1. record_actions → start recording
2. Perform the full user flow manually (Claude clicks through)
3. record_actions({stop:true}) → get the action list
4. Make the fix
5. reload → replay_actions({actions:[...]}) → automated replay
6. screenshot → verify the flow still works
```

---

## 8. Multi-Page / Multi-Product Spot Check

**Approach — Sweep Pattern**:
```
For each URL in the check list:
  1. new_tab({url:"..."}) → open the page
  2. wait_for({selector:"main"}) → wait for content
  3. diagnose → check for errors, failed requests
  4. screenshot → capture for comparison
  5. [run specific checks for that page type]
  6. close_tab → clean up

After all pages: compare screenshots, review error logs.
```

---

## 9. Decision Matrix: Which Approach for Which Problem?

| Problem Type | Quick (< 30s) | Standard (1-3 min) | Deep (5+ min) |
|-------------|---------------|---------------------|---------------|
| **Visual bug** | `batch([screenshot, get_styles])` | inject_css → screenshot loop | annotate + get_element_rect + visual_diff |
| **Broken button** | `diagnose` (check errors) | click → get_console → get_network | record_actions → replay → state tracking |
| **Wrong data** | `get_network({url_contains:"/api/"})` | eval to read state + search_network_bodies | Storage audit + state diff between pages |
| **XSS check** | `diagnose` (cspBlocksEval?) | fill + get_html (check reflection) | DOM analysis + API response scanning |
| **Auth check** | `get_cookies` | Cookie flags + token exposure check | Session management + CORS + mixed content |
| **Slow page** | `performance_trace` | + get_load_timeline + resource analysis | Network throttle + critical path + memory |
| **A11y audit** | `get_accessibility_tree` | + check_contrast on key elements | Full keyboard nav + screen reader sim |
| **API failure** | `diagnose` (failedRequests) | get_network + search_network_bodies | mock_network for error state testing |
| **Regression** | `visual_diff` | + record_actions/replay | Multi-viewport sweep + full replay |

---

## 10. Tool Selection by CSP Level

When `diagnose` reports `cspBlocksEval: true`, adjust your approach:

### On CSP-Strict Sites (GitHub, YouTube, MDN):

| Instead of eval for... | Use this |
|------------------------|----------|
| Reading DOM state | `get_html({selector:"..."})` — parse the HTML |
| Reading CSS values | `get_styles({selector:"..."})` |
| Reading page text | `get_page_text` |
| Reading element position | `get_element_rect({selector:"..."})` |
| Checking forms | `snapshot` — shows all input values |
| Checking cookies | `get_cookies` (extension API, not affected by CSP) |
| Checking storage | `get_storage` (extension API) |
| Reading console | `get_console` (pre-injected recorder, CSP-immune) |
| Reading network | `get_network` (pre-injected recorder, CSP-immune) |
| Searching responses | `search_network_bodies({query:"..."})` |
| Testing interactions | `click`/`fill` with refs (CSP-immune) |

### Security Testing on CSP-Strict Sites:

CSP blocking eval is actually a GOOD security signal — it means:
- Page-level XSS is harder (eval/innerHTML blocked)
- Still check: reflected content in HTML (get_html), cookie flags (get_cookies), API exposure (get_network)
- Still check: HTTP vs HTTPS mixed content (get_network)
- Still check: tokens in URLs (get_network)

---

## 11. Investigation Anti-Patterns (Don't Do These)

| Anti-Pattern | Why It's Bad | Do This Instead |
|-------------|-------------|-----------------|
| Calling tools one at a time | Wastes 2-3s per call | Use `batch` for independent calls |
| Guessing CSS values | You'll be wrong 50% of the time | `get_styles` reads the actual computed values |
| Retrying eval on CSP-strict sites | It will NEVER work | Switch to get_html/get_styles/get_page_text |
| Batching debugger tools | Second one always fails | Run debugger tools sequentially |
| navigate to Google for research | Destroys your app tab | `new_tab` for research, `close_tab` after |
| screenshot without get_styles | You see the bug but not the values | Always `batch([screenshot, get_styles])` |
| Claiming fix works without screenshot | The fix might not have applied | ALWAYS screenshot after code edit |
| Ignoring diagnose output | Missing errors you could have caught | Read consoleErrors + failedRequests |
| Clearing state without capturing first | Can't compare before/after | Always capture state before clearing |
| Testing only desktop viewport | Mobile bugs are common | `emulate_device` sweep after fix |
