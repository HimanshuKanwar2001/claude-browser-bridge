# Privacy Policy — Claude Code Browser Bridge

**Last updated:** June 11, 2026

## What this extension does

Claude Code Browser Bridge connects your local Claude Code CLI tool to your Chrome browser for AI-assisted debugging and development. All communication happens locally between the extension and a server running on your own machine (localhost:8787).

## Data collection

**We do not collect, store, transmit, or sell any user data.** Specifically:

- No personal information is collected
- No browsing history is tracked or stored
- No analytics or telemetry is sent to any external server
- No cookies are read for advertising purposes
- No data leaves your local machine

## How the extension works

- The extension communicates exclusively with a local WebSocket server on `ws://localhost:8787` running on your own computer
- Console logs and network requests are recorded in-page memory buffers that exist only in your browser's RAM and are cleared on page reload
- Screenshots are captured locally and sent only to your local Claude Code session
- Authentication between the extension and the local server uses a token generated on your machine and stored only on your machine

## Permissions explained

| Permission | Why it's needed |
|---|---|
| `activeTab` | To interact with the tab you're debugging |
| `scripting` | To inject the console/network recorder and execute debugging commands |
| `tabs` | To list and manage browser tabs |
| `tabGroups` | To visually mark which tab is being debugged |
| `storage` | To persist the pinned tab selection across service worker restarts |
| `cookies` | To read cookies for debugging purposes (sensitive values are redacted) |
| `<all_urls>` | To work on any website you need to debug |

## Third-party services

This extension does not communicate with any third-party services. All functionality is local.

## Contact

For questions about this privacy policy:
- Email: himanshukanwar2001@gmail.com
- GitHub: https://github.com/HimanshuKanwar2001/claude-browser-bridge
