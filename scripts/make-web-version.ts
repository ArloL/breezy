#!/usr/bin/env node
// Writes the site's version.json: its version and every file's SHA-256, which web/sw.js downloads and checks.
//
//   node scripts/make-web-version.mjs _site 2610.0.113
//
// Run it after the last change to the site, as the hashes are of the files as they will be served.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const [dir, version] = process.argv.slice(2);
if (!dir || !version) {
  console.error("usage: make-web-version.mjs <site dir> <version>");
  process.exit(1);
}
// the worker and this file are fetched by the browser and the worker, not kept in a snapshot
const skip = new Set(["sw.js", "version.json"]);
const files = {};
for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())) {
  const path = relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/");
  if (skip.has(path) || path.split("/").some((p) => p.startsWith("."))) continue;
  files[path] = createHash("sha256").update(readFileSync(join(dir, path))).digest("hex");
}
const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(join(dir, "version.json"), `${JSON.stringify({ version, files: sorted }, null, 1)}\n`);
console.log(`version.json: ${version}, ${Object.keys(sorted).length} files`);
