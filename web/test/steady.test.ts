import { test } from "node:test";
import assert from "node:assert/strict";
import { steadyClock } from "../sync/steady.js";

test("the steady clock follows the monotonic clock when the wall clock goes back, and the wall clock across sleep", () => {
  let wall = 1_000_000, mono = 50;
  const now = steadyClock(() => wall, () => mono);
  const t0 = now();
  [wall, mono] = [wall + 100, mono + 100];
  assert.equal(now() - t0, 100);
  // set back an hour
  [wall, mono] = [wall - 3_600_000, mono + 200];
  assert.equal(now() - t0, 300);
  // asleep for a minute: the monotonic clock stood still
  wall += 60_000;
  assert.equal(now() - t0, 60_300);
});

test("the steady clock keeps time when read often against a wall clock that steps in coarse ticks", () => {
  let mono = 0;
  const now = steadyClock(() => Math.floor(mono / 16.7) * 16.7, () => mono);
  const t0 = now();
  for (let i = 0; i < 60_000; i++) {
    mono += 1;
    now();
  }
  assert.ok(Math.abs(now() - t0 - 60_000) < 50, `${now() - t0}`);
});
