// What must hold on every frame of a gesture, as pure functions over a frame track: what the owner reports off is made
// to fail one of these before it is fixed, and each must pass on the platform's reference
// (docs/superpowers/specs/2026-11-11-breezy-native-reference-2-design.md).
import { column } from "./track.ts";
import type { FrameTrack } from "../../web/flight.ts";

export interface Finding {
  rule: "follow" | "coverage" | "continuity" | "flicker" | "scrollers" | "curve";
  /** The first and last frame's `t`, in ms. */
  from: number;
  to: number;
  say: string;
}

type Col = (number | null)[];
const num = (v: number | null | undefined) => v ?? 0;
const has = (t: FrameTrack, f: string) => t.fields.includes(f);
const maybe = (t: FrameTrack, f: string): Col => (has(t, f) ? column(t, f) : t.rows.map(() => null));

/** Frames `bad` marks, as runs of consecutive frames, each one finding. */
function runs(t: Col, bad: boolean[], rule: Finding["rule"], say: (from: number, to: number) => string): Finding[] {
  const out: Finding[] = [];
  for (let i = 0; i < bad.length; i++) {
    if (!bad[i]) continue;
    let j = i;
    while (j + 1 < bad.length && bad[j + 1]) j++;
    out.push({ rule, from: num(t[i]), to: num(t[j]), say: say(i, j) });
    i = j;
  }
  return out;
}

const CONTACT_PHASES = new Set([1, 2, 4]); // NSEvent's began, stationary, changed

/** The view's world rect past the board's, in view pt: the furthest any side reaches past it; 0 for a track with no
 * camera, as a screen capture's. */
function pastBoard(t: FrameTrack): number[] {
  if (!has(t, "zoom")) return t.rows.map(() => 0);
  const [z, x, y, w, h, bx, by, bw, bh] = ["zoom", "camX", "camY", "viewW", "viewH", "boardX", "boardY", "boardW", "boardH"].map((f) => column(t, f));
  return t.rows.map((_, i) => {
    const s = num(z[i]), x0 = num(x[i]), y0 = num(y[i]), x1 = x0 + num(w[i]) / s, y1 = y0 + num(h[i]) / s;
    const bx0 = num(bx[i]), by0 = num(by[i]);
    return Math.max(bx0 - x0, by0 - y0, x1 - (bx0 + num(bw[i])), y1 - (by0 + num(bh[i]))) * s;
  });
}

/** Nothing past the board's edge shows, as the camera has it or as drawn (`grey`), unless a pan pulled it there: a pan
 * in contact or coasting, until the view is back inside. */
export function coverage(t: FrameTrack): Finding[] {
  const past = pastBoard(t), grey = maybe(t, "grey"), wheel = maybe(t, "wheelPhase"), momentum = maybe(t, "momentumPhase");
  const f1 = maybe(t, "f1x"), gesture = maybe(t, "gesture"), ts = column(t, "t");
  let pulled = false;
  const bad = t.rows.map((_, i) => {
    const out = past[i] > 0.5 || num(grey[i]) > 0.5;
    if (CONTACT_PHASES.has(num(wheel[i])) || num(momentum[i]) !== 0 || (f1[i] !== null && num(gesture[i]) === 0)) pulled = true;
    if (!out) pulled = false;
    return out && !pulled;
  });
  return runs(ts, bad, "coverage", (a, b) => `the view shows ${Math.max(...past.slice(a, b + 1)).toFixed(1)} pt past the board, and ${Math.max(...grey.slice(a, b + 1).map(num)).toFixed(1)} pt drawn past it, with no pan pulling it there`);
}

/** Where a gesture holds: its fingers' centre, else the pointer, in view pt. */
function heldAt(t: FrameTrack, i: number, cols: Record<string, Col>): [number, number] {
  const { f1x, f1y, f2x, f2y, px, py } = cols;
  if (f1x[i] !== null) {
    const two = f2x[i] !== null;
    return [(num(f1x[i]) + (two ? num(f2x[i]) : num(f1x[i]))) / 2, (num(f1y[i]) + (two ? num(f2y[i]) : num(f1y[i]))) / 2];
  }
  return [num(px[i]), num(py[i])];
}

/** While a gesture is in contact, the world point under its centre when it began stays under it, within `tol` view pt. */
export function follow(t: FrameTrack, tol = 0.5): Finding[] {
  const cols = Object.fromEntries(["f1x", "f1y", "f2x", "f2y", "px", "py", "zoom", "camX", "camY", "gesture", "t"].map((f) => [f, column(t, f)]));
  let anchor: [number, number] | null = null;
  const off: number[] = [];
  const bad = t.rows.map((_, i) => {
    const g = num(cols.gesture[i]), z = num(cols.zoom[i]);
    const [hx, hy] = heldAt(t, i, cols);
    const world: [number, number] = [num(cols.camX[i]) + hx / z, num(cols.camY[i]) + hy / z];
    if (g === 1) anchor = world;
    if (g === 0) anchor = null;
    off[i] = anchor ? Math.hypot(world[0] - anchor[0], world[1] - anchor[1]) * z : 0;
    return anchor !== null && off[i] > tol;
  });
  return runs(cols.t, bad, "follow", (a, b) => `the board slipped up to ${Math.max(...off.slice(a, b + 1)).toFixed(1)} pt from under the gesture`);
}

// what a frame may move beyond its input and twice the motion already under way, per 16 ms: a spring's start
const EPS_ZOOM = 0.02, EPS_PAN = 4, FRAME = 16;

/** No frame moves the camera, or its zoom, further than its input moved it and the motion already under way carried it,
 * nor turns back without input; and a pan's coast takes over its speed, within half to twice. A gap of more than
 * `gapMs` with no input is not judged, as a busy device's late frame is no jump. */
export function continuity(t: FrameTrack, { gapMs = 34 } = {}): Finding[] {
  const c = Object.fromEntries(["t", "zoom", "camX", "camY", "viewW", "viewH", "px", "py", "magnify", "wheelDX", "wheelDY", "wheelPhase", "momentumPhase", "f1x", "f1y", "f2x", "f2y", "gesture"].map((f) => [f, column(t, f)]));
  const n = t.rows.length, out: Finding[] = [];
  const lz = c.zoom.map((z) => Math.log(num(z)));
  // the world point at the view's centre, in view pt at that frame's zoom
  const centre = (i: number, axis: "X" | "Y") => num(c[`cam${axis}`][i]) + num(c[axis === "X" ? "viewW" : "viewH"][i]) / 2 / num(c.zoom[i]);
  const input = (i: number) => num(c.magnify[i]) !== 0 || num(c.wheelDX[i]) !== 0 || num(c.wheelDY[i]) !== 0 || CONTACT_PHASES.has(num(c.wheelPhase[i])) || c.f1x[i] !== null;
  const band = (d: number, prevRate: number, dt: number, allowance: number, eps: number) => {
    const carried = 2 * prevRate * dt, e = (eps * dt) / FRAME;
    return d < Math.min(0, carried) - allowance - e || d > Math.max(0, carried) + allowance + e;
  };
  let prevZ = 0, prevX = 0, prevY = 0;
  for (let i = 1; i < n; i++) {
    const dt = num(c.t[i]) - num(c.t[i - 1]);
    if (dt <= 0) continue;
    const z = num(c.zoom[i]);
    const dz = lz[i] - lz[i - 1], dx = (centre(i, "X") - centre(i - 1, "X")) * z, dy = (centre(i, "Y") - centre(i - 1, "Y")) * z;
    if (dt > gapMs && !input(i)) { prevZ = dz / dt; prevX = dx / dt; prevY = dy / dt; continue; }
    const zin = Math.abs(Math.log(1 + num(c.magnify[i]))) * 1.5;
    const [hx, hy] = heldAt(t, i, c);
    const fingers = c.f1x[i] !== null && c.f1x[i - 1] !== null ? Math.hypot(...heldAt(t, i, c).map((v, k) => v - heldAt(t, i - 1, c)[k]) as [number, number]) : 0;
    const panIn = Math.hypot(num(c.wheelDX[i]), num(c.wheelDY[i])) + fingers;
    const zoomShiftX = Math.abs(dz) * Math.abs(hx - num(c.viewW[i]) / 2) * 1.5, zoomShiftY = Math.abs(dz) * Math.abs(hy - num(c.viewH[i]) / 2) * 1.5;
    const what = band(dz, prevZ, dt, zin, EPS_ZOOM) ? `zoom by ${(Math.exp(dz) * 100 - 100).toFixed(1)} %`
      : band(dx, prevX, dt, panIn + zoomShiftX, EPS_PAN) ? `${dx.toFixed(1)} pt across`
      : band(dy, prevY, dt, panIn + zoomShiftY, EPS_PAN) ? `${dy.toFixed(1)} pt down` : null;
    if (what) out.push({ rule: "continuity", from: num(c.t[i - 1]), to: num(c.t[i]), say: `one frame moved ${what}, more than its input and the motion under way` });
    prevZ = dz / dt; prevX = dx / dt; prevY = dy / dt;
  }
  // a pan's hand-off: the frame its contact ends, the wheel's phase ended or the last finger up
  const speed = (i: number) => {
    const dt = num(c.t[i]) - num(c.t[i - 1]);
    return dt > 0 ? Math.hypot(centre(i, "X") - centre(i - 1, "X"), centre(i, "Y") - centre(i - 1, "Y")) * num(c.zoom[i]) / dt : 0;
  };
  for (let h = 4; h + 3 < n; h++) {
    const ended = (num(c.wheelPhase[h]) === 8 && CONTACT_PHASES.has(num(c.wheelPhase[h - 1]))) || (c.f1x[h] === null && c.f1x[h - 1] !== null && num(c.gesture[h - 1]) === 0);
    if (!ended) continue;
    const before = (speed(h - 2) + speed(h - 1) + speed(h)) / 3, after = (speed(h + 1) + speed(h + 2) + speed(h + 3)) / 3;
    if (before < EPS_PAN / FRAME) continue;
    if (after < before / 2 || after > before * 2)
      out.push({ rule: "continuity", from: num(c.t[h - 2]), to: num(c.t[h + 3]), say: `the pan's speed went from ${(before * FRAME).toFixed(1)} to ${(after * FRAME).toFixed(1)} pt a frame as it was let go` });
  }
  return out.sort((a, b) => a.from - b.from);
}

/** Nothing in `fields` leaves its value and comes back within `maxFrames` frames. */
export function flicker(t: FrameTrack, fields: string[], maxFrames = 3): Finding[] {
  const ts = column(t, "t"), out: Finding[] = [];
  for (const f of fields) {
    const v = column(t, f).map(num);
    const same = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.5, 0.01 * Math.abs(b));
    for (let i = 1; i < v.length; i++) {
      if (same(v[i], v[i - 1])) continue;
      const k = Array.from({ length: maxFrames }, (_, j) => i + j).find((k) => k + 1 < v.length && same(v[k + 1], v[i - 1]));
      if (k === undefined) continue;
      out.push({ rule: "flicker", from: num(ts[i]), to: num(ts[k]), say: `${f} went from ${v[i - 1]} to ${v[i]} for ${k - i + 1} frame${k > i ? "s" : ""} and back` });
      i = k + 1;
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

/** Nothing drawn in `fields` jumps more than `max` from one frame to the next: grey that grew with a pinch and goes in
 * a frame as it ends reads as a flash, where what grew goes as it came. */
export function pops(t: FrameTrack, fields: string[], max: number): Finding[] {
  const ts = column(t, "t"), out: Finding[] = [];
  for (const f of fields) {
    const v = column(t, f).map(num);
    for (let i = 1; i < v.length; i++)
      if (Math.abs(v[i] - v[i - 1]) > max) out.push({ rule: "flicker", from: num(ts[i - 1]), to: num(ts[i]), say: `${f} jumped from ${v[i - 1]} to ${v[i]} in one frame` });
  }
  return out.sort((a, b) => a.from - b.from);
}

/** While the zoom holds, the scrollers' knobs keep their size. */
export function scrollers(t: FrameTrack): Finding[] {
  const z = column(t, "zoom").map(num), kh = column(t, "knobH").map(num), kv = column(t, "knobV").map(num), ts = column(t, "t");
  const bad = z.map((_, i) => i > 0 && Math.abs(z[i] - z[i - 1]) < 1e-9 && (Math.abs(kh[i] - kh[i - 1]) > 0.002 || Math.abs(kv[i] - kv[i - 1]) > 0.002));
  return runs(ts, bad, "scrollers", (a, b) => `a scroller's knob changed size at a steady zoom, ${kh[a - 1]}→${kh[b]} across and ${kv[a - 1]}→${kv[b]} down`);
}

/** When a track's gesture begins: its first frame of a pinch, a wheel in contact or a finger, else its first frame. */
function startOf(t: FrameTrack): number {
  const g = column(t, "gesture"), w = column(t, "wheelPhase"), f = column(t, "f1x"), ts = column(t, "t");
  const i = t.rows.findIndex((_, i) => num(g[i]) === 1 || CONTACT_PHASES.has(num(w[i])) || f[i] !== null);
  return num(ts[Math.max(0, i)]);
}

/** `field` over time as the reference's, from each one's gesture start, within `tol`, every 8 ms both cover, read on a
 * straight line between frames. */
export function curve(t: FrameTrack, ref: FrameTrack, field: string, tol: number): Finding[] {
  const a0 = startOf(t), b0 = startOf(ref);
  const pa = column(t, "t").map((u, i) => [num(u) - a0, num(column(t, field)[i])]), pb = column(ref, "t").map((u, i) => [num(u) - b0, num(column(ref, field)[i])]);
  // on a straight line between frames: a display link skips frames where nothing redraws, 100 ms and more
  const at = (p: number[][], u: number) => {
    const j = p.findIndex(([v]) => v > u);
    if (j <= 0) return j === 0 ? p[0][1] : p.at(-1)![1];
    const [u0, a0] = p[j - 1], [u1, a1] = p[j];
    return a0 + ((a1 - a0) * (u - u0)) / (u1 - u0);
  };
  const end = Math.min(pa.at(-1)![0], pb.at(-1)![0]), times: number[] = [], bad: boolean[] = [], gaps: number[] = [];
  for (let u = 0; u <= end; u += 8) { times.push(u + a0); gaps.push(Math.abs(at(pa, u) - at(pb, u))); bad.push(gaps.at(-1)! > tol); }
  return runs(times, bad, "curve", (a, b) => `${field} parted from the reference's by up to ${Math.max(...gaps.slice(a, b + 1)).toFixed(3)}, past ${tol}`);
}
