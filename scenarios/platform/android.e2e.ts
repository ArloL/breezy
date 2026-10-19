// Each row through Android's own input: Chrome on the emulator, with tools/breezy-ime as its keyboard making the calls
// a keyboard makes. A real touch opens each editor's keyboard, which DevTools' focus alone does not.
//   MISE_ENV=android mise exec -- node scripts/android.ts, then
//   MISE_ENV=android mise exec -- node --test --test-force-exit scenarios/platform/android.e2e.ts      RECORD=1 keeps each
// trace; Playwright's connection to the device keeps the run from ending by itself, as in browsers.e2e.ts
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { _android, type AndroidDevice, type BrowserContext, type Page } from "playwright-core";
import { buildSite, EMULATOR_TCP, EmulatorConsole, launchAndroidChrome, serveStatic, Touchscreen, WEB } from "../browser.ts";
import { broadcastArgs, runRow } from "./harness.ts";
import { sleep } from "./oskeys.ts";
import { rows, type AndroidNative } from "./rows.ts";

const root = new URL("../..", import.meta.url).pathname;
const IME = "de.k5d.breezy.ime/.Ime";
const adb = (...args: string[]) => execFileSync("adb", ["-s", EMULATOR_TCP, ...args], { encoding: "utf8" });
const skip = (() => {
  try {
    return !execFileSync("adb", ["devices"], { encoding: "utf8" }).includes(`${EMULATOR_TCP}\tdevice`) && "no emulator: run node scripts/android.ts";
  } catch {
    return "no adb: run under MISE_ENV=android mise exec --";
  }
})();

let device: AndroidDevice, context: BrowserContext, page: Page, touchscreen: Touchscreen, emulatorConsole: EmulatorConsole;
let site: ReturnType<typeof serveStatic>, keyboard = "";

/** The emulator's own keyboard back, also on ⌃C. */
function restoreKeyboard() {
  try {
    if (keyboard) adb("shell", "ime", "set", keyboard);
  } catch {}
}

before(async () => {
  if (skip) return;
  execFileSync(join(root, "tools/breezy-ime/build.sh"), [join(root, "build/breezy-ime")], { stdio: ["ignore", "ignore", "inherit"] });
  // each build has a key of its own, which Android takes only for a fresh install; an incremental install keeps adb
  // serving the apk, and the run waiting on it
  try {
    adb("uninstall", "de.k5d.breezy.ime");
  } catch {}
  adb("install", "--no-incremental", join(root, "build/breezy-ime/ime.apk"));
  keyboard = adb("shell", "settings", "get", "secure", "default_input_method").trim();
  process.once("exit", restoreKeyboard);
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    process.once(signal, () => {
      restoreKeyboard();
      process.exit(code);
    });
  }
  adb("shell", "ime", "enable", IME);
  adb("shell", "ime", "set", IME);
  const dir = join(root, "build", "web-platform");
  buildSite(dir);
  site = serveStatic(dir, WEB);
  adb("reverse", `tcp:${WEB}`, `tcp:${WEB}`);
  const devices = await _android.devices();
  device = devices.find((d) => d.serial() === EMULATOR_TCP)!;
  for (const d of devices) if (d !== device) await d.close();
  context = await launchAndroidChrome(device, { hasTouch: true });
  page = await context.newPage();
  for (const p of context.pages()) if (p !== page) await p.close();
  // Chrome keeps its profile from run to run, and with it a service worker's copy of an older build
  const cdp = await context.newCDPSession(page);
  await cdp.send("Storage.clearDataForOrigin", { origin: `http://localhost:${WEB}`, storageTypes: "all" });
  // Playwright's default keeps the page focused whatever happens, which hides every bug of focus leaving it
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  const emulator = /^(emulator-\d+)\tdevice$/m.exec(execFileSync("adb", ["devices"], { encoding: "utf8" }))![1]!;
  emulatorConsole = await EmulatorConsole.open(emulator);
  // calibrates on a page of its own, so before the app's
  touchscreen = await Touchscreen.of(EMULATOR_TCP, emulatorConsole, page);
});

after(async () => {
  restoreKeyboard();
  // either can wait without end on a connection adbd stopped serving, as RealWorld.stop found
  await Promise.race([context?.close(), sleep(10_000)]);
  await Promise.race([device?.close(), sleep(10_000)]);
  emulatorConsole?.close();
  site?.close();
});

for (const row of rows) {
  const drive = row.native.android;
  if (!drive) continue;
  test(`${row.id}-${row.variant} on android: ${row.title}`, { skip, todo: row.open.includes("android") }, async () => {
    await page.goto(`http://localhost:${WEB}/?demo=edit&record`);
    await page.waitForFunction(() => "breezyRecord" in window && (document.activeElement as HTMLElement | null)?.isContentEditable);
    // a real touch at the end of the card's text starts the keyboard there
    const end = await page.evaluate(() => {
      const r = document.activeElement!.getBoundingClientRect();
      return { x: r.right - 4, y: r.bottom - 6 };
    });
    await touchscreen.send([[0, "down", end]]);
    await sleep(60);
    await touchscreen.send([[0, "up", end]]);
    await sleep(1500);
    await page.evaluate(() => getSelection()!.collapse(document.activeElement!, document.activeElement!.childNodes.length));
    await sleep(300);
    const n: AndroidNative = {
      ime: (op, extras = {}) => void adb(...broadcastArgs(op, extras)),
      adb,
      text: () => page.evaluate(async () => ((await import("/record.js" as string)) as typeof import("../../web/record.ts")).editorState().text),
      wait: sleep,
    };
    const trace = await runRow(page, row, "android", IME, () => drive(n));
    assert.equal(row.expect(trace.before, trace.after), null);
  });
}
