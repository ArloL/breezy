// Native panning, ?pan=native, in headless Chromium and Firefox on the web app as it ships, with the demo board: the
// browser scrolls the board; Breezy's zoom, find and layout sit on top. Run with
//   node --test scenarios/native.e2e.ts
// A failing case leaves the page's flight recording in build/scenarios/native-<browser>-<case>/.
import { before, beforeEach, describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium, firefox, type Browser, type Page } from "playwright-core";
import { buildSite, readFlight, serveStatic } from "./browser.ts";
import { exitsAfter } from "./exit.ts";
import type { Cam } from "../web/types.ts";

// apart from browsers.e2e.ts's, which another run may hold
const PORT = 58575;
const MS = 60_000;
const WINDOW = { width: 1200, height: 800 };

const site = new URL("../build/web-native", import.meta.url).pathname;
const out = new URL("../build/scenarios/", import.meta.url).pathname;
buildSite(site);
const web = serveStatic(site, PORT);
const browsers: Browser[] = [];
const closeAll = async () => {
  await Promise.all(browsers.map((b) => b.close()));
  web.close();
};

declare global {
  var nativeCamera: () => Cam;
  var nativeFind: (q: string) => void;
  var nativeFound: () => number;
  var atWheel: { cam: Cam; found: number } | undefined;
}

/** The camera as drawn: where the world's origin is on screen, through the scroll position. Runs in the page. */
function camera(): Cam {
  const content = document.querySelector<HTMLElement>(".native-content")!.getBoundingClientRect();
  const m = document.querySelector<HTMLElement>(".world")!.style.transform.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/)!;
  return { x: content.left + Number(m[1]), y: content.top + Number(m[2]), zoom: Number(m[3]) };
}

/** Finds `q` as typing it into the open find bar would. Runs in the page. */
function find(q: string) {
  const field = document.querySelector<HTMLInputElement>("#find input")!;
  field.value = q;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Where the match find shows is centred across the window, NaN before it shows. Runs in the page. */
function found() {
  const r = document.querySelector(".cards > .found")?.getBoundingClientRect();
  return r ? r.left + r.width / 2 : NaN;
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

const foundX = (page: Page) => page.evaluate(() => nativeFound());

/** Finds `q` from the page, and the camera as drawn on every frame until it has stood still for 10, within 5 s. */
const glide = (page: Page, q: string) => page.evaluate((q) => new Promise<Cam[]>((done, fail) => {
  const seen = [nativeCamera()], t0 = performance.now();
  let still = 0;
  nativeFind(q);
  const frame = () => {
    const c = nativeCamera(), last = seen.at(-1)!;
    seen.push(c);
    still = Math.abs(c.x - last.x) < 0.01 && Math.abs(c.y - last.y) < 0.01 ? still + 1 : 0;
    if (still >= 10) done(seen);
    else if (performance.now() - t0 > 5000) fail(new Error("the camera did not stand still in 5 s"));
    else requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}), q);

/** The flight recording's notes from entry `from` on. */
/** The demo board afresh, the window its usual size and the pointer over the board. */
async function open(page: Page) {
  await page.setViewportSize(WINDOW);
  await page.goto(`http://127.0.0.1:${PORT}/?pan=native&demo`);
  await page.waitForSelector(".native-content .cards > [data-id]", { timeout: 10_000 });
  await page.mouse.move(600, 420);
}

const notes = async (page: Page, from = 0) => (await page.evaluate(readFlight))!.entries.slice(from);

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
      await context.addInitScript(`globalThis.nativeCamera = ${camera}; globalThis.nativeFind = ${find}; globalThis.nativeFound = ${found};`);
      page = await context.newPage();
    }, { timeout: MS });
    beforeEach(() => open(page), { timeout: MS });

    /** On failure, the page's flight recording, into build/scenarios/, which the desktop job uploads. */
    const kept = async (t: TestContext, f: () => Promise<void>) => {
      try {
        await f();
      } catch (e) {
        const dir = `${out}native-${kind}-${t.name.replace(/\W+/g, "-").slice(0, 60)}/`;
        mkdirSync(dir, { recursive: true });
        await page.evaluate(readFlight).then((r) => writeFileSync(`${dir}flight.json`, JSON.stringify(r)), () => {});
        throw e;
      }
    };

    test("a wheel pans the native board", { timeout: MS }, (t) => kept(t, async () => {
      const from = await settled(page);
      await page.mouse.wheel(0, 300);
      const to = await settled(page);
      near(to.y, from.y - 300, 2, "y");
      near(to.x, from.x, 0.5, "x");
    }));

    test("a wheel pans the board while a card is edited", { timeout: MS }, (t) => kept(t, async () => {
      const c = await page.evaluate(() => {
        const r = document.querySelector(".cards > [data-id]")!.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      // again when the clicks came too far apart to be one double-click, as on a busy runner
      for (let tries = 1; !await page.evaluate(() => !!(document.activeElement as HTMLElement | null)?.isContentEditable); tries++) {
        if (tries > 3) throw new Error("a double-click opened no editor, three times");
        await page.mouse.dblclick(c.x, c.y);
        await sleep(300);
      }
      // over the board, clear of the keyboard bar the edit shows
      await page.mouse.move(600, 420);
      const from = await settled(page);
      await page.mouse.wheel(0, 300);
      const to = await settled(page);
      near(to.y, from.y - 300, 2, "y");
      assert.ok(await page.evaluate(() => !!(document.activeElement as HTMLElement | null)?.isContentEditable), "the edit ended");
    }));

    test("⌘-scroll zooms around the pointer, and the board stays put under it", { timeout: MS }, (t) => kept(t, async () => {
      const p = { x: 500, y: 420 };
      await page.mouse.move(p.x, p.y);
      const from = await settled(page);
      await zoomBy(page, -100);
      const to = await settled(page);
      assert.ok(to.zoom > from.zoom * 1.05, `zoom ${from.zoom} → ${to.zoom}`);
      const w = { x: (p.x - from.x) / from.zoom, y: (p.y - from.y) / from.zoom };
      near(w.x * to.zoom + to.x, p.x, 2, "x under the pointer");
      near(w.y * to.zoom + to.y, p.y, 2, "y under the pointer");
    }));

    test("find glides to a match", { timeout: MS }, (t) => kept(t, async () => {
      await settled(page);
      await page.click('[data-act="search"]');
      const path = await glide(page, "plan"), end = await settled(page), at = path.at(-1)!;
      near(at.x, end.x, 1, "x at rest");
      near(at.y, end.y, 1, "y at rest");
      const steps = new Set(path.map((c) => `${Math.round(c.x)} ${Math.round(c.y)}`));
      assert.ok(steps.size > 2, `moved in ${steps.size - 1} steps`);
      near(await foundX(page), WINDOW.width / 2, 2, "the match's centre");
    }));

    // its view reaches past the board as it last rested, where the browser held the scroll position short of it
    test("find glides to an outermost card at 25 %, every frame where the camera asked", { timeout: MS }, (t) => kept(t, async () => {
      await page.mouse.move(1100, 420);
      for (let i = 0; i < 40 && (await page.evaluate(() => nativeCamera())).zoom > 0.2501; i++) await zoomBy(page, 400);
      await settled(page);
      await page.click('[data-act="search"]');
      const from = (await notes(page)).length;
      const path = await glide(page, "less but"), end = await settled(page);
      const refused = (await notes(page, from)).filter((e) => e[2] === "native scroll refused");
      assert.deepEqual(refused, []);
      const steps = new Set(path.map((c) => `${Math.round(c.x)} ${Math.round(c.y)}`));
      assert.ok(steps.size > 2, `moved in ${steps.size - 1} steps`);
      near(path.at(-1)!.x, end.x, 1, "x at rest");
      near(path.at(-1)!.y, end.y, 1, "y at rest");
      near(await foundX(page), WINDOW.width / 2, 2, "the match's centre");
    }));

    // the wheel goes a round trip after the glide sets off: should the glide have ended or nearly by then, as Firefox's
    // timers on a busy runner can make it, the case says nothing of the wheel, and is run again on a page of its own
    test("a wheel during find's glide wins, and the glide stops where the wheel found it", { timeout: MS }, (t) => kept(t, async () => {
      for (let tries = 1; ; tries++) {
        if (tries > 1) await open(page);
        await settled(page);
        await page.click('[data-act="search"]');
        // the find from the page, the wheel sent once the camera is on its way
        await page.evaluate(() => new Promise<void>((done, fail) => {
          const from = nativeCamera(), t0 = performance.now();
          addEventListener("wheel", () => void (globalThis.atWheel = { cam: nativeCamera(), found: nativeFound() }), { capture: true, once: true });
          nativeFind("plan");
          const frame = () => {
            if (Math.abs(nativeCamera().x - from.x) > 1) done();
            else if (performance.now() - t0 > 5000) fail(new Error("find's glide did not set off in 5 s"));
            else requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        }));
        await page.mouse.wheel(0, 300);
        const end = await settled(page), at = (await page.evaluate(() => globalThis.atWheel))!;
        const left = Math.abs(at.found - WINDOW.width / 2);
        if (left <= 20 && tries < 3) {
          t.diagnostic(`try ${tries}: the glide had ${left} pt left when the wheel came; again`);
          continue;
        }
        assert.ok(left > 20, `not judged in ${tries} tries: the glide had ${left} pt left when the wheel came`);
        near(end.x, at.cam.x, 1, "x");
        near(end.y, at.cam.y - 300, 2, "y");
        return;
      }
    }));

    test("zoomed out to 25 %, the board still covers the window", { timeout: MS }, (t) => kept(t, async () => {
      for (let i = 0; i < 40 && (await page.evaluate(() => nativeCamera())).zoom > 0.2501; i++) await zoomBy(page, 400);
      assert.equal((await settled(page)).zoom, 0.25);
      const size = await page.evaluate(() => {
        const r = document.querySelector(".native-content")!.getBoundingClientRect();
        return { w: r.width, h: r.height, iw: innerWidth, ih: innerHeight };
      });
      assert.ok(size.w >= size.iw + 1 && size.h >= size.ih + 1, JSON.stringify(size));
    }));

    test("a larger window leaves the camera where it was, the board still past the window", { timeout: MS }, (t) => kept(t, async () => {
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
    }));
  });
}

exitsAfter(closeAll);
