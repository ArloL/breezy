// Mouse and key steps as data, drawn from a seed, so that a run that parts the cores can be printed, replayed and
// shrunk. Only what both cores take: no touch, no editing, which the Mac does in its app, and no point in the edge zone,
// where the web core scrolls and the Swift core leaves that to its view.
import { Rng } from "../../scripts/fuzz/rng.ts";
import { DESKTOP } from "../../web/test/fakes.ts";
import { EDGE_ZONE } from "../../web/physics.ts";
import { LANE_HEADER } from "../../web/rules.ts";
import type { Point } from "../../web/types.ts";
import type { Device, Scene, SceneItem } from "../device.ts";
import type { Steps } from "./core.ts";

/** A point on the k-th card or lane as the scene has them then, at fractions of it, or a point on the board. */
export type At = { card: number; fx: number; fy: number } | { lane: number; part: "header" | "corner" | "body"; fx: number; fy: number } | { x: number; y: number };
export type Step =
  | { do: "drag"; from: At; to: At; shift?: true; option?: true }
  | { do: "click"; at: At; shift?: true }
  | { do: "key"; key: string; meta?: true; shift?: true };

const M = EDGE_ZONE + 16;
const inside = (p: Point): Point => ({ x: Math.min(Math.max(p.x, M), DESKTOP.w - M), y: Math.min(Math.max(p.y, M), DESKTOP.h - M) });

function where(s: Scene, at: At): Point {
  const on = (i: SceneItem, fx: number, fy: number, top = 0, h = i.h - top) => ({ x: i.x + fx * i.w, y: i.y + top + fy * h });
  if ("card" in at) {
    const c = s.cards[at.card % Math.max(s.cards.length, 1)];
    if (c) return inside(on(c, at.fx, at.fy));
  } else if ("lane" in at) {
    const l = s.lanes[at.lane % Math.max(s.lanes.length, 1)];
    if (l) {
      const p = at.part === "header" ? on(l, at.fx, at.fy, 0, LANE_HEADER) : at.part === "corner" ? { x: l.x + l.w - 2 - 6 * at.fx, y: l.y + l.h - 2 - 6 * at.fy } : on(l, at.fx, at.fy, LANE_HEADER);
      return inside(p);
    }
  } else return inside(at);
  return inside({ x: DESKTOP.w / 2, y: DESKTOP.h / 2 });
}

export function run(step: Step): Steps {
  return async (d: Device) => {
    const s = await d.scene();
    if (step.do === "drag") return d.drag(where(s, step.from), where(s, step.to), { shift: step.shift, option: step.option });
    if (step.do === "click") return d.click(where(s, step.at), { shift: step.shift });
    await d.key(step.key, { meta: step.meta, shift: step.shift });
  };
}

const KEYS = ["1", "2", "3", "4", "5", "Backspace", " ", "Escape"];

function at(r: Rng): At {
  const fx = r.float(), fy = r.float();
  switch (r.weighted({ card: 5, lane: 3, board: 2 })) {
    case "card": return { card: r.int(8), fx, fy };
    case "lane": return { lane: r.int(4), part: r.pick(["header", "corner", "body"] as const), fx, fy };
    default: return { x: r.between(0, DESKTOP.w), y: r.between(0, DESKTOP.h) };
  }
}

function step(r: Rng): Step {
  const mods = { ...r.chance(0.15) && { shift: true as const } };
  switch (r.weighted({ drag: 5, click: 3, key: 3, clip: 1, undo: 1 })) {
    case "drag": {
      const from = at(r);
      // a nudge as often as a move, which stays under a drag's threshold or just past it
      const to = r.chance(0.3) && !("x" in from) ? { ...from, fx: from.fx + r.between(-0.02, 0.02), fy: from.fy + r.between(-0.02, 0.02) } : at(r);
      return { do: "drag", from, to, ...mods, ...r.chance(0.1) && { option: true as const } };
    }
    case "click": return { do: "click", at: at(r), ...mods };
    case "key": return { do: "key", key: r.pick(KEYS) };
    case "clip": return { do: "key", key: r.pick(["c", "x", "v"]), meta: true };
    default: return { do: "key", key: "z", meta: true, ...mods };
  }
}

/** A board of a few lanes and cards, made by op where it lies, and `n` steps on it, all from `seed`. */
export function draw(seed: number, n: number) {
  const r = new Rng(seed);
  const lanes = Array.from({ length: r.int(3) }, () => ({ x: r.between(200, 1000), y: r.between(380, 395) }));
  const cards = Array.from({ length: 1 + r.int(5) }, () => ({ x: r.between(M, 900), y: r.between(M, 600) }));
  const setUp: Steps = async (d, made) => {
    for (const l of lanes) made.push(await d.addLane(l.x, l.y));
    for (const c of cards) made.push(await d.addCard(c.x, c.y));
  };
  return { setUp, steps: Array.from({ length: n }, () => step(r)) };
}
