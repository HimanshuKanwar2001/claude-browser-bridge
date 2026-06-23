# Publishing v6.0.1 to npm

## Current Status

✅ **Git**: Pushed to GitHub
- 3 commits pushed to `version-1.0.0` branch
- Commit: `a81a95f` - CHANGELOG update
- Commit: `d8d5c3d` - Version bump to 6.0.1
- Commit: `6f9656e` - Reload fix with validation and logging

❌ **npm**: Ready to publish but requires authentication

## Steps to Publish to npm

### 1. Login to npm

You need to run this command yourself (requires interactive input):

```bash
cd /Users/deqode/Project/chrom-extension/server
npm login
```

This will prompt for:
- Username
- Password
- Email
- One-time password (if 2FA is enabled)

### 2. Publish the Package

After logging in, publish with:

```bash
npm publish
```

### 3. Verify Publication

Check the package was published:

```bash
npm view claude-browser-bridge
```

You should see:
```
claude-browser-bridge@6.0.1 | MIT | deps: 2 | versions: 7
Connect your live Chrome tabs to Claude Code — 75 tools for debugging...
https://github.com/HimanshuKanwar2001/claude-browser-bridge#readme
```

## What's Being Published

**Package**: `claude-browser-bridge@6.0.1`
**Size**: 62.2 kB (tarball), 198.5 kB (unpacked)
**Files**: 15 files
- `index.js` - MCP server (110.4 kB)
- `bin/cli.js` - CLI entry point
- `extension/` - Chrome extension files (background.js, inject.js, manifest.json, icons, etc.)
- `gen-token.js` - Token generation utility
- `README.md`
- `package.json`

## Version Summary

**v6.0.1** - Bug Fix Release (2026-06-23)

**What's Fixed**:
- `reload` now only affects the target tab (not all tabs)
- Added strict validation for tab.id
- Added debug logging to track reload operations
- Enhanced response with tab URL

**Breaking Changes**: None
**Migration Required**: No - just update the package

## Install Instructions for Users

After publishing, users can install/update with:

```bash
# Fresh install
npm install -g claude-browser-bridge

# Update existing installation
npm update -g claude-browser-bridge

# Or via npx (no install)
npx claude-browser-bridge
```

## Verification Checklist

After publishing:

- [ ] Check npm package page: https://www.npmjs.com/package/claude-browser-bridge
- [ ] Verify version shows 6.0.1
- [ ] Test fresh install: `npm install -g claude-browser-bridge@6.0.1`
- [ ] Run the server: `claude-browser-bridge`
- [ ] Verify extension version in Chrome: should show 6.0.1
- [ ] Test the reload fix with multiple tabs
- [ ] Check service worker console shows reload logs

## Rollback (if needed)

If v6.0.1 has critical issues:

```bash
# Deprecate the version
npm deprecate claude-browser-bridge@6.0.1 "Critical bug, use 6.0.0"

# Or unpublish (within 72 hours)
npm unpublish claude-browser-bridge@6.0.1
```

## Next Steps

1. **You need to**: Run `npm login` then `npm publish` in the server directory
2. **After publishing**: 
   - Update the GitHub release notes
   - Announce the bug fix in any relevant channels
   - Monitor for user feedback on the reload fix
3. **Document**: Add this release to any project tracking/changelog

## Alternative: Publish via CI/CD

If you have GitHub Actions set up with npm token:

```yaml
# .github/workflows/publish.yml
- name: Publish to npm
  run: |
    echo "//registry.npmjs.org/:_authToken=${{ secrets.NPM_TOKEN }}" > ~/.npmrc
    npm publish
```

Then push a git tag:
```bash
git tag v6.0.1
git push origin v6.0.1
```
