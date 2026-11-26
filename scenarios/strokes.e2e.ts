// Level 3 (docs/superpowers/plans/2026-11-26-breezy-feel-levels.md, Task 2): the owner's 41 reference strokes, as Firefox
// handed each to the page with native panning (scripts/web-fixture.ts's captures), played into headless Chromium,
// WebKit and Firefox as wheel and ⌃-wheel input at their times, and judged by every rule against AppKit's replay of the
// stroke, each kind of machine against its own ratchet. A stroke whose input the browser took more than 10 % longer to take than the capture's is not judged, as
// its zoom would read late, and is listed as `slow`; such a stroke on either side is left out of the comparison, as a
// slower runner has more, so long as half the strokes are judged. Each browser's findings are held in
// strokes-known/<mac|ci>/<browser>.json, a ratchet: a finding gone is a fix, a new one a regression. Run with
//   node --test scenarios/strokes.e2e.ts
// STROKES_BROWSERS=chromium,firefox picks browsers; STROKES_SMOKE=1 plays one stroke of each kind; STROKES_WRITE=1
// writes the browsers' findings as known; STROKES_DUMP=<dir> keeps each replay's frames.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright-core";
import { buildSite, serveStatic } from "./browser.ts";
import { exitsAfter } from "./exit.ts";
import { frameMs, inputSpan, judged, merge } from "./strokes-play.ts";
import { check, REPLAYED, track } from "../scripts/frames/check.ts";
import { restGap, zoomGap } from "../scripts/frames/gaps.ts";
import { strokeOf } from "../scripts/web-fixture.ts";
import type { FrameTrack, Recording } from "../web/flight.ts";

const BUILD = process.env.STROKES_FROM ?? "main-ae48c1b-native";
const VIEW = { width: 1495, height: 932 };
/** How much longer than the capture's the browser may take to take a stroke's input before its zoom reads late. */
const SLOW = 1.1;
/** How near its line a stroke's zoom gap stands undecided: synthetic input's own timing moved a few strokes across
 * the line from one run to the next, so these count as whatever the ratchet holds. */
const BAND = 0.15;
const SMOKE = ["double-tap-7", "lift-mid-band-17", "pinch-corner-1", "pinch-in-past-max-1", "pinch-out-fast-6", "pinch-out-slow-1", "pinch-pan-12"];
const fixtures = new URL("../scripts/test/fixtures/", import.meta.url).pathname, captures = `${fixtures}web-pinch/${BUILD}`;
// a ratchet for each kind of machine, as CI's runner draws at 60 Hz and less where the owner's Mac draws at 120, and a
// fast pinch's zoom a frame later reads as 0.12 and more of zoom
const RUNNER = process.env.CI ? "ci" : "mac";
const knownDir = new URL(`./strokes-known/${RUNNER}/`, import.meta.url).pathname;
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
    // level 3 calibrated against level 4: Firefox's replay of a stroke against Firefox's real-input capture of it
    const drifted: string[] = [];
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
        // STROKES_DUMP=<dir> keeps each replay's frames, to see what a drift or a finding is
        if (process.env.STROKES_DUMP) {
          mkdirSync(`${process.env.STROKES_DUMP}/${name}`, { recursive: true });
          writeFileSync(`${process.env.STROKES_DUMP}/${name}/${s}.json`, JSON.stringify(out) + "\n");
        }
        if (new Set(out.rows.map((r) => r[out.fields.indexOf("zoom")])).size > 1) zoomed.push(s);
        const span = inputSpan(capture), took = inputSpan(out), ratio = span > 0 ? took / span : 1;
        if (name === "firefox" && ratio <= SLOW) {
          // two of the browser's own frames either way: input sent from outside the browser lands up to a frame and a
          // half off its frame, which on the fastest pinches in read as 0.19 of zoom with no slack, 0.07 with two
          // frames, on the Mac's 8 ms frames as on CI's 17
          const own = zoomGap(out, capture, 2 * frameMs(out)), tol = Math.max(REPLAYED.curve, spread[s] ?? 0), rest = restGap(out, capture);
          if (process.env.STROKES_GAPS) console.log(`calibration ${s} zoom ${own.toFixed(3)} of ${tol}, rest ${rest.toFixed(1)} pt`);
          if (own > tol) drifted.push(`${s} zoom ${own.toFixed(3)} past ${tol}`);
          // Firefox came to rest within 0.6 pt of its captures
          if (rest > 2) drifted.push(`${s} rest ${rest.toFixed(1)} pt past 2`);
        }
        if (ratio > SLOW) return void (add("slow", s), failed.pop());
        const ref = track(`${fixtures}mac-pinch/reference-replay/${s}.json`), tol = Math.max(REPLAYED.curve, spread[s] ?? 0);
        const gap = zoomGap(out, ref);
        if (Math.abs(gap / tol - 1) <= BAND) borderline.push(s);
        for (const x of check(out, ref, { ...REPLAYED, curve: tol })) add(x.rule, s);
        failed.pop();
      });
    if (name === "firefox")
      test("firefox: each stroke moves as Firefox's real-input capture of it did (level 3 calibrated against level 4)", () => {
        assert.deepEqual(drifted, [], "synthetic input moved otherwise than real input: the fake is wrong, or the capture is stale");
      });
    test(`${name}: every rule against AppKit's replay, as strokes-known/${RUNNER}/${name}.json holds`, () => {
      assert.deepEqual(failed, [], `${failed.join(", ")} did not play`);
      // every stroke with a pinch the browser took in time zoomed: one that did not is a browser taking no ⌃-wheel
      const missed = strokes.filter((s) => hasPinch(track(`${captures}/${s}.json`)) && !zoomed.includes(s) && !found.slow?.includes(s));
      assert.deepEqual(missed, [], `${name} took no synthetic pinch on ${missed.join(", ")}`);
      const file = `${knownDir}${name}.json`;
      // beside the frames, the findings as a ratchet would hold them, to take CI's from its artifact
      if (process.env.STROKES_DUMP && !smoke) writeFileSync(`${process.env.STROKES_DUMP}/${name}-known.json`, JSON.stringify(found, null, 1) + "\n");
      if (process.env.STROKES_WRITE && !smoke) {
        mkdirSync(knownDir, { recursive: true });
        writeFileSync(file, JSON.stringify(found, null, 1) + "\n");
      }
      const known: Record<string, string[]> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      const slow = found.slow?.length ?? 0;
      assert.ok(slow <= strokes.length / 2, `${name} took ${slow} of ${strokes.length} strokes too slowly to judge`);
      const o = (k: Record<string, string[]>) => ({ strokes, known: k, borderline });
      assert.deepEqual(judged(found, o(known)), judged(known, o(found)), `a finding gone is a fix: take it out of strokes-known/${RUNNER}/${name}.json; a new one is a regression (unjudged: too slow ${[...new Set([...(found.slow ?? []), ...(known.slow ?? [])])].join(", ") || "none"}; borderline ${borderline.join(", ") || "none"})`);
    });
  });

// last, so that the file's own cleanup runs before its 10 s begin
exitsAfter(closeAll);
