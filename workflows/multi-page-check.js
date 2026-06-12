// Workflow: Multi-page spot check across multiple URLs
// Generic — navigates to each URL, runs a sequence of actions, screenshots each state.
// Define your check as a JSON config or pass URLs on the command line.
//
// Run: node workflows/multi-page-check.js url1 url2 url3
// Or:  node workflows/multi-page-check.js --config check-config.json
//
// Config format:
// [
//   { "url": "https://site.com/page1", "label": "Homepage", "actions": [
//     { "type": "click", "selector": "button.submit" },
//     { "type": "fill", "selector": "#email", "value": "test@test.com" },
//     { "type": "screenshot", "name": "after-fill" },
//     { "type": "wait", "text": "Success" }
//   ]},
//   { "url": "https://site.com/page2", "label": "Dashboard" }
// ]

import { connect } from "./bridge-client.js";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

const OUTPUT = "/tmp/multi-page-check";
mkdirSync(OUTPUT, { recursive: true });

// Parse args
let pages = [];
if (process.argv.includes("--config")) {
  const configPath = process.argv[process.argv.indexOf("--config") + 1];
  pages = JSON.parse(readFileSync(configPath, "utf8"));
} else {
  pages = process.argv.slice(2).map((url, i) => ({ url, label: `page-${i + 1}` }));
}

if (!pages.length) {
  console.log("Usage: node multi-page-check.js url1 url2 url3");
  console.log("   Or: node multi-page-check.js --config check-config.json");
  process.exit(1);
}

const { call, close } = await connect();

console.log(`\n=== Multi-Page Check: ${pages.length} pages ===\n`);

for (const page of pages) {
  console.log(`--- ${page.label || page.url} ---`);

  const tab = await call("new_tab", { url: page.url });
  await new Promise(r => setTimeout(r, 5000));

  // Run actions if defined
  if (page.actions?.length) {
    // Get snapshot for ref-based actions
    const snap = await call("snapshot", { tab_id: tab.tab_id, max_elements: 50 });

    for (const action of page.actions) {
      try {
        switch (action.type) {
          case "click":
            await call("click", { tab_id: tab.tab_id, selector: action.selector, ref: action.ref });
            await new Promise(r => setTimeout(r, action.delay || 1500));
            console.log(`  ✓ click ${action.selector || action.ref}`);
            break;
          case "fill":
            await call("fill", { tab_id: tab.tab_id, selector: action.selector, ref: action.ref, value: action.value });
            console.log(`  ✓ fill ${action.selector || action.ref} = "${action.value}"`);
            break;
          case "wait":
            await call("wait_for", { tab_id: tab.tab_id, text: action.text, selector: action.selector, timeout_ms: action.timeout || 10000 });
            console.log(`  ✓ wait for "${action.text || action.selector}"`);
            break;
          case "screenshot": {
            const sc = await call("screenshot", { tab_id: tab.tab_id });
            const name = action.name || "action-" + page.actions.indexOf(action);
            const filename = `${page.label || "page"}-${name}.png`;
            writeFileSync(`${OUTPUT}/${filename}`, Buffer.from(sc.dataUrl.replace(/^data:image\/png;base64,/, ""), "base64"));
            console.log(`  📸 ${filename}`);
            break;
          }
          case "scroll":
            await call("scroll", { tab_id: tab.tab_id, direction: action.direction || "down", amount: action.amount || 400 });
            console.log(`  ✓ scroll ${action.direction || "down"} ${action.amount || 400}px`);
            break;
          case "eval":
            const result = await call("eval", { tab_id: tab.tab_id, code: action.code });
            console.log(`  ✓ eval → ${result.value?.slice(0, 100)}`);
            break;
        }
      } catch (e) {
        console.log(`  ✗ ${action.type} failed: ${e.message}`);
      }
    }
  }

  // Always take a final screenshot
  const sc = await call("screenshot", { tab_id: tab.tab_id });
  const filename = `${page.label || "page"}-final.png`;
  writeFileSync(`${OUTPUT}/${filename}`, Buffer.from(sc.dataUrl.replace(/^data:image\/png;base64,/, ""), "base64"));
  console.log(`  📸 ${filename}`);

  // Get console errors
  const info = await call("get_page_info", { tab_id: tab.tab_id });
  if (info.errors?.length) {
    console.log(`  ⚠ ${info.errors.length} console error(s)`);
  }
  if (info.failedRequests?.length) {
    console.log(`  ⚠ ${info.failedRequests.length} failed request(s)`);
  }

  await call("close_tab", { tab_id: tab.tab_id });
}

console.log(`\n=== Done. Screenshots: ${OUTPUT} ===`);
console.log("Review: open " + OUTPUT);

close();
