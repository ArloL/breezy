// B1 as an invariant (TESTING.md): after every step a case takes, the card being edited is in sight on its device.
import { LOOKS } from "./record.ts";
import type { Box, Device, Sight } from "./device.ts";

/** How long a step may leave the edited card out of sight, as the camera and a phone's keyboard settle. */
const MS = 1000;
/** Methods that move nothing a person sees, and so are no step to check after. */
const PASSIVE = new Set([...LOOKS, "wait", "until", "still", "sight"]);

const inside = (a: Box, b: Box) => a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.w <= b.x + b.w + 1 && a.y + a.h <= b.y + b.h + 1;
const fits = (a: Box, b: Box) => a.w <= b.w + 1 && a.h <= b.h + 1;
const say = (b: Box | null) => b ? `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}×${Math.round(b.h)}` : "none";

/** What is wrong with `s`, or null: the edited card shows whole, or of one too big to, its caret does. */
export function outOfSight(s: Sight): string | null {
  const { focus, caret, visible } = s;
  if (!focus) return null;
  if (fits(focus, visible) ? inside(focus, visible) : caret && inside(caret, visible)) return null;
  return `the edited card at ${say(focus)}, its caret at ${say(caret)}, the board showing ${say(visible)}`;
}

/** `d`, checking after each step a case takes on it that the card it edits is in sight within a second; what `d` calls
 * on itself is no step. */
export function watchSight<T extends Device>(d: T): T {
  return new Proxy(d, {
    get: (target, prop) => {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== "function") return v;
      if (typeof prop !== "string" || PASSIVE.has(prop)) return v.bind(target);
      return async (...args: unknown[]) => {
        const r = await v.apply(target, args);
        let problem: string | null = null;
        for (let t = 0; ; t += 50) {
          const s = await target.sight();
          problem = s && outOfSight(s);
          if (!problem || t >= MS) break;
          await target.wait(50);
        }
        if (problem) throw new Error(`out of sight after ${prop}(${args.map((a) => JSON.stringify(a)).join(", ")}): ${problem}`);
        return r;
      };
    },
  });
}
