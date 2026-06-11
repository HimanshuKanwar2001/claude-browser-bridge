# Claude Code Browser Bridge

## Performance Rules (MUST follow)

1. **Start with `diagnose`** — it returns snapshot + errors + network + API responses in ONE call. Never call `snapshot`, `get_console`, `get_network` separately when investigating a page.
2. **Use `batch`** for independent calls — e.g. `batch([{name:"get_cookies"}, {name:"get_storage"}])` instead of two sequential calls.
3. **Pin with `select_tab` once**, then stop passing `tab_id` — the pin persists across all calls.
4. **Use `get_page_info`** for quick checks (just errors + failed requests, no snapshot) — faster than `diagnose` when you don't need the element list.
5. **Use `new_tab` for research** — never navigate away from the app tab. Open docs/references in a new tab, read them, close them.
6. **Use `eval` for state inspection** — reading React/Redux state, checking variables, calling functions. Faster than DOM scraping.

## Anti-patterns (NEVER do these)

- ❌ Calling `snapshot` then `get_console` then `get_network` then `screenshot` sequentially — use `diagnose` or `batch`
- ❌ Calling `list_tabs` before every action — the pinned tab persists, you don't need to re-find it
- ❌ Using `navigate` on the app tab to open docs — use `new_tab`
- ❌ Calling `get_page_text` to read the whole page when you need specific data — use `eval` to extract exactly what you need
- ❌ Calling `wait_for` with long timeouts when you could just check — `wait_for` polls at 150ms intervals

## Tool Quick Reference (28 tools)

| Tool | When to use |
|---|---|
| `diagnose` | First call on any page — gives you everything |
| `batch` | 2+ independent calls in parallel |
| `select_tab` | Pin a tab once at session start |
| `eval` | Read app state, run JS, extract specific data |
| `click` / `fill` | Use refs from `diagnose` snapshot, not CSS selectors |
| `screenshot` | Visual verification after changes |
| `new_tab` / `close_tab` | Research without leaving the app |
| `get_network` | Only when you need the full request history with bodies |
| `get_console` | Only when you need the full console log history |
