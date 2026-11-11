// Native panning, ?pan=native, in headless Chromium and Firefox on the web app as it ships, with the demo board: the
// browser scrolls the board; Breezy's zoom, find and layout sit on top. Run with
//   node --test scenarios/native.e2e.ts
import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chromium, firefox, type Browser, type Page } from "playwright-core";
import { buildSite, serveStatic } from "./browser.ts";
import { exitsAfter } from "./exit.ts";
import type { Cam } from "../web/types.ts";

// apart from browsers.e2e.ts's, which another run may hold
const PORT = 58575;
const MS = 60_000;
const WINDOW = { width: 1200, height: 800 };

const site = new URL("../build/web-native", import.meta.url).pathname;
buildSite(site);
const web = serveStatic(site, PORT);
const browsers: Browser[] = [];
const closeAll = async () => {
  await Promise.all(browsers.map((b) => b.close()));
  web.close();
};

declare global {
  var nativeCamera: () => Cam;
}

/** The camera as drawn: where the world's origin is on screen, through the scroll position. Runs in the page. */
function camera(): Cam {
  const content = document.querySelector<HTMLElement>(".native-content")!.getBoundingClientRect();
  const m = document.querySelector<HTMLElement>(".world")!.style.transform.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/)!;
  return { x: content.left + Number(m[1]), y: content.top + Number(m[2]), zoom: Number(m[3]) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const near = (a: number, b: number, by: number, what: string) => assert.ok(Math.abs(a - b) <= by, `${what}: ${a} is not within ${by} of ${b}`);

/** The camera once it has stood still for 200 ms. */
async function settled(page: Page): Promise<Cam> {
  let last = await page.evaluate(() => nativeCamera());
  for (const end = Date.now() + 5000; Date.now() < end;) {
    await sleep(200);
    const now = await page.evaluate(() => nativeCamera());
    if (Math.abs(now.x - last.x) < 0.01 && Math.abs(now.y - last.y) < 0.01 && now.zoom === last.zoom) return now;
    last = now;
  }
  throw new Error("the camera did not stand still in 5 s");
}

/** Where the match find shows is centred across the window. */
const foundX = (page: Page) => page.evaluate(() => {
  const r = document.querySelector(".cards > .found")!.getBoundingClientRect();
  return r.left + r.width / 2;
});

async function zoomBy(page: Page, dy: number, times = 1) {
  await page.keyboard.down("Meta");
  for (let i = 0; i < times; i++) await page.mouse.wheel(0, dy);
  await page.keyboard.up("Meta");
}

for (const [kind, type] of [["chromium", chromium], ["firefox", firefox]] as const) {
  describe(kind, () => {
    let page: Page;
    before(async () => {
      const browser = await type.launch();
      browsers.push(browser);
      const context = await browser.newContext({ viewport: WINDOW });
      await context.addInitScript(`globalThis.nativeCamera = ${camera}`);
      page = await context.newPage();
    });
    beforeEach(async () => {
      await page.setViewportSize(WINDOW);
      await page.goto(`http://127.0.0.1:${PORT}/?pan=native&demo`);
      await page.waitForSelector(".native-content .cards > [data-id]", { timeout: 10_000 });
      await page.mouse.move(600, 420);
    });

    test("a wheel pans the native board", { timeout: MS }, async () => {
      const from = await settled(page);
      await page.mouse.wheel(0, 300);
      const to = await settled(page);
      near(to.y, from.y - 300, 2, "y");
      near(to.x, from.x, 0.5, "x");
    });

    test("⌘-scroll zooms around the pointer, and the board stays put under it", { timeout: MS }, async () => {
      const p = { x: 500, y: 420 };
      await page.mouse.move(p.x, p.y);
      const from = await settled(page);
      await zoomBy(page, -100);
      const to = await settled(page);
      assert.ok(to.zoom > from.zoom * 1.05, `zoom ${from.zoom} → ${to.zoom}`);
      const w = { x: (p.x - from.x) / from.zoom, y: (p.y - from.y) / from.zoom };
      near(w.x * to.zoom + to.x, p.x, 2, "x under the pointer");
      near(w.y * to.zoom + to.y, p.y, 2, "y under the pointer");
    });

    test("find glides to a match", { timeout: MS }, async () => {
      await settled(page);
      await page.click('[data-act="search"]');
      const path = await page.evaluate(() => new Promise<Cam[]>((done) => {
        const field = document.querySelector<HTMLInputElement>("#find input")!, seen: Cam[] = [], t0 = performance.now();
        field.value = "plan";
        field.dispatchEvent(new Event("input", { bubbles: true }));
        const frame = () => {
          seen.push(nativeCamera());
          if (performance.now() - t0 < 800) requestAnimationFrame(frame);
          else done(seen);
        };
        requestAnimationFrame(frame);
      }));
      const end = await settled(page), at = path.at(-1)!;
      near(at.x, end.x, 1, "x at 800 ms");
      near(at.y, end.y, 1, "y at 800 ms");
      const steps = new Set(path.map((c) => `${Math.round(c.x)} ${Math.round(c.y)}`));
      assert.ok(steps.size > 2, `moved in ${steps.size - 1} steps`);
      near(await foundX(page), WINDOW.width / 2, 2, "the match's centre");
    });

    test("a wheel during find's glide wins, and the glide stops", { timeout: MS }, async () => {
      await settled(page);
      await page.click('[data-act="search"]');
      await page.fill("#find input", "plan");
      await sleep(60);
      await page.mouse.wheel(0, 300);
      await settled(page);
      const x = await foundX(page);
      assert.ok(Math.abs(x - WINDOW.width / 2) > 20, `the match's centre at ${x}, as if the glide went on`);
    });

    test("zoomed out to 25 %, the board still covers the window", { timeout: MS }, async () => {
      for (let i = 0; i < 40 && (await page.evaluate(() => nativeCamera())).zoom > 0.2501; i++) await zoomBy(page, 400);
      assert.equal((await settled(page)).zoom, 0.25);
      const size = await page.evaluate(() => {
        const r = document.querySelector(".native-content")!.getBoundingClientRect();
        return { w: r.width, h: r.height, iw: innerWidth, ih: innerHeight };
      });
      assert.ok(size.w >= size.iw + 1 && size.h >= size.ih + 1, JSON.stringify(size));
    });

    test("a larger window leaves the camera where it was, the board still past the window", { timeout: MS }, async () => {
      const from = await settled(page);
      await page.setViewportSize({ width: 2600, height: 1800 });
      const to = await settled(page);
      near(to.x, from.x, 0.5, "x");
      near(to.y, from.y, 0.5, "y");
      const size = await page.evaluate(() => {
        const b = document.getElementById("board")!;
        return { w: b.scrollWidth, h: b.scrollHeight, cw: b.clientWidth, ch: b.clientHeight };
      });
      assert.ok(size.w >= size.cw + 1 && size.h >= size.ch + 1, JSON.stringify(size));
    });
  });
}

exitsAfter(closeAll);
