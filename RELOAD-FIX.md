# Reload Fix - Single Tab Only

## Problem
User reported that `reload` was refreshing all tabs in Chrome instead of just the target tab.

## Root Cause Analysis
The `chrome.tabs.reload(tabId, options)` API should only reload the specified tab. However, if `tabId` is `undefined` or invalid, Chrome's behavior might be unpredictable.

## Changes Made

### 1. Added Validation (extension/background.js:1267-1276)
```javascript
case "reload": {
  if (!tab || typeof tab.id !== 'number') {
    throw new Error("reload: No valid tab resolved — cannot reload without a target tab ID");
  }
  console.log(`[bridge] reloading tab ${tab.id} (${tab.url}) — bypass_cache: ${Boolean(params.bypass_cache)}`);
  injectedTabs.delete(tab.id);
  await chrome.tabs.reload(tab.id, { bypassCache: Boolean(params.bypass_cache) });
  return { tab_id: tab.id, action: "reload", url: tab.url };
}
```

### 2. What Changed
- **Strict tab validation**: Now checks that `tab.id` is a number (not just truthy)
- **Debug logging**: Logs which tab is being reloaded with its URL
- **Better error message**: Clear error if tab resolution fails
- **Return URL**: Response now includes the URL of the reloaded tab for verification

## How to Test

### 1. Install the Updated Extension
1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `/Users/deqode/Project/chrom-extension/dist` directory
5. Note the extension ID

### 2. Restart the MCP Server
```bash
# Stop the current server (Ctrl+C)
# Then restart it
cd /Users/deqode/Project/chrom-extension/server
npm start
```

### 3. Test the Reload Function

#### Test 1: Reload with Multiple Tabs Open
1. Open 3-4 different web pages in Chrome
2. Use `select_tab` to pin one specific tab
3. Call `reload` 
4. **Expected**: Only the pinned tab should reload
5. **Verify**: Other tabs should remain unchanged

#### Test 2: Reload Without Pinned Tab
1. Open multiple tabs
2. Make one tab active (click on it)
3. Call `reload` without `select_tab`
4. **Expected**: Only the active tab should reload

#### Test 3: Reload with Explicit tab_id
1. Call `list_tabs` to get all tab IDs
2. Call `reload({tab_id: <specific_id>})`
3. **Expected**: Only that specific tab should reload

#### Test 4: Check Debug Logs
1. Open Chrome and go to `chrome://extensions/`
2. Find "Browser Bridge" extension
3. Click "service worker" (or "background page")
4. Check the console for messages like:
   ```
   [bridge] reloading tab 12345 (https://example.com) — bypass_cache: false
   ```

### 4. Reproduce the Original Issue
If you can still reproduce "all tabs reloading":
1. Check the console logs to see which tab ID is being reloaded
2. Verify the tab ID matches the intended target
3. Check if there are multiple reload calls happening

## Debugging Guide

If the issue persists:

### Check 1: Verify resolveTab is working
Add this after line 960 in background.js:
```javascript
const tab = await resolveTab(params);
console.log(`[bridge] resolved tab for ${msg.method}:`, tab.id, tab.url);
```

### Check 2: Check for batch calls
If using the `batch` tool, verify each call has correct parameters:
```javascript
batch({ calls: [
  { name: "reload", arguments: {} }  // This should reload pinned/active tab
]})
```

### Check 3: Verify no duplicate listeners
Search for any other code that might be calling `chrome.tabs.reload`:
```bash
grep -r "tabs.reload" /Users/deqode/Project/chrom-extension/extension/
```

## Possible Causes if Issue Persists

1. **Chrome Extension Bug**: Rare Chrome bug where reload affects all tabs
2. **Extension Conflict**: Another extension interfering with tab management
3. **Race Condition**: Multiple simultaneous reload calls
4. **Service Worker Restart**: Extension service worker restarting mid-operation

## Next Steps

1. Test with the updated extension
2. Check the console logs when reload is called
3. If issue persists, share the console log output
4. Consider adding a delay between the validation and the reload call
5. Test with Chrome's native `chrome.tabs.reload()` in the console to rule out Chrome bugs

## Files Modified
- `extension/background.js` (lines 1267-1276)
- Built to `dist/background.js`
- Packaged in `claude-browser-bridge-v1.0.0.zip`

## Version
- Fix applied: 2026-06-23
- Build version: v1.0.0
