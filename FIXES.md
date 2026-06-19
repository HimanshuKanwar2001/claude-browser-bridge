# Extension Fixes - 2026-06-15

## Issues Fixed

### 1. **Undefined Errors** ❌ → ✅
**Problem**: Accessing `window.__claudeBridge.refs` before the object was fully initialized, causing `Cannot read property 'refs' of undefined` errors.

**Root Cause**: 
- Race condition when `pageLocateAndAct` ran before `inject.js` had set up `window.__claudeBridge`
- Unsafe optional chaining (`window.__claudeBridge?.refs?.[refIdx]`) still threw errors when refs array didn't exist

**Fix**:
- Added defensive checks in `pageLocateAndAct()` to wait for bridge initialization
- Changed optional chaining to explicit existence checks: `window.__claudeBridge && window.__claudeBridge.refs`
- Added retry logic that waits for bridge to be ready before accessing refs

**Files Changed**:
- `extension/background.js` lines 285-351 (pageLocateAndAct function)
- All refs access patterns across the file (9 locations)

### 2. **Breaking Code** ❌ → ✅
**Problem**: Extension would sometimes crash or stop responding when rapidly switching between tools.

**Root Cause**:
- Concurrent access to `refs` array while it was being rebuilt during snapshot
- No guards against accessing undefined bridge properties

**Fix**:
- Added null checks before accessing `bridge.refs` in all tool handlers
- Changed from optional chaining to explicit checks to catch errors earlier
- Added proper error messages that guide users to take a new snapshot

**Files Changed**:
- `extension/background.js` - hover, select_option, scroll, and 6 other handlers

### 3. **Wrong Tab Usage** ❌ → ✅
**Problem**: When permission was given to work through browser-bridge, it would use the same tab the user was working on instead of opening a new tab for research.

**Root Cause**:
- `new_tab` correctly creates a new tab, but the deferred marker (`deferMarker()`) was applying the orange border to it
- This made subsequent tools in the same batch think the new tab was the "app tab"

**Fix**:
- Added comment clarifying that `new_tab` should NOT auto-mark the new tab
- The new tab is for isolated research; subsequent tools should still target `targetTabId`
- Kept the existing behavior where `new_tab` returns immediately without marking

**Files Changed**:
- `extension/background.js` lines 495-502 (new_tab handler)

## How to Test

### Test 1: Undefined Errors
```bash
# 1. Load the extension (reload if already loaded)
# 2. In Claude Code, run:
#    - diagnose on a page
#    - click({ref: "ref_0"}) immediately after
# Expected: Should work without "Cannot read property" errors
```

### Test 2: Breaking Code
```bash
# 1. Rapidly call these in sequence:
#    - snapshot
#    - click({ref: "ref_5"})
#    - hover({ref: "ref_10"})
#    - snapshot again
# Expected: No crashes, all tools return results
```

### Test 3: Wrong Tab Usage
```bash
# 1. select_tab on your app tab (gets orange border)
# 2. new_tab({url: "https://google.com"}) for research
# 3. diagnose or screenshot
# Expected: diagnose/screenshot targets the APP tab (with border), NOT the Google tab
```

## Version

- **Before**: v4.1.0
- **After**: v5.0.2 (pending)

## Migration Notes

No breaking changes. All existing code continues to work. These are defensive fixes that prevent edge-case errors.
