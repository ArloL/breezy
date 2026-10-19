// Each row through a target's own input: stock Firefox on this Mac, driven by tools/oskeys; Playwright only opens the
// page and reads it. Takes over the keyboard and focus for minutes; needs Accessibility for the terminal.
//   node --test scenarios/platform/native.e2e.ts         RECORD=1 keeps each trace in scenarios/traces/
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firefox, type BrowserContext } from "playwright-core";
import { buildSite, serveStatic } from "../browser.ts";
import { buildOskeys, oskeys, restoreSourceOnExit, sleep, trusted } from "./oskeys.ts";
import { rows, type Native } from "./rows.ts";
import type { Trace } from "../../web/record.ts";

const root = new URL("../..", import.meta.url).pathname;
const PORT = 58564;
const FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox";
const ABC = "com.apple.keylayout.ABC";
if (process.platform === "darwin") buildOskeys();
const skip = process.platform !== "darwin" ? "macOS only"
  : !existsSync(FIREFOX) ? "no Firefox in /Applications"
  : !trusted() && "the terminal lacks Accessibility permission";

let site: ReturnType<typeof serveStatic>, context: BrowserContext, pid: number, profile: string, source: string;

before(async () => {
  if (skip) return;
  source = oskeys(["source"]);
  restoreSourceOnExit(source);
  const dir = join(root, "build", "web-platform");
  buildSite(dir);
  site = serveStatic(dir, PORT);
  profile = mkdtempSync(join(tmpdir(), "breezy-platform-firefox-"));
  context = await firefox.launchPersistentContext(profile, {
    channel: "moz-firefox", headless: false, viewport: { width: 1200, height: 800 },
    // Playwright's default keeps Firefox's window focused whatever happens, which hides every bug of focus leaving it
    firefoxUserPrefs: { "focusmanager.testmode": false },
  });
  // the test's Firefox, not the person's: the oldest process started with this profile
  pid = Number(execFileSync("pgrep", ["-o", "-f", profile], { encoding: "utf8" }).trim());
});

after(async () => {
  await context?.close();
  site?.close();
  if (profile) rmSync(profile, { recursive: true, force: true });
});

for (const row of rows) {
  const drive = row.native["firefox-mac"];
  if (!drive) continue;
  test(`${row.id}-${row.variant} on firefox-mac: ${row.title}`, { skip, todo: row.open.includes("firefox-mac") }, async () => {
    const keyboard = row.source ?? ABC;
    // before the edit opens: Firefox takes a new source only once it comes to the front again
    oskeys(["source", keyboard]);
    oskeys(["away", String(pid)]);
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`http://localhost:${PORT}/?demo=edit&record`);
    await page.waitForFunction(() => "breezyRecord" in window && (document.activeElement as HTMLElement | null)?.isContentEditable);
    await sleep(300);
    await page.evaluate(([row, variant, keyboard]) => (window as any).breezyRecord.start({ row, variant, target: "firefox-mac", source: "native", keyboard }), [row.id, row.variant, keyboard]);
    const n: Native = { pid, oskeys: (args) => oskeys(args, pid), wait: sleep };
    try {
      await drive(n);
    } finally {
      oskeys(["source", ABC]);
    }
    const trace: Trace = await page.evaluate(() => (window as any).breezyRecord.stop());
    const name = `${row.id}-${row.variant}`;
    mkdirSync(join(root, "build/platform"), { recursive: true });
    writeFileSync(join(root, "build/platform", `${name}-firefox-mac.json`), JSON.stringify(trace, null, 2));
    if (process.env.RECORD) {
      mkdirSync(join(root, "scenarios/traces/firefox-mac"), { recursive: true });
      writeFileSync(join(root, "scenarios/traces/firefox-mac", `${name}.json`), JSON.stringify(trace, null, 2) + "\n");
    }
    assert.equal(row.expect(trace.before, trace.after), null);
  });
}
