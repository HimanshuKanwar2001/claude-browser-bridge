# Claude Code Browser Bridge

Connects your **real, logged-in Chrome tabs** to local Claude Code — no separate
debugging Chrome, no re-logging-in, no new tabs. A Chrome extension talks to a
local MCP server over `ws://localhost:8787`; Claude Code talks to that server
over stdio.

```
Claude Code ──stdio──► MCP server (server/index.js) ◄──WebSocket──► Chrome extension ──► your live tab
```

## Setup (one time)

1. **Install deps**:
   ```sh
   cd server && npm install
   ```
2. **Generate the auth token** (writes `server/.bridge-token` + `extension/config.js`):
   ```sh
   node gen-token.js
   ```
3. **Load the extension**: open `chrome://extensions`, enable **Developer mode**,
   click **Load unpacked**, select the `extension/` folder. This install is your
   one-time "allow". (After pulling code changes or regenerating the token,
   click the ⟳ reload button on the extension card.)
4. **Register the MCP server** (already done on this machine):
   ```sh
   claude mcp add --scope user browser-bridge -- node /Users/deqode/Project/chrom-extension/server/index.js
   ```
5. Restart Claude Code, open the site you're debugging in Chrome, and ask Claude
   to use the browser tools. Claude Code launches the server automatically; the
   extension auto-connects within a few seconds (click the extension icon to see
   connection status).

## Tools exposed to Claude

| Tool | What it does |
|---|---|
| `list_tabs` | List open tabs (id, title, url; the pinned target has `selected: true`) |
| `select_tab` | Pin a tab as the sticky target for all tools and visually mark it — orange border + "Claude Code" badge on the page, 🤖 prefix in the tab title. `clear=true` unpins. The marker also auto-follows whichever tab a tool call touches, and is hidden during screenshots |
| `snapshot` | Ref-tagged list of visible interactive elements (`ref_12 <button> "Sign in"`) — the reliable way to pick targets for click/fill |
| `get_page_text` | URL, title, visible text of the tab |
| `get_html` | outerHTML of a selector (or whole document) |
| `wait_for` | Poll until a selector and/or text appears — use after actions on SPAs |
| `click` | Click by snapshot `ref` (preferred) or CSS selector; auto-waits up to 5s for the element |
| `fill` | Fill input/textarea/contenteditable by `ref` or selector (fires input/change for React etc.); auto-waits |
| `eval` | Run JS in the page's main world |
| `get_console` | Console logs, uncaught errors **with stack traces**, unhandled rejections — recorded continuously since page load |
| `get_network` | fetch/XHR requests: method, url, status, duration, redacted request headers, response bodies for failures. Filters: `url_contains`, `only_failures` |
| `screenshot` | PNG of the visible tab area (returned as an image Claude can see) |
| `navigate` | Navigate the *current* tab (never opens a new one) |

All tools default to the tab pinned with `select_tab`, falling back to the
**active tab**; pass `tab_id` (from `list_tabs`) to target another tab
explicitly. The 🤖 title prefix makes the driven tab identifiable in the tab
strip even among several tabs of the same site.

## Design notes

- **No `chrome.debugger`** — console/network history comes from a tiny
  `world: "MAIN"` content script (`extension/inject.js`) that wraps `console.*`,
  `fetch` and `XMLHttpRequest` into capped 500-entry buffers on the page. No
  yellow "is being debugged" banner, and history exists *before* Claude asks.
  If a tab predates the extension install, the background worker self-heals by
  injecting the recorder on first use (history starts from that moment).
- **Refs over selectors** — `snapshot` stores live element references in the
  page (`window.__claudeBridge.refs`); `click`/`fill` resolve `ref_N` against
  them. Refs go stale on navigation; the error message tells Claude to
  re-snapshot.
- **Auth handshake** — the extension must present the shared secret from
  `extension/config.js` as its first WebSocket message; the server checks it
  against `server/.bridge-token` and drops unauthenticated connections within
  3s. Regenerate anytime with `node server/gen-token.js` (then reload the
  extension).
- **MV3 keepalive** — 20s WebSocket pings keep the service worker alive while
  connected; a 30s `chrome.alarms` heartbeat revives it (and reconnects) if
  Chrome kills it.
- The bridge binds to `127.0.0.1` only. Request headers like `Authorization`
  and `Cookie` are redacted before recording; response bodies are only captured
  for failed (>=400) requests, capped at 2KB.

## Security caveats

- `host_permissions: <all_urls>` is broad. Once you know which domains you
  debug, scope it down in `extension/manifest.json`.
- `eval` runs arbitrary JS in your pages — this is a personal dev tool; don't
  expose port 8787 or share the token files.

## Roadmap (from review)

- Tier 2: combined `get_snapshot` diagnostic (console + network + URL in one
  call), `wait_for_idle`/`wait_for_navigation`, lightweight performance timings.
- Tier 3: richer popup status (buffer counts, last command), re-inject on
  `webNavigation.onCommitted`, source-map resolution for stacks.
