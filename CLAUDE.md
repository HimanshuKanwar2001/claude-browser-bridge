# Claude Code Browser Bridge

## Performance Rules (MUST follow)

1. **Start with `diagnose`** — returns snapshot + errors + network + API responses in ONE call. Never call `snapshot`, `get_console`, `get_network` separately when investigating a page.
2. **Use `batch`** for independent calls — e.g. `batch([{name:"get_cookies"}, {name:"get_storage"}])` instead of two sequential calls.
3. **Pin with `select_tab` once**, then stop passing `tab_id` — the pin persists across all calls.
4. **Use `get_page_info`** for quick checks (just errors + failed requests, no snapshot).
5. **Use `new_tab` for research** — never navigate away from the app tab.
6. **Use `eval` for state inspection** — reading React/Redux state, checking variables. Faster than DOM scraping.

## Anti-patterns (NEVER do these)

- Calling `snapshot` then `get_console` then `get_network` then `screenshot` sequentially — use `diagnose` or `batch`
- Calling `list_tabs` before every action — the pinned tab persists
- Using `navigate` on the app tab to open docs — use `new_tab`
- Calling `get_page_text` to read the whole page when you need specific data — use `eval`
- Calling `get_page_text` on the whole page when you need specific data — use `eval`

## Parallel Investigation (MUST follow when debugging)

When investigating ANY bug, gather all context in ONE parallel batch — not sequential calls:

```
batch([
  {name: "diagnose"},
  {name: "eval", arguments: {code: "<read app state>"}},
  {name: "get_styles", arguments: {selector: "<problem element>"}},
])
```

For multi-page/multi-tab investigations, open tabs and read them in parallel:
```
batch([
  {name: "new_tab", arguments: {url: "page1"}},
  {name: "new_tab", arguments: {url: "page2"}},
])
// then:
batch([
  {name: "get_page_text", arguments: {tab_id: TAB1}},
  {name: "get_page_text", arguments: {tab_id: TAB2}},
])
```

Rule: if you're about to make 2+ tool calls that don't depend on each other's results, ALWAYS batch them. Every sequential call wastes 2-3 seconds of model latency.

## Bug Playbook — Learn from Past Fixes

**BEFORE investigating any bug**, read `bug-playbook.md` in this repo. It contains patterns from past debugging sessions — symptoms, root causes, and fixes. If the current bug matches a known pattern, apply the fix directly instead of re-investigating from scratch.

**AFTER fixing any bug**, append a new entry to `bug-playbook.md` with:
```
## Pattern: <short name>
**Symptoms:** <what the user sees / what console/network shows>
**Root cause:** <what was actually wrong>
**How we found it:** <which tools revealed it>
**Fix:** <what we changed>
```

This playbook grows over time. A bug you fix today saves 10 minutes next time a similar bug appears.

## Self-Research When Stuck

When you can't figure out a bug after 2 attempts, **search the web through the bridge** instead of guessing again:

1. Open a new tab with a targeted Google search:
   ```
   new_tab({url: "https://www.google.com/search?q=react+useEffect+infinite+loop+state+dependency"})
   ```
2. Read the search results with `get_page_text`
3. If a Stack Overflow / GitHub issue looks relevant, open it in another new tab and read the solution
4. Close the research tabs when done — never leave them open

**Search query patterns that work:**
- Error message in quotes: `"ChunkLoadError" webpack HMR fix`
- Framework + symptom: `react useEffect infinite render loop`
- Library + version + issue: `axios 401 interceptor suppress console error`
- CSS property + context: `css grid gap not working inside flex container`

Rule: 3 failed fix attempts = MUST search the web before trying again. The answer is almost always on Stack Overflow or in a GitHub issue.

## Visual Bug Fix Workflow (MUST follow for UI/CSS changes)

When the user asks to fix how something looks, or provides target HTML/screenshot:

1. **BEFORE editing code:** Use `batch` to gather everything in parallel:
   ```
   batch([
     {name: "screenshot"},
     {name: "get_styles", arguments: {selector: ".problem-element"}},
     {name: "get_html", arguments: {selector: ".problem-element"}},
     {name: "eval", arguments: {code: "document.querySelector('.problem-element')?.className"}}
   ])
   ```

2. **AFTER every code edit:** IMMEDIATELY take a `screenshot` to verify the change visually. Do NOT claim "this should work" without seeing the screenshot. If the page has HMR, wait 2-3 seconds for the rebuild, then screenshot.

3. **Compare and iterate:** If the screenshot doesn't match what the user asked for:
   - Use `get_styles` again on the specific element to see what CSS actually applied
   - Use `eval` to check if the right CSS class/variable is being set
   - Identify the gap between expected and actual, then fix
   - Screenshot again to verify

4. **For complex visual matching:** When the user provides target HTML:
   - Use `eval` to inject the target HTML into a hidden div and read its computed styles
   - Compare those computed styles against the current element's styles
   - Fix the differences one property at a time, verifying each with `get_styles`

5. **Never guess CSS values.** Use `get_styles` to read the actual computed values. The source code may use Less variables, calc(), or theme tokens that resolve to values you can't predict from reading the source alone.

## Tool Quick Reference (40 tools)

### Core (use these most)
| Tool | When to use |
|---|---|
| `diagnose` | First call on any page — gives you everything |
| `batch` | 2+ independent calls in parallel |
| `select_tab` | Pin a tab once at session start |
| `eval` | Read app state, run JS, extract specific data |
| `click` / `fill` / `hover` | Use refs from `diagnose` snapshot |
| `screenshot` / `full_page_screenshot` | Visual verification |
| `new_tab` / `close_tab` | Research without leaving the app |

### Debugging
| Tool | When to use |
|---|---|
| `get_console` | Full console log history with stacks |
| `get_network` | Full request history with response bodies |
| `get_styles` | CSS computed styles — fonts, colors, spacing, layout |
| `get_storage` / `get_cookies` | Inspect page state |
| `watch_dom_changes` | See what mutates when an action happens |

### Performance & Quality
| Tool | When to use |
|---|---|
| `performance_trace` | Core Web Vitals (LCP, FCP, CLS), load times, long tasks |
| `heap_snapshot_summary` | Memory usage and DOM node count |
| `get_accessibility_tree` | Full a11y tree for WCAG auditing |
| `check_contrast` | Color contrast ratio + AA/AAA pass/fail |

### Emulation & Testing
| Tool | When to use |
|---|---|
| `emulate_device` | Switch between mobile/tablet/desktop viewports |
| `network_throttle` | Test on slow-3g, fast-3g, 4g, or offline |
| `handle_dialog` | Auto-accept/dismiss alert/confirm/prompt |
| `export_pdf` | Save page as PDF |
