# Test Script: Verify Reload Only Affects Target Tab

## Prerequisites
1. Updated extension installed from `/Users/deqode/Project/chrom-extension/dist`
2. MCP server running (`cd server && npm start`)
3. At least 3 different web pages open in Chrome

## Test Cases

### Test 1: Reload Pinned Tab
**Setup:**
- Open tabs: Tab A (google.com), Tab B (github.com), Tab C (stackoverflow.com)
- Pin Tab B using `select_tab`

**Actions:**
```javascript
// 1. List tabs to see initial state
list_tabs()

// 2. Pin Tab B
select_tab({ tab_id: <tab_b_id> })

// 3. Reload
reload()

// 4. Check service worker console
// Should see: [bridge] reloading tab <tab_b_id> (https://github.com)
```

**Expected Result:**
- ✅ Tab B (github.com) reloads
- ✅ Tab A (google.com) does NOT reload
- ✅ Tab C (stackoverflow.com) does NOT reload
- ✅ Console log shows correct tab ID and URL

### Test 2: Reload Active Tab (No Pin)
**Setup:**
- Open tabs: Tab A (google.com), Tab B (github.com), Tab C (stackoverflow.com)
- No pinned tab (call `select_tab({ clear: true })` if needed)
- Make Tab C the active tab (click on it)

**Actions:**
```javascript
// 1. Clear any pinned tab
select_tab({ clear: true })

// 2. Reload (should target active tab)
reload()

// 3. Check service worker console
// Should see: [bridge] reloading tab <tab_c_id> (https://stackoverflow.com)
```

**Expected Result:**
- ✅ Tab C (stackoverflow.com) reloads
- ✅ Tab A (google.com) does NOT reload
- ✅ Tab B (github.com) does NOT reload

### Test 3: Reload Specific Tab by ID
**Setup:**
- Open tabs: Tab A, Tab B, Tab C

**Actions:**
```javascript
// 1. Get all tab IDs
const tabs = list_tabs()

// 2. Reload Tab A specifically
reload({ tab_id: <tab_a_id> })

// 3. Check console
```

**Expected Result:**
- ✅ Only Tab A reloads
- ✅ Console shows Tab A's ID and URL

### Test 4: Reload with Cache Bypass
**Setup:**
- Open a tab with cached content (e.g., CNN, BBC)
- Pin the tab

**Actions:**
```javascript
// 1. Normal reload
reload({ bypass_cache: false })

// 2. Hard reload
reload({ bypass_cache: true })

// 3. Check console logs
// Should see: bypass_cache: false, then bypass_cache: true
```

**Expected Result:**
- ✅ Only the pinned tab reloads both times
- ✅ Second reload bypasses cache (visible in network tab - all resources re-downloaded)
- ✅ Console logs show correct bypass_cache value

### Test 5: Batch with Reload
**Setup:**
- Open multiple tabs

**Actions:**
```javascript
batch({
  calls: [
    { name: "screenshot", arguments: {} },
    { name: "reload", arguments: {} },
    { name: "wait_for", arguments: { text: "Search" } }
  ]
})
```

**Expected Result:**
- ✅ Only the target tab (pinned or active) is affected
- ✅ No other tabs reload
- ✅ Console shows single reload log entry

## Debugging Failed Tests

### If All Tabs Reload:
1. **Check console logs** - What tab ID is being reloaded?
   ```
   Open chrome://extensions/
   Find "Browser Bridge" → Click "service worker"
   Check for: [bridge] reloading tab X (URL)
   ```

2. **Verify tab resolution** - Is the correct tab being targeted?
   ```javascript
   // Add temp logging to background.js:960
   const tab = await resolveTab(params);
   console.log("Resolved tab:", tab.id, tab.url);
   ```

3. **Check for race conditions** - Are multiple reloads happening?
   ```javascript
   // Count reload calls in a short time
   // If you see 3+ reload logs in <1 second, there's a race condition
   ```

### If Wrong Tab Reloads:
1. **Check targetTabId** - Is the pinned tab still valid?
   ```javascript
   // In service worker console:
   console.log("targetTabId:", targetTabId)
   ```

2. **Check resolveTab logic** - Is it falling back correctly?
   ```javascript
   // Test each fallback:
   // 1. params.tab_id - explicit ID
   // 2. targetTabId - pinned tab
   // 3. active tab - last resort
   ```

### If Error: "No valid tab resolved"
1. **Good!** - The validation is working
2. **Investigate** - Why couldn't a tab be resolved?
   ```javascript
   list_tabs() // Are there any tabs open?
   ```

## Success Criteria

✅ **PASS** if:
- Only the intended tab reloads in all 5 tests
- Console logs show correct tab ID and URL
- No errors in service worker console

❌ **FAIL** if:
- Multiple tabs reload when only one should
- Wrong tab reloads
- No console logs appear (logging broken)
- Errors about "debugger already attached" (unrelated to this fix)

## Next Steps After Testing

### If Tests Pass:
1. Close this issue as resolved
2. Update version to v1.0.1 with this fix
3. Monitor for any similar reports

### If Tests Fail:
1. Collect console logs from failed test
2. Check Chrome version (`chrome://version/`)
3. Test with different Chrome profiles (incognito, different user)
4. Check for extension conflicts (disable all other extensions)
5. File a Chrome bug if the issue is in Chrome's API behavior

## Rollback Plan

If the fix causes new issues:
```bash
cd /Users/deqode/Project/chrom-extension
git checkout HEAD~1 extension/background.js
node build.js
# Reload the extension at chrome://extensions/
```
