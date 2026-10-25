// B1 as an invariant (TESTING.md): after every step a case takes, the card being edited is in sight on its device.
import { brief, LOOKS } from "./record.ts";
import type { Box, Device, Sight } from "./device.ts";

/** How long the camera and a phone's keyboard may take to stand still after a step; the card is judged where they come
 * to rest, as a person sees it once the board stops moving. */
const MS = 5000;
/** Steps that only press keys. */
const KEYS = new Set(["key", "type", "compose"]);
/** Methods that move nothing a person sees, and so are no step to check after. */
const PASSIVE = new Set([...LOOKS, "wait", "until", "still", "sight"]);

const inside = (a: Box, b: Box) => a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.w <= b.x + b.w + 1 && a.y + a.h <= b.y + b.h + 1;
/** Whether the app shows `a` whole in `b`: within 16 pt of each edge, else only the caret's line (app.ts, revealEditing). */
const fits = (a: Box, b: Box) => a.w + 32 <= b.w + 1 && a.h + 32 <= b.h + 1;
/** A sight to the point, to tell whether anything still moves. */
const still = (s: Sight | null) => JSON.stringify(s, (_, v) => typeof v === "number" ? Math.round(v) : v);
const say = (b: Box | null) => b ? `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}×${Math.round(b.h)}` : "none";

/** What is wrong with `s`, or null: the edited card shows whole, or of one too big to, its caret does. */
export function outOfSight(s: Sight): string | null {
  const { focus, caret, visible } = s;
  if (!focus) return null;
  if (fits(focus, visible) ? inside(focus, visible) : caret && inside(caret, visible)) return null;
  return `the edited card at ${say(focus)}, its caret at ${say(caret)}, the board showing ${say(visible)}${s.how ? ` (${s.how})` : ""}`;
}

/** `d`, checking after each step a case takes on it that, once the board stands still, the card it edits is in sight;
 * what `d` calls on itself is no step. */
export function watchSight<T extends Device>(d: T): T {
  return new Proxy(d, {
    get: (target, prop) => {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== "function") return v;
      if (typeof prop !== "string" || PASSIVE.has(prop)) return v.bind(target);
      return async (...args: unknown[]) => {
        const r = await v.apply(target, args);
        // readings alike: after a key, two 20 ms apart, as what a key sets moving moves every frame; after anything
        // else three 50 ms apart, as a phone's keyboard may still be on its way
        const [n, gap] = KEYS.has(prop) ? [2, 20] : [3, 50];
        // and first, after a gesture, until the device says it stands still: on CI's Android emulator three readings
        // alike came 460 ms after a double tap, the keyboard just up and the app yet to move the card above it, and Safari
        // on iOS held still for a moment after a double tap before its zoom began
        if (!KEYS.has(prop)) await target.still(`the board to stand still after ${prop}`).catch(() => {});
        let s = await target.sight(), seen = [still(s)];
        for (let t = 0; t < MS && (seen.length < n || new Set(seen.slice(-n)).size > 1); t += gap) {
          await target.wait(gap);
          s = await target.sight();
          seen.push(still(s));
        }
        const problem = s && outOfSight(s);
        if (problem) throw new Error(`out of sight on ${target.kind} after ${prop}(${args.map(brief).join(", ")}): ${problem}`);
        return r;
      };
    },
  });
}
