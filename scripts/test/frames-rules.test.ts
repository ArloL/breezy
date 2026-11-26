// The rules over frames (scripts/frames/rules.ts), each on a hand-built track:
// docs/superpowers/specs/2026-11-11-breezy-native-reference-2-design.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { FIELDS, MAC_FIELDS, WEB_FIELDS, column, frames } from "../frames/track.ts";
import { chrome, continuity, coverage, curve, edgePops, flicker, follow, pops, scrollers } from "../frames/rules.ts";
import { check, REPLAYED, track as read } from "../frames/check.ts";
import type { FrameTrack, Recording } from "../../web/flight.ts";

type Row = Partial<Record<string, number | null>>;
const ALL = [...FIELDS, ...MAC_FIELDS];
/** A 1200 × 800 view on a 2000 × 2000 board at 0,0, at zoom 1 from 400,400, every 16 ms, overridden by `rows`. */
const BASE: Row = { zoom: 1, camX: 400, camY: 400, viewW: 1200, viewH: 800, boardX: 0, boardY: 0, boardW: 2000, boardH: 2000, px: 600, py: 400,
  f1x: null, f1y: null, f2x: null, f2y: null, wheelDX: 0, wheelDY: 0, wheelPhase: 0, momentumPhase: 0, magnify: 0, gesture: 0, knobH: 0.6, knobV: 0.4, grey: 0 };
function track(rows: Row[]): FrameTrack {
  return { fields: ALL, rows: rows.map((r, i) => ALL.map((f) => (f === "t" ? (r.t ?? i * 16) : f in r ? r[f]! : (BASE[f] ?? null)))) };
}
/** A pinch about the view's centre, zoom going `zooms` frame by frame, the world point under it held still. */
function pinch(zooms: number[], extra: (i: number, z: number) => Row = () => ({})): Row[] {
  const wx = 400 + 600, wy = 400 + 400;
  return zooms.map((z, i) => ({ zoom: z, camX: wx - 600 / z, camY: wy - 400 / z, gesture: i === 0 ? 1 : i === zooms.length - 1 ? 3 : 2,
    magnify: i ? z / zooms[i - 1] - 1 : 0, ...extra(i, z) }));
}
const range = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));

test("coverage finds grey along the top and left during a pinch", () => {
  // the board grows only at rest: from 30 % down to 23 % the view reaches past its top and left
  const rows = pinch(range(0.4, 0.23, 20), (_, z) => (z < 0.3 ? { boardX: 1000 - 600 / 0.3, boardY: 800 - 400 / 0.3, grey: 50 } : { boardX: -2000, boardY: -2000, boardW: 6000, boardH: 6000 }));
  const f = coverage(track(rows));
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.equal(f[0].rule, "coverage");
  const first = rows.findIndex((r) => r.zoom! < 0.3);
  assert.equal(f[0].from, first * 16);
  assert.equal(f[0].to, (rows.length - 1) * 16);
});

test("coverage lets a pan pull past the edge", () => {
  const rows: Row[] = range(400, -60, 12).map((x, i) => ({ camX: x, wheelDX: 40, wheelPhase: i ? 4 : 1 }));
  rows.push(...range(-60, 0, 10).map((x) => ({ camX: x, momentumPhase: 0, wheelPhase: 8 })));
  assert.deepEqual(coverage(track(rows)), []);
});

test("coverage lets a pinch show past the edge as far as the reference's showed at that moment, and no further", () => {
  // AppKit, pinched at its board's top left, keeps the board under the fingers past the edge, up to 626 pt
  const atCorner = (past: number) => pinch(range(0.5, 0.25, 20), (i) => ({ boardX: 1000 - 600 / 0.5 + (past * i) / 19 / 0.25, boardY: -5000, boardW: 20000, boardH: 20000 }));
  const ref = track(atCorner(120));
  assert.deepEqual(coverage(track(atCorner(100)), ref), []);
  const f = coverage(track(atCorner(160)), ref);
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.match(f[0].say, /past the board.*the reference's/);
});

test("coverage finds grey past the edge where the reference showed none", () => {
  // on a board smaller than the view at 25 %, a pinch at its centre shows past both sides; AppKit's board had no edge there
  const small = pinch(range(0.5, 0.25, 20), () => ({ boardX: 500, boardY: 300, boardW: 1000, boardH: 1000 }));
  const big = pinch(range(0.5, 0.25, 20), () => ({ boardX: -20000, boardY: -20000, boardW: 40032, boardH: 40032 }));
  assert.deepEqual(coverage(track(big), track(big)), []);
  assert.equal(coverage(track(small), track(big)).length, 1);
});

test("follow finds the board slipping under a pinch's centre", () => {
  // the world point under 600,400 moves by 3 pt over the pinch
  const rows = pinch(range(1, 0.5, 10), (i, z) => ({ camX: 1000 - 600 / z + (i * 3) / 9 / z }));
  const f = follow(track(rows), 0.5);
  assert.ok(f.length >= 1 && f[0].rule === "follow", JSON.stringify(f));
  assert.deepEqual(follow(track(pinch(range(1, 0.5, 10))), 0.5), []);
});

test("continuity finds a jump back at the pinch's end", () => {
  const rows = pinch(range(0.3, 0.23, 10));
  rows.push({ ...rows.at(-1), gesture: 0, magnify: 0, zoom: 0.25, camX: 1000 - 600 / 0.25, camY: 800 - 400 / 0.25 });
  const f = continuity(track(rows));
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.equal(f[0].from, 9 * 16);
});

test("continuity takes a spring back over 15 frames as smooth", () => {
  const rows = pinch(range(0.3, 0.23, 10));
  // a critically damped spring from 0.23 to 0.25 in log zoom
  for (let i = 1; i <= 15; i++) {
    const s = i / 15, z = Math.exp(Math.log(0.23) + (Math.log(0.25) - Math.log(0.23)) * (1 - (1 + 6 * s) * Math.exp(-6 * s)));
    rows.push({ zoom: z, camX: 1000 - 600 / z, camY: 800 - 400 / z, gesture: 0, magnify: 0 });
  }
  assert.deepEqual(continuity(track(rows)), []);
});

test("continuity takes AppKit's spring, stepping its zoom every other frame on a 120 Hz display, as smooth", () => {
  // the reference's pinch-out-fast-6 after its fingers lift: 0.2418, 0.2428, 0.2428, 0.2446, 0.2446 … every 8.3 ms
  const rows: Row[] = pinch(range(0.3, 0.24, 10)).map((r, i) => ({ ...r, t: i * 8.3 }));
  const held = [0.2418, 0.2428, 0.2428, 0.2446, 0.2446, 0.2461, 0.2461, 0.2474, 0.2474, 0.2484, 0.2484, 0.2491, 0.2491];
  held.forEach((z, i) => rows.push({ t: (10 + i) * 8.3, zoom: z, camX: 1000 - 600 / z, camY: 800 - 400 / z, gesture: 0, magnify: 0 }));
  assert.deepEqual(continuity(track(rows)), []);
});

test("continuity lets AppKit's own animation start as a gesture ends, as a two-finger double tap's, and no faster", () => {
  // the reference's double-tap-7: zoom 1 → 1.5 easing in from rest, every 8.3 ms, its event in the frame before
  const ease = [1, 1, 1.012, 1.0255, 1.0441, 1.068, 1.0963, 1.1276];
  const tap = (zs: number[]) => track(zs.map((z, i) => ({ t: i * 8.3, zoom: z, camX: 1000 - 600 / z, camY: 800 - 400 / z, gesture: i === 0 ? 3 : 0 })));
  assert.deepEqual(continuity(tap(ease)), []);
  assert.equal(continuity(tap([1, 1, 1.08, 1.1, 1.12])).length, 1);
});

test("continuity lets AppKit's settle zoom about a point of its own once nothing touches", () => {
  // the reference's pinch-out-fast-11 settling: the zoom steps 0.2488 → 0.2499 about the view's left edge, far from the
  // pointer, and the view's centre moves 2.6 pt
  const rows: Row[] = [0.2488, 0.2488, 0.2488, 0.2499, 0.2499].map((z, i) => ({ t: i * 8.3, zoom: z, camX: 17000 }));
  assert.deepEqual(continuity(track(rows)), []);
});

test("continuity lets a scroll move the view a frame after it came, as AppKit applies it", () => {
  // the reference's pinch-pan-13: 5 pt of wheel in one frame, the view moving 5 pt in the next
  const rows: Row[] = [[0, 400], [5, 400], [0, 395], [0, 395]].map(([dx, x], i) => ({ t: i * 8.3, wheelDX: dx, wheelPhase: i ? 4 : 1, camX: x }));
  assert.deepEqual(continuity(track(rows)), []);
});

test("continuity lets AppKit pull the view back from past the board once the fingers lift, faster the further past", () => {
  // the reference's pinch-corner-1: 626 pt past the board's left at 0.228, still a frame, then 19.7, 24.5, 27.3 pt a frame
  const z = 0.228, at = (x: number) => ({ zoom: z, camX: x, boardX: 0, boardY: -5000, boardW: 40032, boardH: 40032 });
  const back = (first: number) => track([0, 0, first, first + 24.5, first + 52].map((d, i) => ({ t: i * 8.3, ...at(-626 / z + d / z), gesture: i === 0 ? 3 : 0 })));
  assert.deepEqual(continuity(back(19.7)), []);
  assert.equal(continuity(back(60)).length, 1);
});

test("continuity lets the camera go on with a settle's zoom in a frame its zoom holds, as AppKit steps zoom at 60 Hz", () => {
  // the reference's lift-mid-band-17: the zoom holds at 0.2427 for a frame while the camera moves on
  const rows: Row[] = [[0.2406, 17236.22], [0.2417, 17247.32], [0.2427, 17257.53], [0.2427, 17266.77], [0.2445, 17275.05]]
    .map(([zoom, camX], i) => ({ t: i * 8.3, zoom, camX, viewW: 1495 }));
  assert.deepEqual(continuity(track(rows)), []);
});

test("continuity finds a pan's speed lost or gained as it is let go", () => {
  // a pan at 20 pt a frame, then its coast at 60 or 5; a coast at 18 takes the speed over
  const coast = (v: number) => {
    const rows: Row[] = Array.from({ length: 10 }, (_, i) => ({ camX: 400 + i * 20, wheelDX: -20, wheelPhase: i ? (i === 9 ? 8 : 4) : 1 }));
    for (let i = 1; i <= 5; i++) rows.push({ camX: 580 + i * v, momentumPhase: 2 });
    return continuity(track(rows));
  };
  assert.ok(coast(60).some((f) => /let go/.test(f.say)), JSON.stringify(coast(60)));
  assert.ok(coast(5).some((f) => /let go/.test(f.say)));
  assert.deepEqual(coast(18), []);
});

test("continuity tolerates a 50 ms gap without input", () => {
  const rows = pinch(range(1, 0.8, 8)).map((r, i) => ({ ...r, t: i < 4 ? i * 16 : i * 16 + 50 }));
  assert.deepEqual(continuity(track(rows)), []);
});

test("flicker finds grey for two frames and back", () => {
  const rows: Row[] = Array.from({ length: 12 }, (_, i) => ({ grey: i === 5 || i === 6 ? 40 : 0 }));
  const f = flicker(track(rows), ["grey"]);
  assert.equal(f.length, 1);
  assert.equal(f[0].from, 5 * 16);
  assert.equal(f[0].to, 6 * 16);
  // a value that changes and stays is no flicker
  assert.deepEqual(flicker(track(Array.from({ length: 12 }, (_, i) => ({ grey: i >= 5 ? 40 : 0 }))), ["grey"]), []);
});

test("pops finds grey that grew with a pinch gone in one frame", () => {
  const rows: Row[] = Array.from({ length: 12 }, (_, i) => ({ grey: i < 10 ? i * 15 : 0 }));
  const f = pops(track(rows), ["grey"], 20);
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.equal(f[0].from, 9 * 16);
  assert.equal(f[0].to, 10 * 16);
  assert.deepEqual(pops(track(Array.from({ length: 12 }, (_, i) => ({ grey: Math.max(0, 135 - i * 15) }))), ["grey"], 20), []);
});

test("edgePops finds the view's reach past the board leaping in a frame, further than the reference's ever did", () => {
  // the bounded build's pinch-out-slow-4: 212 pt past the board's edge, gone in a frame as the pinch ends
  const band = (reach: number[]) => track(reach.map((r) => ({ camX: -r })));
  const leap = band([0, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 212, 0, 0]);
  const f = edgePops(leap, band(Array(14).fill(0)));
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.equal(f[0].rule, "flicker");
  assert.equal(f[0].from, 11 * 16);
  // AppKit's own, pinched at its corner, comes back by up to 85 pt a frame: as far, and 20 pt more, is no leap
  const appkit = band([0, 30, 60, 85, 85, 0, 0]);
  assert.deepEqual(edgePops(band([0, 30, 60, 100, 100, 0, 0]), appkit), []);
  // with no reference, 30 pt a frame, as the owner's video shows the band shooting in by 30 to 52
  assert.equal(edgePops(band([0, 20, 40, 60])).length, 0);
  assert.equal(edgePops(band([0, 50, 0])).length, 2);
});

test("flicker finds the view resizing and back, as the bounded board's did with its scrollers every 125 ms", () => {
  const rows: Row[] = Array.from({ length: 30 }, (_, i) => (i % 15 === 0 ? { viewW: 1512, viewH: 883, boardW: 5350 } : { viewW: 1495, viewH: 866, boardW: 5411 }));
  assert.ok(flicker(track(rows), ["viewW", "viewH", "boardW", "boardH"]).length >= 2);
});

test("scrollers finds a knob changing at a constant zoom", () => {
  const rows: Row[] = Array.from({ length: 8 }, (_, i) => ({ knobH: i < 4 ? 0.6 : 0.5 }));
  const f = scrollers(track(rows));
  assert.equal(f.length, 1);
  assert.equal(f[0].from, 4 * 16);
  const zooming: Row[] = Array.from({ length: 8 }, (_, i) => ({ zoom: 1 - i * 0.02, knobH: 0.6 - i * 0.01 }));
  assert.deepEqual(scrollers(track(zooming)), []);
});

test("scrollers lets knobs change while AppKit steps its zoom every other frame", () => {
  const rows: Row[] = Array.from({ length: 12 }, (_, i) => ({ t: i * 8.3, zoom: 1 - Math.floor(i / 2) * 0.02, knobH: 0.6 - i * 0.005 }));
  assert.deepEqual(scrollers(track(rows)), []);
});

test("scrollers lets knobs change while the view is past the board, as AppKit's shrink as it overscrolls", () => {
  // past the board's left edge by 40 to 0 pt, as the reference's corner pinch draws back
  const rows: Row[] = Array.from({ length: 8 }, (_, i) => ({ camX: -40 + i * 5, knobH: 0.55 + i * 0.005 }));
  assert.deepEqual(scrollers(track(rows)), []);
});

test("curve aligns tracks at their first input, though a recorder kept no gesture's begin", () => {
  // Breezy's recorder lost a pinch's begin when its next event came in the same frame; its frames start before the stroke
  const ref = track(pinch(range(1, 0.5, 20)));
  const late = pinch(range(1, 0.5, 20)).map((r) => ({ ...r, gesture: r.gesture === 1 ? 2 : r.gesture }));
  const breezy = track([...Array.from({ length: 30 }, () => ({ zoom: 1, camX: 400, camY: 400 })), ...late].map((r, i) => ({ ...r, t: i * 16 })));
  assert.deepEqual(curve(breezy, ref, "zoom", 0.01), []);
});

test("curve finds a zoom curve 0.02 off the reference's with tol 0.01", () => {
  const ref = track(pinch(range(1, 0.5, 20)));
  const off = track(pinch(range(1, 0.5, 20).map((z, i) => (i > 10 ? z + 0.02 : z))));
  assert.ok(curve(off, ref, "zoom", 0.01).length >= 1);
  assert.deepEqual(curve(ref, ref, "zoom", 0.01), []);
});

test("curve reads between frames a display link skipped, as a straight line", () => {
  // the reference drew every 16 ms; the other skipped 100 ms where nothing redrew, on the same line
  const ref = track(Array.from({ length: 20 }, (_, i) => ({ t: i * 16, zoom: 1 - i * 0.02, gesture: i ? 2 : 1 })));
  const sparse = track([0, 1, 2, 9, 10, 19].map((i) => ({ t: i * 16, zoom: 1 - i * 0.02, gesture: i ? 2 : 1 })));
  assert.deepEqual(curve(sparse, ref, "zoom", 0.005), []);
});

test("frames reads a recording's track, and column names a missing field in its error", () => {
  const t = track([{}, {}]);
  const r: Recording = { schema: 1, origin: 0, dropped: 0, context: null, entries: [], frames: t };
  assert.equal(frames(r), t);
  assert.deepEqual(column(t, "zoom"), [1, 1]);
  assert.throws(() => column(t, "nope"), /nope/);
  assert.throws(() => frames({ ...r, frames: undefined }), /no frames/);
});

test("the fields are the ones scripts/frames/fields.json lists, every platform's first", () => {
  assert.deepEqual(FIELDS.slice(0, 4), ["t", "zoom", "camX", "camY"]);
  assert.ok(MAC_FIELDS.includes("grey"));
});

/** A web track: every platform's fields, then the web's, the Mac's absent. */
function webTrack(rows: Row[]): FrameTrack {
  const fields = [...FIELDS, ...WEB_FIELDS], base: Row = { ...BASE, coverTop: 0, grid: 0 };
  return { fields, rows: rows.map((r, i) => fields.map((f) => (f === "t" ? (r.t ?? i * 16) : f in r ? r[f]! : (base[f] ?? null)))) };
}

test("check reads a web track", () => {
  assert.deepEqual(check(webTrack([{}, {}])), []);
});

test("chrome finds the board over the top bar", () => {
  const f = chrome(webTrack([{ coverTop: 0 }, { coverTop: 1 }, { coverTop: 1 }, { coverTop: 0 }]));
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.equal(f[0].rule, "chrome");
  assert.deepEqual([f[0].from, f[0].to], [16, 32]);
});

test("the grid falling short for a frame is a flicker", () => {
  const f = check(webTrack([{ grid: 0 }, { grid: 40 }, { grid: 0 }]));
  assert.deepEqual(f.map((x) => x.rule), ["flicker"], JSON.stringify(f));
});

test("AppKit's replays still pass every rule", () => {
  const dir = new URL("./fixtures/mac-pinch/", import.meta.url).pathname;
  for (const s of readdirSync(dir + "reference-replay")) {
    assert.deepEqual(check(read(`${dir}reference-replay/${s}`), read(`${dir}reference/${s}`), REPLAYED), [], s);
  }
});
