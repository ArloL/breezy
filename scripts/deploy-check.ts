#!/usr/bin/env node
// The checks after each deploy (scripts/deploy.py's verify) against the site as built, served here with PHP and a SQLite
// database: they must pass, and fail on a deploy that broke the site (TESTING.md, L8). With the plant half-uploaded, a
// file differs from what was built, as a deploy cut off halfway leaves it. node scripts/deploy-check.ts
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSite } from "../scenarios/browser.ts";
import { planted } from "../web/sync/plant.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const PORT = 58643;
const dir = mkdtempSync(join(tmpdir(), "breezy-deploy-check-")), site = join(dir, "site"), db = join(dir, "sync.db"), config = join(dir, "config.php");
buildSite(site);
execFileSync("php", ["-r", '$db = new PDO("sqlite:" . $argv[1]); $db->exec(file_get_contents($argv[2]));', db, join(root, "server/schema.sql")]);
appendFileSync(config, `<?php return ['dsn' => 'sqlite:${db}'];`);
if (planted("half-uploaded")) appendFileSync(join(site, "app.js"), "\n// cut off\n");
const php = spawn("php", ["-S", `127.0.0.1:${PORT}`, "-t", site], { env: { ...process.env, BREEZY_CONFIG: config }, stdio: "ignore" });
try {
  for (let i = 0; ; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/version.json`).then((r) => r.ok, () => false)) break;
    if (i > 50) throw new Error("php did not serve the site");
    await new Promise((r) => setTimeout(r, 100));
  }
  const version = JSON.parse(readFileSync(join(site, "version.json"), "utf8")) as { files: Record<string, string> };
  // once, not four times: here nothing is on its way
  execFileSync("python3", ["-c", `import json, sys; sys.path.insert(0, "scripts"); import deploy; deploy.ATTEMPTS = 1
v = json.load(open(sys.argv[1])); deploy.verify(v, list(v["files"]))`, join(site, "version.json")],
    { cwd: root, env: { ...process.env, BREEZY_SITE_URL: `http://127.0.0.1:${PORT}`, PYTHONDONTWRITEBYTECODE: "1" }, stdio: "inherit" });
  console.log(`the checks after a deploy pass on the site as built: ${Object.keys(version.files).length} files`);
} catch (e) {
  console.error((e as Error).message.split("\n")[0]);
  process.exitCode = 1;
} finally {
  php.kill();
  rmSync(dir, { recursive: true, force: true });
}
