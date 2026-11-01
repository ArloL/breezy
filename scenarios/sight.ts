// B1 as an invariant (TESTING.md): after every step a case takes, the card being edited is in sight on its device.
import { brief, LOOKS } from "./record.ts";
import { outOfSight } from "../web/sight.ts";
import type { Device, Sight } from "./device.ts";

export { outOfSight };

/** How long the camera and a phone's keyboard may take to stand still after a step; the card is judged where they come
 * to rest, as a person sees it once the board stops moving. */
const MS = 5000;
/** Steps that only press keys. */
const KEYS = new Set(["key", "type", "compose"]);
/** Methods that move nothing a person sees, and so are no step to check after. */
const PASSIVE = new Set([...LOOKS, "wait", "until", "still", "sight"]);

/** A sight to the point, to tell whether anything still moves. */
const still = (s: Sight | null) => JSON.stringify(s, (_, v) => typeof v === "number" ? Math.round(v) : v);

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
        const ended = Date.now();
        // a reading the page has yet to be told the size of is none alike: the app cannot have moved the board for it
        let s: Sight | null = null, t = 0;
        const read = async () => {
          s = await target.sight();
          return (await target.told()) ? still(s) : `untold ${t}`;
        };
        const seen = [await read()];
        for (; t < MS && (seen.length < n || new Set(seen.slice(-n)).size > 1); t += gap) {
          await target.wait(gap);
          seen.push(await read());
        }
        const problem = s && outOfSight(s);
        if (!problem) return r;
        // late or never: a board that stood still a moment before it moved the card into sight is a fault too, but
        // another one
        // the time waited, or where reads are slow, the time gone
        const since = () => Math.max(t, Date.now() - ended);
        while (since() < MS && s && outOfSight(s)) {
          await target.wait(50);
          t += 50;
          s = await target.sight();
        }
        const then = !s ? "until the edit ended" : outOfSight(s) ? `and still ${since()} ms after the step` : `in sight only ${since()} ms after the step`;
        throw new Error(`out of sight on ${target.kind} after ${prop}(${args.map(brief).join(", ")}): ${problem}, ${then}`);
      };
    },
  });
}
