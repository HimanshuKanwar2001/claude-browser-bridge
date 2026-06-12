// Workflow: Clear application session/cache state before testing
// Generic — works with any web app. Clears localStorage, sessionStorage,
// and optionally specific keys matching a pattern.
//
// Run: node workflows/clear-session.js [url_or_tab_pattern] [key_pattern]
// Examples:
//   node workflows/clear-session.js localhost:5001           # clear all storage on localhost
//   node workflows/clear-session.js myapp.com session        # clear keys matching "session"
//   node workflows/clear-session.js localhost customiz       # clear keys matching "customiz"

import { connect } from "./bridge-client.js";

const target = process.argv[2] || "localhost";
const keyPattern = process.argv[3] || null;

const { call, close } = await connect();

const tabs = await call("list_tabs");
const tab = tabs.find(t => t.url?.includes(target));
if (!tab) {
  console.log(`No tab found matching "${target}". Open the page first.`);
  close();
  process.exit(1);
}

console.log(`Clearing state on: ${tab.url}`);

const cleared = await call("eval", {
  tab_id: tab.tab_id,
  code: `(() => {
    const pattern = ${keyPattern ? JSON.stringify(keyPattern) : "null"};
    const cleared = { localStorage: [], sessionStorage: [] };
    for (const [storeName, store] of [["localStorage", localStorage], ["sessionStorage", sessionStorage]]) {
      if (pattern) {
        for (let i = store.length - 1; i >= 0; i--) {
          const k = store.key(i);
          if (k.includes(pattern)) { cleared[storeName].push(k); store.removeItem(k); }
        }
      } else {
        cleared[storeName] = Array.from({length: store.length}, (_, i) => store.key(i));
        store.clear();
      }
    }
    return JSON.stringify(cleared);
  })()`
});

console.log("Cleared:", cleared.value);

await call("reload", { tab_id: tab.tab_id, bypass_cache: true });
console.log("✓ Reloaded with clean state");

close();
