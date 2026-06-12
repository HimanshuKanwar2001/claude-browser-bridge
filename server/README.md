# claude-browser-bridge

Connect your **real, logged-in Chrome tabs** to Claude Code for AI-assisted debugging with **57 tools** — DOM snapshots, console/network monitoring, performance tracing, CSS live-injection, visual diffs, device emulation, and more.

## Quick Start

```bash
# 1. Install globally (or use npx)
npm install -g claude-browser-bridge

# 2. Generate auth token
claude-browser-bridge init

# 3. Load the Chrome extension
#    → chrome://extensions → Developer mode → Load unpacked → select extension/ folder

# 4. Register with Claude Code
claude mcp add browser-bridge -- npx claude-browser-bridge

# 5. Restart Claude Code and start debugging
```

## How It Works

```
Claude Code ──stdio──► MCP Server ◄──WebSocket──► Chrome Extension ──► Your live tabs
```

The MCP server runs locally. The Chrome extension connects to it over `ws://localhost:8787`. Claude Code talks to the server over stdio. Everything stays on your machine — no data is sent anywhere.

## 57 Tools

| Category | Tools |
|---|---|
| **Core** | `diagnose`, `batch`, `snapshot`, `screenshot`, `full_page_screenshot`, `eval`, `get_page_text`, `get_html` |
| **Interaction** | `click`, `fill`, `hover`, `scroll`, `press_key`, `select_option`, `upload_file` |
| **Navigation** | `navigate`, `new_tab`, `close_tab`, `go_back`, `go_forward`, `reload`, `select_tab`, `list_tabs` |
| **Debugging** | `get_console`, `get_network`, `get_styles`, `get_cookies`, `get_storage`, `get_clipboard`, `watch_dom_changes`, `search_network_bodies` |
| **Performance** | `performance_trace`, `heap_snapshot_summary`, `get_load_timeline` |
| **Accessibility** | `get_accessibility_tree`, `check_contrast` |
| **Emulation** | `emulate_device`, `network_throttle`, `set_geolocation`, `toggle_dark_mode` |
| **Testing** | `visual_diff`, `inject_css`, `mock_network`, `record_actions`, `replay_actions`, `highlight_element` |
| **Productivity** | `save_form_profile`, `load_form_profile`, `save_tab_session`, `restore_tab_session`, `generate_selector`, `get_grouped_console` |
| **Utility** | `get_page_info`, `wait_for`, `handle_dialog`, `export_pdf`, `edit_cookie` |

## CLI Commands

```bash
claude-browser-bridge              # Start the MCP server
claude-browser-bridge init         # Generate auth token
claude-browser-bridge setup        # Print Claude Code registration command
claude-browser-bridge --port 9999  # Use custom WebSocket port
claude-browser-bridge --help       # Show help
```

## Requirements

- Node.js 18+
- Chrome with the Claude Browser Bridge extension loaded
- Claude Code CLI

## License

MIT — Himanshu Kanwar
