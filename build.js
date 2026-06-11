import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, extname } from "node:path";
import { minify } from "terser";

const SRC = "extension";
const DIST = "dist";
const COPYRIGHT = `/*! Claude Code Browser Bridge v1.0.0 | (c) 2026 Himanshu Kanwar | All rights reserved. Unauthorized copying, modification, or distribution is strictly prohibited. */\n`;

execSync(`rm -rf ${DIST}`);
mkdirSync(DIST, { recursive: true });
mkdirSync(join(DIST, "icons"), { recursive: true });

for (const file of readdirSync(SRC)) {
  if (file === "config.js" || file === "icons" || extname(file) === ".js") continue;
  copyFileSync(join(SRC, file), join(DIST, file));
}

for (const file of readdirSync(join(SRC, "icons"))) {
  if (file.endsWith(".png")) {
    copyFileSync(join(SRC, "icons", file), join(DIST, "icons", file));
  }
}

writeFileSync(join(DIST, "config.js"), COPYRIGHT + `const BRIDGE_TOKEN="auto";\n`);

const terserConfig = {
  compress: { passes: 3, drop_console: false, dead_code: true, collapse_vars: true, reduce_vars: true },
  mangle: { toplevel: true },
  format: { comments: false, semicolons: true },
};

for (const file of readdirSync(SRC)) {
  if (extname(file) !== ".js" || file === "config.js") continue;
  const code = readFileSync(join(SRC, file), "utf8");
  console.log(`Obfuscating ${file} (${code.length} bytes)...`);
  try {
    const result = await minify(code, terserConfig);
    if (result.code) {
      writeFileSync(join(DIST, file), COPYRIGHT + result.code);
      console.log(`  → ${result.code.length} bytes (${Math.round(result.code.length / code.length * 100)}%)`);
    } else {
      throw new Error("No output");
    }
  } catch (e) {
    console.error(`  terser error: ${e.message?.slice(0, 200)}`);
    writeFileSync(join(DIST, file), COPYRIGHT + code);
  }
}

const zipName = "claude-browser-bridge-v1.0.0.zip";
execSync(`cd ${DIST} && zip -r ../${zipName} . -x ".*"`, { stdio: "pipe" });
const zipSize = readFileSync(zipName).length;
console.log(`\nPackaged: ${zipName} (${Math.round(zipSize / 1024)} KB)`);
console.log("Upload at: https://chrome.google.com/webstore/devconsole");
