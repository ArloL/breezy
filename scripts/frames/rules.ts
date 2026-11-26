// What must hold on every frame of a gesture, as pure functions over a frame track: what the owner reports off is made
// to fail one of these before it is fixed, and each must pass on the platform's reference
// (docs/superpowers/specs/2026-11-11-breezy-native-reference-2-design.md).
import { column } from "./track.ts";
import type { FrameTrack } from "../../web/flight.ts";

export interface Finding {
  rule: "follow" | "coverage" | "continuity" | "flicker" | "scrollers" | "curve" | "path" | "fades" | "editor" | "chrome";
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
 * in contact or coasting, until the view is back inside. Given the reference's stroke, also as far past it as the
 * reference showed at that moment of the stroke, within `tol` pt: AppKit, pinched at its board's corner, keeps the
 * board under the fingers past the edge and draws it back once they lift (the owner's ruling: grey past the edge only
 * where the reference shows it). */
export function coverage(t: FrameTrack, ref?: FrameTrack, tol = 2): Finding[] {
  const past = pastBoard(t), grey = maybe(t, "grey"), wheel = maybe(t, "wheelPhase"), momentum = maybe(t, "momentumPhase");
  const f1 = maybe(t, "f1x"), gesture = maybe(t, "gesture"), ts = column(t, "t");
  const shown = past.map((p, i) => Math.max(p, num(grey[i])));
  let allowed = (_: number) => 0.5;
  if (ref) {
    const a0 = startOf(t), b0 = startOf(ref), rt = column(ref, "t").map((u) => num(u) - b0), rg = maybe(ref, "grey");
    const rp = pastBoard(ref).map((p, i) => Math.max(p, num(rg[i])));
    // the most the reference showed within a frame either side, on a straight line between its frames
    const at = (u: number) => {
      const j = rt.findIndex((v) => v > u);
      if (j <= 0) return j === 0 ? rp[0] : rp.at(-1)!;
      return rp[j - 1] + ((rp[j] - rp[j - 1]) * (u - rt[j - 1])) / (rt[j] - rt[j - 1]);
    };
    allowed = (i) => Math.max(...[-FRAME, 0, FRAME].map((s) => at(num(ts[i]) - a0 + s))) + tol;
  }
  let pulled = false;
  const bad = t.rows.map((_, i) => {
    const out = shown[i] > 0.5;
    if (CONTACT_PHASES.has(num(wheel[i])) || num(momentum[i]) !== 0 || (f1[i] !== null && num(gesture[i]) === 0)) pulled = true;
    if (!out) pulled = false;
    return out && !pulled && shown[i] > allowed(i);
  });
  return runs(ts, bad, "coverage", (a, b) => {
    const theirs = ref ? `, where the reference's showed ${Math.max(0, ...Array.from({ length: b - a + 1 }, (_, k) => allowed(a + k) - tol)).toFixed(1)} pt` : ", with no pan pulling it there";
    return `the view shows ${Math.max(...past.slice(a, b + 1)).toFixed(1)} pt past the board, and ${Math.max(...grey.slice(a, b + 1).map(num)).toFixed(1)} pt drawn past it${theirs}`;
  });
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
  const lz = c.zoom.map((z) => Math.log(num(z))), past = pastBoard(t);
  // the world point at the view's centre, in view pt at that frame's zoom
  const centre = (i: number, axis: "X" | "Y") => num(c[`cam${axis}`][i]) + num(c[axis === "X" ? "viewW" : "viewH"][i]) / 2 / num(c.zoom[i]);
  const input = (i: number) => num(c.magnify[i]) !== 0 || num(c.wheelDX[i]) !== 0 || num(c.wheelDY[i]) !== 0 || CONTACT_PHASES.has(num(c.wheelPhase[i])) || c.f1x[i] !== null;
  // the motion under way: each axis's slowest and fastest rate over the last 34 ms, as AppKit steps its zoom every
  // other frame on a 120 Hz display and a late frame's next catches up
  const rates: { t: number; z: number; x: number; y: number }[] = [];
  const under = (k: "z" | "x" | "y", now: number) => {
    const r = rates.filter((q) => now - q.t <= 34).map((q) => q[k]);
    return r.length ? [Math.min(...r), Math.max(...r)] : [0, 0];
  };
  const band = (d: number, [lo, hi]: number[], dt: number, allowance: number, eps: number) => {
    const e = (eps * dt) / FRAME;
    return d < Math.min(0, 2 * lo * dt) - allowance - e || d > Math.max(0, 2 * hi * dt) + allowance + e;
  };
  const push = (i: number, dz: number, dx: number, dy: number, dt: number) => rates.push({ t: num(c.t[i]), z: dz / dt, x: dx / dt, y: dy / dt });
  // AppKit starts a motion of its own as a gesture ends, as a two-finger double tap's zoom, easing in from rest
  let ended = -Infinity;
  for (let i = 1; i < n; i++) {
    const dt = num(c.t[i]) - num(c.t[i - 1]);
    if (num(c.gesture[i - 1]) === 3) ended = num(c.t[i - 1]);
    if (dt <= 0) continue;
    const z = num(c.zoom[i]);
    const dz = lz[i] - lz[i - 1], dx = (centre(i, "X") - centre(i - 1, "X")) * z, dy = (centre(i, "Y") - centre(i - 1, "Y")) * z;
    if (dt > gapMs && !input(i)) { push(i, dz, dx, dy, dt); continue; }
    const starting = num(c.t[i]) - ended <= 50 ? 2 : 1;
    const zin = Math.abs(Math.log(1 + num(c.magnify[i]))) * 1.5;
    const [hx, hy] = heldAt(t, i, c);
    const fingers = c.f1x[i] !== null && c.f1x[i - 1] !== null ? Math.hypot(...heldAt(t, i, c).map((v, k) => v - heldAt(t, i - 1, c)[k]) as [number, number]) : 0;
    // a scroll's delta moves the view in its frame or the next, as AppKit applies it
    const panIn = Math.max(Math.hypot(num(c.wheelDX[i]), num(c.wheelDY[i])), Math.hypot(num(c.wheelDX[i - 1]), num(c.wheelDY[i - 1]))) + fingers;
    // once nothing touches, AppKit's settle zooms about a point of its own, anywhere in the view
    const touching = num(c.gesture[i]) === 1 || num(c.gesture[i]) === 2 || CONTACT_PHASES.has(num(c.wheelPhase[i])) || c.f1x[i] !== null;
    // the zoom under way, as AppKit steps it every other frame while the camera moves on every frame
    const zr = under("z", num(c.t[i - 1])), zoomed = Math.max(Math.abs(dz), Math.max(Math.abs(zr[0]), Math.abs(zr[1])) * dt);
    const zoomShiftX = zoomed * (touching ? Math.abs(hx - num(c.viewW[i]) / 2) : num(c.viewW[i]) / 2) * 1.5;
    const zoomShiftY = zoomed * (touching ? Math.abs(hy - num(c.viewH[i]) / 2) : num(c.viewH[i]) / 2) * 1.5;
    // and pulls a view past the board back, as a spring, harder the further past: a tenth of it each 16 ms at most
    const pull = touching ? 0 : (0.1 * Math.max(0, past[i - 1]) * dt) / FRAME;
    const now = num(c.t[i - 1]);
    const what = band(dz, under("z", now), dt, zin, EPS_ZOOM * starting) ? `zoom by ${(Math.exp(dz) * 100 - 100).toFixed(1)} %`
      : band(dx, under("x", now), dt, panIn + zoomShiftX + pull, EPS_PAN * starting) ? `${dx.toFixed(1)} pt across`
      : band(dy, under("y", now), dt, panIn + zoomShiftY + pull, EPS_PAN * starting) ? `${dy.toFixed(1)} pt down` : null;
    if (what) out.push({ rule: "continuity", from: num(c.t[i - 1]), to: num(c.t[i]), say: `one frame moved ${what}, more than its input and the motion under way` });
    push(i, dz, dx, dy, dt);
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

/** How far the view reaches past the board, the camera's or as drawn, never leaps in one frame: no further than the
 * reference's furthest leap in its stroke and `margin` pt more, as AppKit's own at its board's corner come back by up to
 * 85 pt a frame; with no reference, `margin` + 10, as the owner's video shows the band shooting in by 30 to 52 pt. */
export function edgePops(t: FrameTrack, ref?: FrameTrack, margin = 20): Finding[] {
  const reach = (u: FrameTrack) => { const g = maybe(u, "grey"); return pastBoard(u).map((p, i) => Math.max(0, p, num(g[i]))); };
  const leaps = (r: number[]) => r.slice(1).map((v, i) => Math.abs(v - r[i]));
  const max = ref ? Math.max(0, ...leaps(reach(ref))) + margin : margin + 10;
  const r = reach(t), ts = column(t, "t"), out: Finding[] = [];
  leaps(r).forEach((d, i) => {
    if (d > max) out.push({ rule: "flicker", from: num(ts[i]), to: num(ts[i + 1]), say: `the view's reach past the board went from ${r[i].toFixed(0)} to ${r[i + 1].toFixed(0)} pt in one frame, past ${max.toFixed(0)}` });
  });
  return out;
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
  const past = pastBoard(t);
  // steady for two frames running: AppKit steps a zoom every other frame on a 120 Hz display; and inside the board, as
  // AppKit's knobs shrink while the view overscrolls
  const steady = (i: number) => i > 1 && Math.abs(z[i] - z[i - 1]) < 1e-9 && Math.abs(z[i - 1] - z[i - 2]) < 1e-9;
  const bad = z.map((_, i) => steady(i) && past[i] <= 0.5 && past[i - 1] <= 0.5 && (Math.abs(kh[i] - kh[i - 1]) > 0.002 || Math.abs(kv[i] - kv[i - 1]) > 0.002));
  return runs(ts, bad, "scrollers", (a, b) => `a scroller's knob changed size at a steady zoom, ${kh[a - 1]}→${kh[b]} across and ${kv[a - 1]}→${kv[b]} down`);
}

/** When a track's gesture begins: its first frame with any input, a pinch's step, a wheel's delta or phase, a gesture
 * or a finger, else its first frame; a recorder may keep no gesture's begin, and its frames may start before it. */
function startOf(t: FrameTrack): number {
  const [g, w, dx, dy, m, f] = ["gesture", "wheelPhase", "wheelDX", "wheelDY", "magnify", "f1x"].map((k) => maybe(t, k)), ts = column(t, "t");
  const i = t.rows.findIndex((_, i) => num(g[i]) !== 0 || num(w[i]) !== 0 || num(dx[i]) !== 0 || num(dy[i]) !== 0 || num(m[i]) !== 0 || f[i] !== null);
  return num(ts[Math.max(0, i)]);
}

/** `field` over time as the reference's, from each one's gesture start, within `tol`, every 8 ms both cover, read on a
 * straight line between frames. */
export function curve(t: FrameTrack, ref: FrameTrack, field: string, tol: number, slackMs = 0): Finding[] {
  const a0 = startOf(t), b0 = startOf(ref);
  const pa = column(t, "t").map((u, i) => [num(u) - a0, num(column(t, field)[i])]), pb = column(ref, "t").map((u, i) => [num(u) - b0, num(column(ref, field)[i])]);
  // on a straight line between frames: a display link skips frames where nothing redraws, 100 ms and more
  const at = (p: number[][], u: number) => {
    const j = p.findIndex(([v]) => v > u);
    if (j <= 0) return j === 0 ? p[0][1] : p.at(-1)![1];
    const [u0, a0] = p[j - 1], [u1, a1] = p[j];
    return a0 + ((a1 - a0) * (u - u0)) / (u1 - u0);
  };
  // to the later end, the other held at its last frame: a recorder writes no frame while the view is still, and a
  // track that ends early, as a page that never saw the gesture, is still and not done
  const end = Math.max(pa.at(-1)![0], pb.at(-1)![0]), times: number[] = [], bad: boolean[] = [], gaps: number[] = [];
  // with `slackMs`, how far from the reference's values within that much either way: a replay's input, sent from
  // outside the browser, comes a frame early or late, which on a fast zoom reads as a gap of 0.1 and more
  const off = (u: number) => {
    const a = at(pa, u);
    let lo = Infinity, hi = -Infinity;
    for (let d = -slackMs; d <= slackMs; d += 4) { const b = at(pb, u + d); lo = Math.min(lo, b); hi = Math.max(hi, b); }
    return a < lo ? lo - a : a > hi ? a - hi : 0;
  };
  for (let u = 0; u <= end; u += 8) { times.push(u + a0); gaps.push(off(u)); bad.push(gaps.at(-1)! > tol); }
  return runs(times, bad, "curve", (a, b) => `${field} parted from the reference's by up to ${Math.max(...gaps.slice(a, b + 1)).toFixed(3)}, past ${tol}`);
}

/** A pan travels as AppKit's did: how far the view has gone since its first input, in view pt, against how far the
 * reference's had at the same time, never more than `tol` apart. Travel rather than place, as the boards differ; a view
 * that zooms, as with a pinch or a double tap, travels with its zoom, which curve judges, so such a stroke is left alone.
 * The owner's diagonal pans on the Mac held to one axis, which no other rule saw (#327). */
export function path(t: FrameTrack, ref: FrameTrack, tol = 20): Finding[] {
  // from each track's first wheel delta: one track's began phase may come a frame or more before its first delta, which
  // on a pan of 0.7 pt/ms read as 34 pt of travel apart where the two moved alike frame for frame
  const firstDelta = (x: FrameTrack) => {
    const dx = maybe(x, "wheelDX"), dy = maybe(x, "wheelDY"), i = x.rows.findIndex((_, i) => num(dx[i]) !== 0 || num(dy[i]) !== 0);
    return i < 0 ? startOf(x) : num(column(x, "t")[i]);
  };
  // from the stroke on: the Mac app opens a wide board fitted to its window, at 25 %, before the replay sets its zoom
  const zooms = (x: FrameTrack) => {
    const s0 = firstDelta(x), ts = column(x, "t"), z = column(x, "zoom").map(num).filter((_, i) => num(ts[i]) >= s0);
    return z.length > 0 && Math.max(...z) - Math.min(...z) > 0.001;
  };
  if (zooms(t) || zooms(ref)) return [];
  const travel = (x: FrameTrack) => {
    const s0 = firstDelta(x), ts = column(x, "t").map((u) => num(u) - s0), z = column(x, "zoom").map((v) => num(v) || 1);
    const cx = column(x, "camX").map(num), cy = column(x, "camY").map(num);
    const at = (c: number[], u: number) => {
      const j = ts.findIndex((v) => v > u);
      if (j <= 0) return j === 0 ? c[0]! : c.at(-1)!;
      return c[j - 1]! + ((c[j]! - c[j - 1]!) * (u - ts[j - 1]!)) / (ts[j]! - ts[j - 1]!);
    };
    // from where the view was before the first delta: Firefox gathers a gesture's first events into one, and its frame
    // shows the view already moved by it, 25 to 34 pt on the owner's pans
    const zx = cx.map((v, i) => v * z[i]!), zy = cy.map((v, i) => v * z[i]!), k = Math.max(0, ts.findIndex((u) => u >= 0) - 1);
    const x0 = ts[k]! < 0 ? zx[k]! : at(zx, 0), y0 = ts[k]! < 0 ? zy[k]! : at(zy, 0);
    return { end: ts.at(-1)!, at: (u: number) => [at(zx, u) - x0, at(zy, u) - y0] as const };
  };
  const a = travel(t), b = travel(ref), a0 = firstDelta(t), times: number[] = [], bad: boolean[] = [], gaps: number[] = [];
  for (let u = 0; u <= Math.max(a.end, b.end); u += 8) {
    const [ax, ay] = a.at(u), [bx, by] = b.at(u);
    times.push(u + a0);
    gaps.push(Math.hypot(ax - bx, ay - by));
    bad.push(gaps.at(-1)! > tol);
  }
  return runs(times, bad, "path", (i, j) => `the view travelled up to ${Math.max(...gaps.slice(i, j + 1)).toFixed(1)} pt otherwise than the reference's, past ${tol}`);
}

/** Nothing on the Mac's board animates as its cards change, which AppKit's implicit actions on the cards' host layer did,
 * fading the whole board in from its last frame (5c41379): no frame with an animation on that layer. */
export function fades(t: FrameTrack): Finding[] {
  const n = maybe(t, "fading").map(num), ts = column(t, "t");
  return runs(ts, n.map((v) => v > 0), "fades", (a, b) => `the cards' host layer animated for ${b - a + 1} frame${b > a ? "s" : ""}: the board cross-faded`);
}

/** A capture of a card as its editor opens holds its pixels: at each step, a zoom, dark or light and front or back, no
 * more than `max` of the card's pixels change, as the editor drew text off the bitmap's pixels (5d78bca). */
export function editorHolds(t: FrameTrack, max = 10): Finding[] {
  const [z, dark, back, n] = ["zoom", "dark", "back", "changed"].map((f) => column(t, f).map(num));
  return n.flatMap((c, i) => c > max ? [{ rule: "editor", from: i, to: i,
    say: `${c} pixels of the card's ${back[i] ? "back" : "front"} changed as its editor opened at ${z[i]} in ${dark[i] ? "dark" : "light"}` }] : []);
}


/** The chrome is never covered by the board: no frame where the board paints over the web's top bar, as native
 * panning's pinch overlay did on iOS (11a483a). */
export function chrome(t: FrameTrack): Finding[] {
  const c = maybe(t, "coverTop").map(num);
  return runs(column(t, "t"), c.map((v) => v > 0), "chrome", (a, b) => `the board painted over the top bar for ${b - a + 1} frame${b > a ? "s" : ""}`);
}
