# Chrome Web Store Listing

## Name
Claude Code Browser Bridge

## Short Description (132 chars max)
Connect your live Chrome tabs to Claude Code for AI-assisted debugging — console monitoring, DOM snapshots, network inspection & more.

## Detailed Description

**Bridge your real browser to Claude Code — debug live, logged-in sites with AI assistance.**

Claude Code Browser Bridge connects your actual Chrome tabs (with all your logins, sessions, and state intact) to your local Claude Code CLI. No separate debugging browser, no re-logging-in, no new tabs opening unexpectedly.

**28 built-in tools including:**

- **diagnose** — get DOM snapshot + console errors + failed network requests + API responses in a single call
- **snapshot** — ref-tagged interactive elements for reliable click/fill targeting  
- **get_console** — continuous console log recording with error stack traces
- **get_network** — fetch/XHR monitoring with response bodies and header inspection
- **screenshot** — visual verification of the current page state
- **click / fill / hover** — interact with page elements using stable refs
- **select_tab** — pin a target tab with visual markers (orange border + tab group)
- **eval** — run JavaScript in the page context for state inspection
- **batch** — execute multiple tool calls in parallel for speed

**Key features:**
- Works on your REAL browser profile with all logins intact
- Visual tab marking so you always know which tab AI is driving
- Continuous console/network recording from page load
- CAPTCHA detection — asks you to solve manually instead of failing silently
- Multi-session support — multiple Claude Code sessions share one bridge
- No data leaves your machine — everything runs on localhost

**How it works:**
1. Install this extension
2. Register the MCP server in Claude Code: `claude mcp add browser-bridge -- npx claude-browser-bridge`
3. Start debugging — Claude Code can now see and interact with your live tabs

**Requirements:**
- Claude Code CLI (https://claude.ai/code)
- Node.js 18+

## Category
Developer Tools

## Language
English
