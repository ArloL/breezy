// Level 3 (docs/superpowers/plans/2026-11-26-breezy-feel-levels.md, Task 2): the owner's 41 reference strokes, as Firefox
// handed each to the page with native panning (scripts/web-fixture.ts's captures), played into headless Chromium,
// WebKit and Firefox as wheel and ⌃-wheel input at their times, and judged by every rule against AppKit's replay of the
// stroke. A stroke whose input the browser took more than 10 % longer to take than the capture's is not judged, as
// its zoom would read late, and is listed as `slow`. Each browser's findings are held in strokes-known/<browser>.json,
// a ratchet: a finding gone is a fix, a new one a regression. Run with
//   node --test scenarios/strokes.e2e.ts
// STROKES_BROWSERS=chromium,firefox picks browsers; STROKES_SMOKE=1 plays one stroke of each kind; STROKES_WRITE=1
// writes the browsers' findings as known.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright-core";
import { buildSite, serveStatic } from "./browser.ts";
import { exitsAfter } from "./exit.ts";
import { inputSpan, merge } from "./strokes-play.ts";
import { check, REPLAYED, track } from "../scripts/frames/check.ts";
import { curve } from "../scripts/frames/rules.ts";
import { strokeOf } from "../scripts/web-fixture.ts";
import type { FrameTrack, Recording } from "../web/flight.ts";

const BUILD = process.env.STROKES_FROM ?? "main-ae48c1b-native";
const VIEW = { width: 1495, height: 932 };
/** How much longer than the capture's the browser may take to take a stroke's input before its zoom reads late. */
const SLOW = 1.1;
/** How near its line a stroke's zoom gap, or its slowness, stands undecided: synthetic input's own timing moved a few
 * strokes across the line from one run to the next, so these count as whatever the ratchet holds. */
const BAND = 0.15;
const SMOKE = ["double-tap-7", "lift-mid-band-17", "pinch-corner-1", "pinch-in-past-max-1", "pinch-out-fast-6", "pinch-out-slow-1", "pinch-pan-12"];
const fixtures = new URL("../scripts/test/fixtures/", import.meta.url).pathname, captures = `${fixtures}web-pinch/${BUILD}`;
const knownDir = new URL("./strokes-known/", import.meta.url).pathname;
const spread: Record<string, number> = JSON.parse(readFileSync(`${captures}-spread.json`, "utf8"));
const smoke = !!process.env.STROKES_SMOKE;
const strokes = readdirSync(captures).map((f) => f.replace(".json", "")).filter((s) => !smoke || SMOKE.includes(s)).sort();
const kinds = { chromium, webkit, firefox } as const;
const names = (process.env.STROKES_BROWSERS ?? "chromium,webkit,firefox").split(",") as (keyof typeof kinds)[];
for (const n of names) if (!(n in kinds)) throw new Error(`STROKES_BROWSERS names ${n}: chromium, webkit or firefox`);
// a port and a site of its own for each set of browsers, as CI runs one process a browser side by side
const tag = names.join("-"), PORT = 58577 + ["chromium", "webkit", "firefox"].indexOf(names[0]!) + (names.length > 1 ? 3 : 0);
// the whole file, under the nightly step's 12 minutes, so that its own deadline, and its output, come first
setTimeout(() => { console.error("strokes.e2e ran past 10 minutes"); process.exit(1); }, 10 * 60_000).unref();

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
const hasPinch = (t: FrameTrack) => { const i = t.fields.indexOf("magnify"); return i >= 0 && t.rows.some((r) => (r[i] ?? 0) !== 0); };

/** Plays `capture`'s input into `page` on its rows' schedule, from where its first row's camera was: the rows due at
 * once as one step (scenarios/strokes-play.ts), ⌃ held over a run of pinch steps. Gives the frames from the one before
 * the stroke, once the last has stood 1.5 s. */
export async function playCapture(page: Page, capture: FrameTrack): Promise<FrameTrack> {
  const col = (k: string) => capture.fields.indexOf(k), v = (r: (number | null)[], k: string) => (col(k) >= 0 ? r[col(k)] ?? 0 : 0);
  const first = capture.rows[0]!, z = v(first, "zoom") || 1;
  await page.goto(`http://localhost:${PORT}/?reference=${-v(first, "camX") * z},${-v(first, "camY") * z},${z}&pan=native`);
  await page.waitForFunction(() => (globalThis as { breezyFlight?: unknown }).breezyFlight, null, { timeout: 15_000 });
  await sleep(300);
  const t0 = first[0] ?? 0, inputs = capture.rows.filter((r) => v(r, "wheelDX") || v(r, "wheelDY") || v(r, "magnify"));
  const began = await page.evaluate(() => performance.now()), start = Date.now();
  let k = 0, ctrl = false, at: { x: number; y: number } | null = null;
  try {
    while (k < inputs.length) {
      const next = (inputs[k]![0] ?? 0) - t0, now = Date.now() - start;
      if (next > now) {
        await sleep(next - now);
        continue;
      }
      const due: (number | null)[][] = [];
      while (k < inputs.length && (inputs[k]![0] ?? 0) - t0 <= Date.now() - start) due.push(inputs[k++]!);
      const s = merge(capture.fields, due);
      if (s.at && (s.at.x !== at?.x || s.at.y !== at?.y)) await page.mouse.move(s.at.x, s.at.y);
      at = s.at ?? at;
      if (s.pan) {
        if (ctrl) {
          await page.keyboard.up("Control");
          ctrl = false;
        }
        await page.mouse.wheel(s.pan.dx, s.pan.dy);
      }
      if (s.zoom.length && !ctrl) {
        await page.keyboard.down("Control");
        ctrl = true;
      }
      for (const d of s.zoom) await page.mouse.wheel(0, d);
    }
  } finally {
    if (ctrl) await page.keyboard.up("Control");
  }
  let t: FrameTrack | null = null, last = NaN, since = Date.now();
  for (const until = Date.now() + 20_000; Date.now() - since <= 1500; await sleep(250)) {
    if (Date.now() > until) throw new Error("the view never stood still in 20 s");
    t = await frames(page);
    const ended = t?.rows.at(-1)?.[0] ?? NaN;
    if (ended !== last) (last = ended), (since = Date.now());
  }
  if (!t) throw new Error("the page kept no frames");
  return strokeOf(t, began);
}

for (const name of names)
  describe(name, () => {
    let page: Page;
    const found: Record<string, string[]> = {}, zoomed: string[] = [], failed: string[] = [], borderline: string[] = [];
    const add = (rule: string, s: string) => { if (!(found[rule] ??= []).includes(s)) found[rule].push(s); };
    test(`${name} opens`, async () => {
      const b = await kinds[name].launch();
      browsers.push(b);
      page = await b.newPage({ viewport: VIEW });
    });
    for (const s of strokes)
      test(`${name}: ${s}`, async () => {
        failed.push(s);
        const capture = track(`${captures}/${s}.json`), out = await playCapture(page, capture);
        if (new Set(out.rows.map((r) => r[out.fields.indexOf("zoom")])).size > 1) zoomed.push(s);
        const span = inputSpan(capture), took = inputSpan(out), ratio = span > 0 ? took / span : 1;
        if (Math.abs(ratio / SLOW - 1) <= BAND) borderline.push(s);
        if (ratio > SLOW) return void (add("slow", s), failed.pop());
        const ref = track(`${fixtures}mac-pinch/reference-replay/${s}.json`), tol = Math.max(REPLAYED.curve, spread[s] ?? 0);
        const gap = Math.max(0, ...curve(out, ref, "zoom", 0).map((f) => Number(/up to ([0-9.]+)/.exec(f.say)?.[1] ?? 0)));
        if (Math.abs(gap / tol - 1) <= BAND) borderline.push(s);
        for (const x of check(out, ref, { ...REPLAYED, curve: tol })) add(x.rule, s);
        failed.pop();
      });
    test(`${name}: every rule against AppKit's replay, as strokes-known/${name}.json holds`, () => {
      assert.deepEqual(failed, [], `${failed.join(", ")} did not play`);
      // every stroke with a pinch the browser took in time zoomed: one that did not is a browser taking no ⌃-wheel
      const missed = strokes.filter((s) => hasPinch(track(`${captures}/${s}.json`)) && !zoomed.includes(s) && !found.slow?.includes(s));
      assert.deepEqual(missed, [], `${name} took no synthetic pinch on ${missed.join(", ")}`);
      const file = `${knownDir}${name}.json`;
      if (process.env.STROKES_WRITE && !smoke) {
        mkdirSync(knownDir, { recursive: true });
        writeFileSync(file, JSON.stringify(found, null, 1) + "\n");
      }
      const known: Record<string, string[]> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      // a borderline stroke matches either way, as the ratchet holds it or not
      const decided = (m: Record<string, string[]>) => Object.fromEntries(Object.entries(m).map(([r, s]) => [r, s.filter((x) => strokes.includes(x) && !((r === "curve" || r === "slow") && borderline.includes(x)))]).filter(([, s]) => s.length));
      assert.deepEqual(decided(found), decided(known), `a finding gone is a fix: take it out of strokes-known/${name}.json; a new one is a regression (borderline, either way: ${borderline.join(", ") || "none"})`);
    });
  });

// last, so that the file's own cleanup runs before its 10 s begin
exitsAfter(closeAll);
