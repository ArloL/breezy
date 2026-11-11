// Native panning, ?pan=native, in Safari on the iOS Simulator with the demo board: Safari pans the board with one
// finger; Breezy's pinch, holds, double tap and drag, and the editing lock sit on top. Boot an iPhone first
// (node scripts/ios.ts), then
//   node --test --test-force-exit scenarios/native-ios.e2e.ts
// A failing case leaves the page's flight recording and the screen in build/native-ios/.
import { before, beforeEach, describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { Agent } from "./agent.ts";
import { buildSite, freshSafari, serveStatic } from "./browser.ts";
import { item, readFlight, type Frame, type Scene } from "./device.ts";
import { bootedIphoneAsync, iosState, iosUnfit, IosDevice, SimHid, simctlAsync } from "./ios.ts";
import { exitsAfter } from "./exit.ts";
import type { Cam, Point } from "../web/types.ts";

// inside scripts/reserve-ports.sh's range, apart from native.e2e.ts's
const PORT = 58574;
const MS = 120_000;
const out = new URL("../build/native-ios/", import.meta.url).pathname;
const unfit = await iosUnfit();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const agent = new Agent(), page = agent.page;
let web: ReturnType<typeof serveStatic> | undefined, hid: SimHid | undefined, d: IosDevice;
const closeAll = async () => {
  d?.finger?.stop();
  hid?.stop();
  agent.stop();
  web?.close();
};

/** What the board shows, the camera as drawn through the scroll position: runs in the page. */
function nativeScene(): Scene {
  const num = (s: string) => Number.parseFloat(s) || 0;
  const translate = (t: string) => {
    const m = t.match(/translate\((-?[\d.e+-]+)px(?:, (-?[\d.e+-]+)px)?\)(?: scale\(([\d.]+)\))?/);
    return m ? { x: Number(m[1]), y: Number(m[2] ?? 0), scale: m[3] ? Number(m[3]) : 1 } : { x: 0, y: 0, scale: 1 };
  };
  const board = document.querySelector("#board")!.getBoundingClientRect();
  const content = document.querySelector(".native-content")!.getBoundingClientRect();
  const world = translate(document.querySelector<HTMLElement>(".world")!.style.transform);
  const of = (el: HTMLElement) => {
    const t = translate(el.style.transform);
    return { id: el.dataset.id!, x: t.x, y: t.y, w: num(el.style.width), h: num(el.style.height), selected: el.classList.contains("selected"), held: el.classList.contains("held") };
  };
  return {
    cards: [...document.querySelectorAll<HTMLElement>(".cards > [data-id]")].map((el) => ({ ...of(el), raised: el.classList.contains("lifted"), color: 0, text: el.querySelector(".front")!.textContent ?? "" })),
    lanes: [...document.querySelectorAll<HTMLElement>(".lanes > [data-id]")].map((el) => ({ ...of(el), title: "" })),
    turned: null,
    marquee: null,
    camera: { x: content.left - board.left + world.x, y: content.top - board.top + world.y, zoom: world.scale },
  };
}

/** The editor with the keyboard, its caret and the board's scroll position: runs in the page. */
function editing() {
  const e = document.activeElement as HTMLElement | null, s = getSelection();
  const board = document.querySelector<HTMLElement>("#board")!;
  return {
    editor: !!e?.isContentEditable,
    caret: s?.rangeCount ? s.getRangeAt(0).startOffset : -1,
    scroll: { x: board.scrollLeft, y: board.scrollTop },
    locked: board.classList.contains("editing") && getComputedStyle(board).overflow === "hidden",
    board: `${board.className}, overflow ${getComputedStyle(board).overflow}, focus in ${document.activeElement?.className}`,
  };
}

/** Where the first frame with two fingers on the board had them, and the camera then: runs in the page. */
function watchPinch() {
  const w = window as { pinchAt?: { mid: Point; cam: Cam; fingers: number } };
  delete w.pinchAt;
  addEventListener("touchmove", (e) => {
    if (e.touches.length < 2 || w.pinchAt) return;
    const b = document.querySelector("#board")!.getBoundingClientRect(), [a, c] = [e.touches[0]!, e.touches[1]!];
    const content = document.querySelector(".native-content")!.getBoundingClientRect();
    const t = document.querySelector<HTMLElement>(".world")!.style.transform.match(/translate\((-?[\d.e+-]+)px(?:, (-?[\d.e+-]+)px)?\) scale\(([\d.]+)\)/)!;
    w.pinchAt = { mid: { x: (a.clientX + c.clientX) / 2 - b.left, y: (a.clientY + c.clientY) / 2 - b.top },
      cam: { x: content.left - b.left + Number(t[1]), y: content.top - b.top + Number(t[2] ?? 0), zoom: Number(t[3]) }, fingers: e.touches.length };
  }, { capture: true, passive: true });
}

/** The camera as the fingers went from two to one, the first time: runs in the page. */
function watchLift() {
  const w = window as { liftAt?: Cam };
  delete w.liftAt;
  const at = (e: TouchEvent) => {
    if (e.touches.length !== 1 || w.liftAt) return;
    const b = document.querySelector("#board")!.getBoundingClientRect(), content = document.querySelector(".native-content")!.getBoundingClientRect();
    const t = document.querySelector<HTMLElement>(".world")!.style.transform.match(/translate\((-?[\d.e+-]+)px(?:, (-?[\d.e+-]+)px)?\) scale\(([\d.]+)\)/)!;
    w.liftAt = { x: content.left - b.left + Number(t[1]), y: content.top - b.top + Number(t[2] ?? 0), zoom: Number(t[3]) };
  };
  // after the page has heard it, and ended the pinch
  addEventListener("touchend", at, { passive: true });
  addEventListener("touchcancel", at, { passive: true });
}

const near = (a: number, b: number, by: number, what: string) => assert.ok(Math.abs(a - b) <= by, `${what}: ${a} is not within ${by} of ${b}`);
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const toScreen = (c: Cam, p: Point) => ({ x: p.x * c.zoom + c.x, y: p.y * c.zoom + c.y });
const toWorld = (c: Cam, p: Point) => ({ x: (p.x - c.x) / c.zoom, y: (p.y - c.y) / c.zoom });
const line = (from: Point, to: Point, steps: number, finger = 0, ms = 16): Frame[] =>
  Array.from({ length: steps }, (_, i): Frame => [ms, "move", [[finger, { x: from.x + ((to.x - from.x) * (i + 1)) / steps, y: from.y + ((to.y - from.y) * (i + 1)) / steps }]]]);

describe("native panning in Safari on the iOS Simulator", { skip: unfit }, () => {
  let udid: string, opened = 0;

  before(async () => {
    udid = (await bootedIphoneAsync())!;
    const site = new URL("../build/web-native-ios", import.meta.url).pathname;
    buildSite(site);
    web = serveStatic(site, PORT, agent);
    page.open = (url) => simctlAsync(["openurl", udid, url], { timeout: 90_000 }).then(() => {});
    await freshSafari(udid);
    hid = await SimHid.start(udid);
    d = new IosDevice("ios-safari", page, hid, { scene: nativeScene, editor: () => null, weights: () => null, sight: () => null });
   }, { timeout: 3 * MS });

  // each case on a page of its own, opened at a URL of its own: a tab the simulator opens again sees no touch
  beforeEach(async () => {
    for (let tries = 1; ; tries++) {
      try {
        // the service worker's snapshot of the page has no agent; a page that no longer answers has none to keep
        if (opened) await page.evaluate(async () => void await Promise.all((await navigator.serviceWorker?.getRegistrations() ?? []).map((r) => r.unregister()))).catch(() => {});
        // until the new page asks, not the one before it: Safari, started afresh, may show a page of a run before
        const was = agent.current;
        await page.open(`http://localhost:${PORT}/?pan=native&demo&opened=${++opened}`);
        for (const end = Date.now() + 30_000; agent.current === was; await sleep(100)) if (Date.now() > end) throw new Error("the new page never asked");
        await page.waitForSelector(".native-content .cards > [data-id]", { timeout: 20_000 });
        break;
      } catch (e) {
        if (tries === 3) throw e;
      }
    }
    await d.calibrate();
    await d.still("the board to stand still");
   }, { timeout: 3 * MS });

  /** On failure, the page's flight recording and the iPhone's screen, into build/native-ios/. */
  const kept = async (t: TestContext, f: () => Promise<void>) => {
    try {
      await f();
    } catch (e) {
      const dir = `${out}${t.name.replace(/\W+/g, "-").slice(0, 60)}/`;
      mkdirSync(dir, { recursive: true });
      await page.evaluate(readFlight).then((r) => writeFileSync(`${dir}flight.json`, JSON.stringify(r)), () => {});
      iosState(udid, dir);
      throw e;
    }
  };

  test("a pinch zooms the native board without moving the point between the fingers", { timeout: MS }, (t) => kept(t, async () => {
    const { w, h } = await d.size(), m = { x: w / 2, y: h * 0.7 };
    const before = (await d.scene()).camera, anchor = toWorld(before, m);
    const spread: Frame[] = Array.from({ length: 10 }, (_, i): Frame => [16, "move", [[0, { x: m.x - 50 - 5 * (i + 1), y: m.y }], [1, { x: m.x + 50 + 5 * (i + 1), y: m.y }]]]);
    await d.gesture([[0, "down", [[0, { x: m.x - 50, y: m.y }]]], [16, "down", [[1, { x: m.x + 50, y: m.y }]]], ...spread,
      [50, "up", [[0, { x: m.x - 100, y: m.y }], [1, { x: m.x + 100, y: m.y }]]]]);
    await d.still("the pinch to settle");
    const after = (await d.scene()).camera;
    near(after.zoom, Math.min(2, before.zoom * 2), 0.05, "the zoom, the fingers' spread doubled");
    assert.ok(dist(toScreen(after, anchor), m) <= 4, `the board point between the fingers is ${dist(toScreen(after, anchor), m).toFixed(1)} pt from them`);
  }));

  test("a second finger on a native pan zooms", { timeout: MS }, (t) => kept(t, async () => {
    await page.evaluate(watchPinch);
    const { w, h } = await d.size(), a = { x: w / 2 - 50, y: h * 0.8 }, a1 = { x: a.x, y: a.y - 120 };
    const before = (await d.scene()).camera;
    const b = { x: w / 2 + 50, y: a1.y };
    const spread: Frame[] = Array.from({ length: 10 }, (_, i): Frame => [16, "move", [[0, { x: a1.x - 5 * (i + 1), y: a1.y }], [1, { x: b.x + 5 * (i + 1), y: b.y }]]]);
    const end = { x: (a1.x - 50 + b.x + 50) / 2, y: a1.y };
    await d.gesture([[0, "down", [[0, a]]], ...line(a, a1, 12), [16, "down", [[1, b]]], ...spread,
      [50, "up", [[0, { x: a1.x - 50, y: a1.y }], [1, { x: b.x + 50, y: b.y }]]]]);
    await d.still("the pinch to settle");
    const at = await page.evaluate(() => (window as { pinchAt?: { mid: Point; cam: Cam; fingers: number } }).pinchAt ?? null);
    assert.ok(at, "the page saw no two fingers");
    const after = (await d.scene()).camera;
    assert.ok(Math.abs(before.y - at.cam.y) > 20, `the first finger panned the board ${Math.round(at.cam.y - before.y)} pt before the second came`);
    assert.ok(Math.abs(after.zoom - before.zoom) > 0.2, `the zoom went from ${before.zoom} to ${after.zoom}`);
    // the browser's pan, taken: its content went to the overlay for the pinch
    const kinds = (await page.evaluate(readFlight))!.entries.filter((e) => e[2] === "native pinch start").map((e) => (e[3] as { kind: string }).kind);
    assert.deepEqual(kinds, ["taken"]);
    assert.ok(await page.evaluate(() => !!(document.querySelector(".native-overlay")!.compareDocumentPosition(document.getElementById("top")!) & Node.DOCUMENT_POSITION_FOLLOWING)), "the overlay paints over the bars");
    const anchor = toWorld(at.cam, at.mid), off = dist(toScreen(after, anchor), end);
    assert.ok(off <= 8, `the board point between the fingers as the second came is ${off.toFixed(1)} pt from them`);
  }));

  /** After `pinch`, which ends with finger 1 lifted, finger 0 drags 100 pt down and rests before it lifts: the board
   * follows it 100 pt, from where the second finger left it. */
  const leftFingerPans = async (pinch: Frame[], at: Point) => {
    await page.evaluate(watchLift);
    const to = { x: at.x, y: at.y + 100 };
    await d.gesture([...pinch, ...line(at, to, 10), [200, "move", [[0, to]]], [16, "up", [[0, to]]]]);
    await d.still("the board to stand still");
    const lift = await page.evaluate(() => (window as { liftAt?: Cam }).liftAt ?? null), after = (await d.scene()).camera;
    assert.ok(lift, "the page saw no finger lift from two to one");
    near(after.zoom, lift.zoom, 0.001, "the zoom after the lift");
    near(after.y - lift.y, 100, 5, "the board's move under the finger left");
    near(after.x, lift.x, 5, "the camera's x");
  };

  test("the finger left from a pinch on a native pan pans the board on its own", { timeout: MS }, (t) => kept(t, async () => {
    const { w, h } = await d.size(), a = { x: w / 2 - 50, y: h * 0.8 }, a1 = { x: a.x, y: a.y - 120 }, b = { x: w / 2 + 50, y: a1.y };
    const spread: Frame[] = Array.from({ length: 10 }, (_, i): Frame => [16, "move", [[0, { x: a1.x - 5 * (i + 1), y: a1.y }], [1, { x: b.x + 5 * (i + 1), y: b.y }]]]);
    const at = { x: a1.x - 50, y: a1.y };
    await leftFingerPans([[0, "down", [[0, a]]], ...line(a, a1, 12), [16, "down", [[1, b]]], ...spread, [50, "up", [[1, { x: b.x + 50, y: b.y }]]]], at);
    const kinds = (await page.evaluate(readFlight))!.entries.filter((e) => e[2] === "native pinch start").map((e) => (e[3] as { kind: string }).kind);
    assert.deepEqual(kinds, ["taken"]);
  }));

  test("a hold on the board drags a marquee, and the board does not pan", { timeout: MS }, (t) => kept(t, async () => {
    const s = await d.scene(), before = s.camera;
    // from between two lanes over a card; held, it creeps 6 pt, short of a drag's 8, and rests before it goes on
    const from = { x: 312, y: 150 }, to = { x: 120, y: 260 };
    assert.ok(!s.cards.some((c) => from.x >= c.x && from.x < c.x + c.w && from.y >= c.y && from.y < c.y + c.h), "the hold begins on a card");
    const a = await d.screen(from), b = await d.screen(to), dir = { x: (b.x - a.x) / dist(a, b), y: (b.y - a.y) / dist(a, b) };
    const crept = { x: a.x + 6 * dir.x, y: a.y + 6 * dir.y };
    await d.gesture([[0, "down", [[0, a]]], [400, "move", [[0, a]]], ...line(a, crept, 6), [300, "move", [[0, crept]]], ...line(crept, b, 30), [16, "up", [[0, b]]]]);
    await d.still("the board to stand still");
    const after = await d.scene();
    assert.ok(item(after, "c-hiring").selected, `the marquee selected ${after.cards.filter((c) => c.selected).map((c) => c.id).join(", ") || "nothing"}`);
    near(after.camera.x, before.x, 1, "the camera's x");
    near(after.camera.y, before.y, 1, "the camera's y");
  }));

  test("a held card drags, and the board does not pan", { timeout: MS }, (t) => kept(t, async () => {
    const s = await d.scene(), c = item(s, "c-hiring"), from = { x: c.x + c.w / 2, y: c.y + c.h / 2 };
    const before = s.camera;
    await d.touchDrag(from, { x: from.x + 96, y: from.y + 120 }, { hold: true, steps: 12 });
    await d.still("the card to land");
    const after = await d.scene(), moved = item(after, "c-hiring");
    assert.ok(Math.hypot(moved.x - c.x, moved.y - c.y) > 60, `the card moved ${Math.round(moved.x - c.x)},${Math.round(moved.y - c.y)}`);
    near(after.camera.x, before.x, 1, "the camera's x");
    near(after.camera.y, before.y, 1, "the camera's y");
  }));

  test("a double tap and a drag zooms", { timeout: MS }, (t) => kept(t, async () => {
    const { w, h } = await d.size(), p = { x: w / 2, y: h * 0.7 }, to = { x: p.x, y: p.y + 150 };
    const before = (await d.scene()).camera, anchor = toWorld(before, p);
    await d.gesture([[0, "down", [[0, p]]], [40, "up", [[0, p]]], [60, "down", [[0, p]]], ...line(p, to, 15), [16, "up", [[0, to]]]]);
    await d.still("the zoom to settle");
    const after = (await d.scene()).camera;
    near(after.zoom, Math.min(2, before.zoom * 2), 0.05, "the zoom, dragged down 150 pt");
    assert.ok(dist(toScreen(after, anchor), p) <= 4, `the point first touched moved ${dist(toScreen(after, anchor), p).toFixed(1)} pt`);
  }));

  test("the spacebar's caret, run to the line's start, leaves the board where it was", { timeout: MS }, (t) => kept(t, async () => {
    const c = item(await d.scene(), "c-flaky");
    // on its text, clear of the corner that turns it
    await d.doubleTap({ x: c.x + c.w * 0.6, y: c.y + 20 });
    await d.until("an editor to open", async () => (await page.evaluate(editing)).editor, 10_000);
    await d.still("the keyboard to come and the board to stand still");
    const space = await spaceKey(udid);
    const was = await page.evaluate(editing), cam = (await d.scene()).camera;
    assert.ok(was.caret > 0, `the caret at ${was.caret}, not past the line's start`);
    assert.ok(was.locked, `the board scrolls while a card is edited: ${was.board}`);
    // held until the keyboard turns into a trackpad, then run left past the line's start, and held there
    await d.finger!.touches([[0, "down", space.x, space.y], [900, "move", space.x, space.y], ...Array.from({ length: 20 }, (): [number, "move", number, number] => [30, "move", space.x, space.y]),
      ...Array.from({ length: 30 }, (_, i): [number, "move", number, number] => [16, "move", space.x - 6 * (i + 1), space.y]), [600, "move", space.x - 180, space.y], [16, "up", space.x - 180, space.y]]);
    await d.still("the board to stand still");
    const now = await page.evaluate(editing), after = (await d.scene()).camera;
    assert.ok(now.editor, "the edit ended");
    assert.ok(now.caret < was.caret, `the caret stayed at ${now.caret} of ${was.caret}: the spacebar never ran it`);
    near(after.x, cam.x, 1, "the camera's x");
    near(after.y, cam.y, 1, "the camera's y");
    near(now.scroll.x, was.scroll.x, 1, "the board's scroll x");
    near(now.scroll.y, was.scroll.y, 1, "the board's scroll y");
  }));
});

/** The middle of the keyboard's space bar on the screen, as its accessibility lists it. */
async function spaceKey(udid: string): Promise<Point> {
  const run = promisify(execFile);
  const { stdout } = await run("uvx", ["--quiet", "--python", "3.11", "--from", "fb-idb", "idb", "ui", "describe-all", "--udid", udid, "--json"], { encoding: "utf8", timeout: 120_000 });
  const keys = JSON.parse(stdout) as { AXLabel?: string; frame: { x: number; y: number; width: number; height: number } }[];
  const k = keys.find((x) => /^space$/i.test(x.AXLabel ?? ""));
  if (!k) throw new Error(`no space bar among ${keys.map((x) => x.AXLabel).filter(Boolean).slice(0, 30).join(", ")}`);
  return { x: k.frame.x + k.frame.width / 2, y: k.frame.y + k.frame.height / 2 };
}

exitsAfter(closeAll);
