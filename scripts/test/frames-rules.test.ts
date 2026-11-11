// The rules over frames (scripts/frames/rules.ts), each on a hand-built track:
// docs/superpowers/specs/2026-11-11-breezy-native-reference-2-design.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FIELDS, MAC_FIELDS, column, frames } from "../frames/track.ts";
import { continuity, coverage, curve, flicker, follow, scrollers } from "../frames/rules.ts";
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

test("scrollers finds a knob changing at a constant zoom", () => {
  const rows: Row[] = Array.from({ length: 8 }, (_, i) => ({ knobH: i < 4 ? 0.6 : 0.5 }));
  const f = scrollers(track(rows));
  assert.equal(f.length, 1);
  assert.equal(f[0].from, 4 * 16);
  const zooming: Row[] = Array.from({ length: 8 }, (_, i) => ({ zoom: 1 - i * 0.02, knobH: 0.6 - i * 0.01 }));
  assert.deepEqual(scrollers(track(zooming)), []);
});

test("curve finds a zoom curve 0.02 off the reference's with tol 0.01", () => {
  const ref = track(pinch(range(1, 0.5, 20)));
  const off = track(pinch(range(1, 0.5, 20).map((z, i) => (i > 10 ? z + 0.02 : z))));
  assert.ok(curve(off, ref, "zoom", 0.01).length >= 1);
  assert.deepEqual(curve(ref, ref, "zoom", 0.01), []);
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
