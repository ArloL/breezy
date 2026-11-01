// The iPhone's keys as sim-finger presses them: each key's up right after its down, as iOS repeats a key whose up comes
// late, and idb's companion sent an Enter's up 913 ms after its down on CI's runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { keyEvents, keystrokes } from "./ios.ts";

const SHIFT = 225;

/** What a US keyboard types for `events`, and the longest any key but Shift was held. */
function typed(events: [number, "down" | "up", number][]) {
  const plain = "abcdefghijklmnopqrstuvwxyz1234567890\n\0\0\0 -=[]\\\0;'`,./";
  const shifted = "ABCDEFGHIJKLMNOPQRSTUVWXYZ!@#$%^&*()\0\0\0\0\0_+{}|\0:\"~<>?";
  const down = new Map<number, number>();
  let at = 0, text = "", held = 0;
  for (const [ms, phase, usage] of events) {
    at += ms;
    if (phase === "down") {
      down.set(usage, at);
      if (usage !== SHIFT) text += (down.has(SHIFT) ? shifted : plain)[usage - 4];
    } else {
      if (usage !== SHIFT) held = Math.max(held, at - down.get(usage)!);
      down.delete(usage);
    }
  }
  assert.deepEqual([...down.keys()], [], "every key let go");
  return { text, held };
}

test("each key goes up 10 ms after it went down, and the keys type the text", () => {
  const text = "Hi you, 42!\nok the quick brown fox";
  const events = keyEvents(keystrokes(text));
  assert.ok(events.every(([ms]) => ms === 10));
  assert.deepEqual(typed(events), { text, held: 10 });
});

test("a character no key types fails before anything is pressed", () => {
  assert.throws(() => keystrokes("é"), /no key types "é"/);
});
