// IosDevice.calibrate against a page and a tap that only take time: on CI's runner idb's first tap took 8.74 s to return.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { IosDevice } from "./ios.ts";

function device(t: TestContext, tap: (taps: number) => boolean, { tapMs = 0, readMs = 100 } = {}) {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["Date"] });
  let tapped: { x: number; y: number } | null = null, taps = 0;
  const page = {
    evaluate: async (fn: () => unknown) => {
      const src = String(fn);
      if (src.includes("screen.width")) return { w: 400, h: 800 };
      if (src.includes("tapped ?? null")) {
        t.mock.timers.tick(readMs);
        return tapped;
      }
      return src.includes("visibilityState") ? "the page" : undefined;
    },
  };
  const hid = {
    touches: async () => {
      t.mock.timers.tick(tapMs);
      if (tap(++taps)) tapped = { x: 200, y: 380 };
    },
  };
  const d = new IosDevice("ios-safari", page as never, hid as never, {} as never);
  d.finger = {} as never;
  return { d, taps: () => taps };
}

test("a tap whose call takes longer than the wait for it counts once it returns", { timeout: 10_000 }, async (t) => {
  const { d, taps } = device(t, () => true, { tapMs: 8740 });
  await d.calibrate();
  assert.equal(taps(), 1);
  assert.deepEqual(d.offset, { x: 0, y: 20 });
});

test("a tap unseen is tried again, and three unseen fail naming what the page saw", { timeout: 10_000 }, async (t) => {
  const seen = device(t, (taps) => taps === 3, { readMs: 500 });
  await seen.d.calibrate();
  assert.equal(seen.taps(), 3);
  const never = device(t, () => false, { readMs: 500 });
  await assert.rejects(never.d.calibrate(), /never saw the calibrating tap at 200,400: the page/);
  assert.equal(never.taps(), 3);
});
