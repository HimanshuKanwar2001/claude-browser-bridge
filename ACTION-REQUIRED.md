# 🚀 Action Required: Complete v6.0.1 Release

## ✅ COMPLETED (Automatic)

- [x] Fixed reload bug (strict validation + logging)
- [x] Updated all version numbers to 6.0.1
- [x] Rebuilt extension (`dist/` directory)
- [x] Updated CHANGELOG.md
- [x] Updated bug-playbook.md
- [x] Created test documentation
- [x] Committed all changes to git
- [x] Pushed to GitHub (`version-1.0.0` branch)
- [x] Built distribution package (`claude-browser-bridge-v6.0.1.zip`)

## ⏳ TODO (Requires Your Action)

### 1. Publish to npm (5 minutes)

**You must run these commands yourself** (npm login requires interactive input):

```bash
cd /Users/deqode/Project/chrom-extension/server

# Step 1: Login to npm
npm login
# Enter: username, password, email, 2FA code (if enabled)

# Step 2: Publish the package
npm publish

# Step 3: Verify
npm view claude-browser-bridge
# Should show version 6.0.1
```

📖 **Full guide**: See `NPM-PUBLISH.md`

---

### 2. Test the Fix (10 minutes)

**Reload the extension**:
1. Open Chrome → `chrome://extensions/`
2. Remove old "Browser Bridge" extension
3. Click "Load unpacked"
4. Select: `/Users/deqode/Project/chrom-extension/dist`

**Quick test**:
1. Open 3 different web pages (Google, GitHub, Stack Overflow)
2. In Claude Code:
   ```javascript
   // Pin one tab
   select_tab({ tab_id: <github_tab_id> })
   
   // Reload only that tab
   reload()
   ```
3. **Verify**: Only GitHub reloads, others don't
4. **Check logs**: `chrome://extensions/` → "service worker" → should see:
   ```
   [bridge] reloading tab 12345 (https://github.com)
   ```

📖 **Full test suite**: See `test-reload.md`

---

### 3. Update GitHub Release (Optional, 5 minutes)

Create a GitHub release for v6.0.1:

1. Go to: https://github.com/HimanshuKanwar2001/claude-browser-bridge/releases
2. Click "Create a new release"
3. Tag: `v6.0.1`
4. Title: `v6.0.1 — Reload Fix`
5. Description:
   ```markdown
   ## Bug Fix Release
   
   **Fixed**: Reload affecting all tabs instead of just target tab
   
   ### Changes
   - Added strict validation for tab.id before reload
   - Added debug logging to track reload operations
   - Enhanced response with tab URL
   
   ### Installation
   ```bash
   npm install -g claude-browser-bridge@6.0.1
   ```
   
   ### Verification
   Check service worker console for reload logs:
   `chrome://extensions/` → "service worker"
   
   See [RELOAD-FIX.md](RELOAD-FIX.md) for details.
   ```
6. Upload: `claude-browser-bridge-v6.0.1.zip`
7. Publish

---

## 📊 Release Status

| Component | Status | Action Required |
|-----------|--------|-----------------|
| Source Code | ✅ Fixed | None |
| Git | ✅ Pushed | None |
| Build | ✅ Complete | None |
| Documentation | ✅ Complete | None |
| **npm** | ⏳ Pending | **YOU: Run `npm publish`** |
| **Testing** | ⏳ Pending | **YOU: Test with 3 tabs** |
| GitHub Release | ⏸️ Optional | Create release page |

---

## 🎯 Success Criteria

You're done when:
- ✅ `npm view claude-browser-bridge` shows version 6.0.1
- ✅ Fresh install works: `npm install -g claude-browser-bridge`
- ✅ Extension shows v6.0.1 in Chrome
- ✅ Reload only affects target tab (not all tabs)
- ✅ Service worker logs show correct tab ID

---

## 📝 Quick Reference

**What was fixed**: Reload was affecting all tabs instead of one  
**How**: Added `typeof tab.id !== 'number'` validation + debug logging  
**Version**: 6.0.0 → 6.0.1  
**Breaking changes**: None  
**Migration**: Just update the package  

**Key files**:
- Fix: `extension/background.js:1267-1276`
- Test: `test-reload.md`
- Details: `RELOAD-FIX.md`
- Summary: `RELEASE-v6.0.1-SUMMARY.md`

---

## ❓ Questions?

**Q: What if npm publish fails?**  
A: See `NPM-PUBLISH.md` → "Debugging Failed Tests"

**Q: What if the bug still happens?**  
A: Check service worker console logs, collect tab IDs, see `test-reload.md`

**Q: Can I skip npm publish?**  
A: Yes, but users won't get the fix until you publish

**Q: How do I rollback?**  
A: See `RELEASE-v6.0.1-SUMMARY.md` → "Rollback Plan"

---

## 🔔 Next Steps After Publishing

1. Monitor npm downloads: https://www.npmjs.com/package/claude-browser-bridge
2. Watch for issue reports in next 48 hours
3. If no issues → close original bug report
4. If issues → see rollback plan

---

## 📞 Support

If you encounter issues:
1. Check `RELOAD-FIX.md` for debugging steps
2. Review service worker console logs
3. Test with Chrome incognito (no other extensions)
4. Check Chrome version compatibility

---

**Ready to publish?** → `cd server && npm login && npm publish`
