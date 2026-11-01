// The app in Chromium keeps the card being edited in sight of a visual viewport that shrank with no resize event yet:
// Chrome on CI's Android emulator read the keyboard's height a second before it told (#217).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { buildSite, serveStatic } from "../browser.ts";
import { outOfSight, readSight } from "../../web/sight.ts";

const root = new URL("../..", import.meta.url).pathname;
const PORT = 58565;
let browser: Browser, site: ReturnType<typeof serveStatic>;

before(async () => {
  const out = join(root, "build", "web-viewport");
  buildSite(out);
  site = serveStatic(out, PORT);
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  site?.close();
});

test("a keyboard Chrome reads before it tells moves the card being edited above it", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 411, height: 812 }, hasTouch: true });
  await page.goto(`http://localhost:${PORT}/?demo=edit`);
  await page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.isContentEditable);
  // the card low on the screen, as a double tap there makes one
  await page.mouse.move(200, 400);
  await page.mouse.wheel(0, -500);
  let before = await page.evaluate(readSight);
  for (const t0 = Date.now(); Date.now() - t0 < 2000 && (before?.focus?.y ?? 0) < 500; await page.waitForTimeout(50)) before = await page.evaluate(readSight);
  assert.ok(before?.focus && before.focus.y >= 500 && !outOfSight(before), `low and in sight at first: ${JSON.stringify(before)}`);
  // the nightly's: Chrome read 476 a second before it told (#217)
  await page.evaluate((h) => {
    let resized = false;
    visualViewport!.addEventListener("resize", () => (resized = true));
    Object.defineProperty(visualViewport, "height", { get: () => h, configurable: true });
    (window as unknown as { resized: () => boolean }).resized = () => resized;
  }, 476);
  // the card revealed, with its spring, in a second
  let problem: string | null = "";
  for (const t0 = Date.now(); Date.now() - t0 < 2000 && problem !== null; await page.waitForTimeout(50)) problem = outOfSight((await page.evaluate(readSight))!);
  assert.equal(await page.evaluate(() => (window as unknown as { resized: () => boolean }).resized()), false, "no resize event came");
  assert.equal(problem, null);
});
