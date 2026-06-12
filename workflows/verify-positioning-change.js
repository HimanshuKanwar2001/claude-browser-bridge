// Workflow: Visual diff after embroidery coordinate changes
// Takes a "before" screenshot, waits for you to make code changes (HMR rebuild),
// then captures "after" and produces a pixel diff highlighting what moved.
// Run: node workflows/verify-positioning-change.js [tab_id]

import { connect } from "./bridge-client.js";
import { writeFileSync } from "node:fs";

const { call, close } = await connect();

// Find the active NeoTailor tab or use the provided tab_id
const tabId = process.argv[2] ? Number(process.argv[2]) : null;
let tab;
if (tabId) {
  tab = { tab_id: tabId };
} else {
  const tabs = await call("list_tabs");
  tab = tabs.find(t => t.url?.includes("customise") || t.url?.includes("m-tailor"));
  if (!tab) {
    console.log("No customization tab found. Open one first, or pass a tab_id as argument.");
    close();
    process.exit(1);
  }
}

console.log(`Using tab ${tab.tab_id}: ${tab.url || tab.title || ""}`);

// Step 1: Capture "before" screenshot
console.log("\n📸 Capturing BEFORE screenshot...");
const before = await call("screenshot", { tab_id: tab.tab_id });
writeFileSync("/tmp/positioning-before.png", Buffer.from(before.dataUrl.replace(/^data:image\/png;base64,/, ""), "base64"));
console.log("  Saved: /tmp/positioning-before.png");

// Step 2: Wait for code change
console.log("\n✏️  Make your code change now. Press Enter when the page has rebuilt (HMR)...");
await new Promise(resolve => {
  process.stdin.once("data", resolve);
});

// Step 3: Wait a moment for HMR to settle
await new Promise(r => setTimeout(r, 3000));

// Step 4: Capture "after" screenshot
console.log("📸 Capturing AFTER screenshot...");
const after = await call("screenshot", { tab_id: tab.tab_id });
writeFileSync("/tmp/positioning-after.png", Buffer.from(after.dataUrl.replace(/^data:image\/png;base64,/, ""), "base64"));
console.log("  Saved: /tmp/positioning-after.png");

// Step 5: Compute visual diff
console.log("🔍 Computing visual diff...");
const diff = await call("visual_diff", { tab_id: tab.tab_id, before_dataUrl: before.dataUrl });
if (diff.diffImage) {
  writeFileSync("/tmp/positioning-diff.png", Buffer.from(diff.diffImage.replace(/^data:image\/png;base64,/, ""), "base64"));
}
console.log(`\n=== RESULT ===`);
console.log(`  Diff: ${diff.diffPercent}% changed (${diff.diffPixels} pixels out of ${diff.totalPixels})`);
console.log(`  Before: /tmp/positioning-before.png`);
console.log(`  After:  /tmp/positioning-after.png`);
console.log(`  Diff:   /tmp/positioning-diff.png`);
console.log(`\nOpen all three: open /tmp/positioning-before.png /tmp/positioning-after.png /tmp/positioning-diff.png`);

if (diff.diffPercent === 0) {
  console.log("\n⚠️  No visual change detected! The code change may not have affected the rendered output.");
} else if (diff.diffPercent < 1) {
  console.log("\n✅ Small change detected — likely a positioning adjustment.");
} else if (diff.diffPercent < 10) {
  console.log("\n⚠️  Moderate change — verify the positioning looks correct.");
} else {
  console.log("\n🔴 Large change — something significant moved. Review carefully.");
}

close();
