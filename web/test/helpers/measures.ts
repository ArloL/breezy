import { MARGIN, boardOf, panLimits } from "../../camera.ts";
import type { Limits } from "../../camera.ts";

/** The camera over time: [t ms, x, y], zoom 1. */
export type Curve = [t: number, x: number, y: number][];

export interface Measures {
  /** How far past the edge when the finger lifts, in pt. */
  stretch: number;
  /** The furthest past the edge, in pt. */
  overshoot: number;
  /** When it is back within 0.5 pt of the edge for good, in ms. */
  settle: number;
}

type Side = { axis: 1 | 2; limit: number; out: 1 | -1 };

/** An empty board's pan limits at zoom 1 on a stage of `w` × `h`, as the web board and the reference app have them. */
export const referenceLimits = ({ w, h }: { w: number; h: number }): Limits =>
  panLimits(boardOf({ x: 0, y: 0, w: 0, h: 0 }, null), 1, { left: 0, top: 0, right: w, bottom: h });

/** The reference app's clip origins as the web board's camera: the board's top-left is MARGIN up and left of its origin. */
export const fromClip = (frames: number[][]): Curve => frames.map(([t, x, y]) => [t, MARGIN - x, MARGIN - y]);

/** The side of the limits `c` goes furthest past. */
function sideOf(c: Curve, l: Limits): Side {
  const sides: Side[] = [{ axis: 1, limit: l.x0, out: -1 }, { axis: 1, limit: l.x1, out: 1 }, { axis: 2, limit: l.y0, out: -1 }, { axis: 2, limit: l.y1, out: 1 }];
  const past = (s: Side) => Math.max(...c.map((p) => (p[s.axis] - s.limit) * s.out));
  return sides.reduce((a, b) => (past(b) > past(a) ? b : a));
}

const along = (c: Curve, s: Side): [number, number][] => c.map((p) => [p[0], (p[s.axis] - s.limit) * s.out + 0]);

/** How far `c` is past the edge it goes furthest past, over time: positive outward, negative inside. */
export const pastEdge = (c: Curve, l: Limits) => along(c, sideOf(c, l));

export function measure(c: Curve, l: Limits, liftAt: number): Measures {
  const p = pastEdge(c, l);
  const stretch = p.findLast(([t]) => t <= liftAt)?.[1] ?? 0;
  const overshoot = Math.max(...p.map(([, v]) => v));
  const last = p.findLastIndex(([, v]) => v > 0.5);
  return { stretch, overshoot, settle: p[last + 1]?.[0] ?? p.at(-1)![0] };
}

/** What `p` holds at `t`: its last value at or before. */
const at = (p: [number, number][], t: number) => p.findLast(([u]) => u <= t)?.[1] ?? p[0][1];

// how far inside the edge the curves are compared: further in, a board coasting fast is many points off for a few ms
const NEAR = 50;

/** The largest difference past the edge between `a` and `b`, on `a`'s edge, every 8 ms over the time both cover,
 * where either is within NEAR of the edge or past it. */
export function gap(a: Curve, b: Curve, l: Limits): number {
  const s = sideOf(a, l), pa = along(a, s), pb = along(b, s);
  const from = Math.max(pa[0][0], pb[0][0]), to = Math.min(pa.at(-1)![0], pb.at(-1)![0]);
  let most = 0;
  for (let t = from; t <= to; t += 8) {
    const u = at(pa, t), v = at(pb, t);
    if (Math.max(u, v) >= -NEAR) most = Math.max(most, Math.abs(u - v));
  }
  return Math.round(most * 10) / 10;
}
