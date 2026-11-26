// Level 3 (docs/superpowers/plans/2026-11-26-breezy-feel-levels.md, Task 2): the owner's 41 reference strokes, as Firefox
// handed each to the page with native panning (scripts/web-fixture.ts's captures), played into headless Chromium,
// WebKit and Firefox as synthetic wheel and ⌃-wheel events at their times, and judged by every rule against AppKit's
// replay of the stroke. Each browser's findings are held in strokes-known.json, a ratchet: a finding gone is a fix, a
// new one a regression. Run with
//   node --test scenarios/strokes.e2e.ts
// STROKES_BROWSERS=chromium,firefox picks browsers; STROKES_SMOKE=1 plays one stroke of each kind.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright-core";
import { buildSite, serveStatic } from "./browser.ts";
import { exitsAfter } from "./exit.ts";
import { check, REPLAYED, track } from "../scripts/frames/check.ts";
import { strokeOf } from "../scripts/web-fixture.ts";
import { ZOOM_PER_PT } from "../web/wheel.ts";
import type { FrameTrack, Recording } from "../web/flight.ts";

const BUILD = process.env.STROKES_FROM ?? "main-ae48c1b-native";
const VIEW = { width: 1495, height: 932 };
const SMOKE = ["double-tap-7", "lift-mid-band-17", "pinch-corner-1", "pinch-in-past-max-1", "pinch-out-fast-6", "pinch-out-slow-1", "pinch-pan-12"];
const fixtures = new URL("../scripts/test/fixtures/", import.meta.url).pathname, captures = `${fixtures}web-pinch/${BUILD}`;
const knownFile = new URL("./strokes-known.json", import.meta.url).pathname;
const KNOWN: Record<string, Record<string, string[]>> = JSON.parse(readFileSync(knownFile, "utf8"));
const spread: Record<string, number> = JSON.parse(readFileSync(`${captures}-spread.json`, "utf8"));
const smoke = !!process.env.STROKES_SMOKE;
const strokes = readdirSync(captures).map((f) => f.replace(".json", "")).filter((s) => !smoke || SMOKE.includes(s)).sort();
const kinds = { chromium, webkit, firefox } as const;
const names = (process.env.STROKES_BROWSERS ?? "chromium,webkit,firefox").split(",") as (keyof typeof kinds)[];
// a port and a site of its own for each set of browsers, as CI runs one process a browser side by side
const tag = names.join("-"), PORT = 58577 + ["chromium", "webkit", "firefox"].indexOf(names[0]!) + (names.length > 1 ? 3 : 0);
// the whole file, three browsers of 41 strokes of a few seconds each
setTimeout(() => { console.error("strokes.e2e ran past 15 minutes"); process.exit(1); }, 15 * 60_000).unref();

const site = new URL(`../build/web-strokes-${tag}`, import.meta.url).pathname;
buildSite(site);
const web = serveStatic(site, PORT);
const browsers: Browser[] = [];
const closeAll = async () => {
  await Promise.all(browsers.map((b) => b.close()));
  web.close();
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frames = (page: Page) => page.evaluate(() => (globalThis as { breezyFlight?: { recording(): Recording } }).breezyFlight?.recording().frames ?? null);

/** Plays `capture`'s input into `page` at its rows' times, from where its first row's camera was: a row's wheel deltas
 * as a wheel event, AppKit's way round as the frames hold them; its magnification as a ⌃-wheel step of as much, at the
 * row's place. Gives the frames from the one before the stroke, once the last has stood 1.5 s. */
export async function playCapture(page: Page, capture: FrameTrack): Promise<FrameTrack> {
  const col = (k: string) => capture.fields.indexOf(k), v = (r: (number | null)[], k: string) => (col(k) >= 0 ? r[col(k)] ?? 0 : 0);
  const first = capture.rows[0]!, z = v(first, "zoom") || 1;
  await page.goto(`http://localhost:${PORT}/?reference=${-v(first, "camX") * z},${-v(first, "camY") * z},${z}&pan=native`);
  await page.waitForFunction(() => (globalThis as { breezyFlight?: unknown }).breezyFlight, null, { timeout: 15_000 });
  await sleep(300);
  const t0 = first[0] ?? 0, inputs = capture.rows.filter((r) => v(r, "wheelDX") || v(r, "wheelDY") || v(r, "magnify"));
  const began = await page.evaluate(() => performance.now()), start = Date.now();
  for (const r of inputs) {
    const wait = (r[0] ?? 0) - t0 - (Date.now() - start);
    if (wait > 0) await sleep(wait);
    if (col("px") >= 0 && r[col("px")] != null) await page.mouse.move(v(r, "px"), v(r, "py"));
    const m = v(r, "magnify");
    if (m) {
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -Math.log(1 + m) / ZOOM_PER_PT);
      await page.keyboard.up("Control");
    } else await page.mouse.wheel(-v(r, "wheelDX"), -v(r, "wheelDY"));
  }
  let t: FrameTrack | null = null, last = NaN, since = Date.now();
  for (const until = Date.now() + 20_000; Date.now() < until; await sleep(250)) {
    t = await frames(page);
    const at = t?.rows.at(-1)?.[0] ?? NaN;
    if (at !== last) (last = at), (since = Date.now());
    else if (Date.now() - since > 1500) break;
  }
  if (!t) throw new Error("the page kept no frames");
  return strokeOf(t, began);
}

for (const name of names)
  describe(name, () => {
    let page: Page;
    const found: Record<string, string[]> = {}, zoomed: string[] = [];
    test(`${name} opens`, async () => {
      const b = await kinds[name].launch();
      browsers.push(b);
      page = await b.newPage({ viewport: VIEW });
    });
    for (const s of strokes)
      test(`${name}: ${s}`, async () => {
        const out = await playCapture(page, track(`${captures}/${s}.json`));
        const zooms = out.rows.map((r) => r[out.fields.indexOf("zoom")]);
        if (new Set(zooms).size > 1) zoomed.push(s);
        for (const x of check(out, track(`${fixtures}mac-pinch/reference-replay/${s}.json`), { ...REPLAYED, curve: Math.max(REPLAYED.curve, spread[s] ?? 0) })) {
          if (!(found[x.rule] ??= []).includes(s)) found[x.rule].push(s);
        }
      });
    test(`${name}: every rule against AppKit's replay, as strokes-known.json holds`, () => {
      const pinches = strokes.filter((s) => s.startsWith("pinch-out") || s.startsWith("pinch-in"));
      assert.ok(!pinches.length || pinches.some((s) => zoomed.includes(s)), `${name} took no synthetic pinch: none of ${pinches.join(", ")} zoomed`);
      const want = smoke ? Object.fromEntries(Object.entries(KNOWN[name] ?? {}).map(([r, s]) => [r, s.filter((x) => strokes.includes(x))]).filter(([, s]) => s.length)) : KNOWN[name];
      if (process.env.STROKES_WRITE && !smoke) writeFileSync(knownFile, JSON.stringify({ ...JSON.parse(readFileSync(knownFile, "utf8")), [name]: found }, null, 1) + "\n");
      assert.deepEqual(found, want ?? {}, "a finding gone is a fix: take it out of strokes-known.json; a new one is a regression");
    });
  });

// last, so that the file's own cleanup runs before its 10 s begin
exitsAfter(closeAll);
