import { readFileSync } from "node:fs";
import { Camera } from "../../camera.ts";
import { WheelPan } from "../../wheel.ts";
import type { Limits } from "../../camera.ts";
import type { Cam } from "../../types.ts";

export interface Gesture { name: string; stage?: { w: number; h: number }; from: Cam; restsAt: { x: number; y: number }; events: [number, number, number][] }
export const trace: { stage: { w: number; h: number }; gestures: Gesture[] } =
  JSON.parse(readFileSync(new URL("../trackpad-edge.json", import.meta.url), "utf8"));

/** Plays `g`'s wheel events through a WheelPan on a fake clock at 120 frames a second, resting the stream as View
 * does `rest` ms after its last event; gives the camera's x each frame, from the first event, and when momentum was
 * handed to the spring. */
export function replay(g: Gesture, limits: Limits, rest = 120, onStream?: WheelPan["onStream"]) {
  let t = 0, queue: ((t: number) => void)[] = [];
  const cam = new Camera(() => {}, { now: () => t, raf: (f) => queue.push(f), caf: () => (queue = []) });
  cam.limits = () => limits;
  cam.set(g.from);
  const springs: number[] = [];
  const rebound = cam.rebound.bind(cam);
  cam.rebound = (to, v) => (springs.push(t), rebound(to, v));
  const size = g.stage ?? trace.stage, stage = { left: 0, top: 0, right: size.w, bottom: size.h };
  const w = new WheelPan(cam, () => limits, () => stage);
  if (onStream) w.onStream = onStream;
  const xs: [number, number][] = [];
  const end = g.events.at(-1)![0] + rest + 1500;
  let i = 0, idleAt = Infinity;
  for (; t <= end; t += 1) {
    while (i < g.events.length && g.events[i][0] <= t) {
      const [, dx, dy] = g.events[i++];
      w.scroll({ x: -dx, y: -dy }, t);
      idleAt = t + rest;
    }
    if (t >= idleAt) { w.idle(); idleAt = Infinity; }
    if (t % 8 === 0) {
      const q = queue; queue = [];
      for (const f of q) f(t);
      xs.push([t, cam.cam.x]);
    }
  }
  return Object.assign(xs, { springs });
}
