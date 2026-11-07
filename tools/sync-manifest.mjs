// Przepisuje manifest.host_permissions ze scope.config.json.
// Without this, modifyHeaders is not permitted to add the header even though the
// rule reads "active". Run it after every change to the host list:
//   node tools/sync-manifest.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, "scope.config.json"), "utf8"));
const manifestPath = join(root, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const origins = new Set();
for (const program of config.programs ?? []) {
  if (program.enabled === false) continue;
  for (const h of program.hosts) {
    origins.add(`*://${h.host}/*`);
    if (h.mode !== "exact") origins.add(`*://*.${h.host}/*`);
  }
}

const next = [...origins].sort();
const prev = manifest.host_permissions ?? [];

const added = next.filter((o) => !prev.includes(o));
const removed = prev.filter((o) => !next.includes(o));

manifest.host_permissions = next;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

console.log(`host_permissions: ${next.length} origins`);
for (const o of added) console.log(`  + ${o}`);
for (const o of removed) console.log(`  - ${o}`);
if (!added.length && !removed.length) console.log("  bez zmian");
console.log("\nTeraz: chrome://extensions -> Reload -> popup -> Diagnostyka.");
