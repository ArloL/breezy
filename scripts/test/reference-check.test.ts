// The check that a replayed stroke reproduces what AppKit did with the owner's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { check } from "../reference-check.ts";
import type { Stroke } from "../replay.ts";

/** A push 40 pt past the left edge by 200 ms, the lift, then back by 420 ms. */
function stroke(scale = 1, flip = 1): Stroke {
  const events = Array.from({ length: 26 }, (_, i) => [i * 8, flip * -1.6, 0, i === 25 ? 8 : i ? 4 : 1, 0]);
  const frames: number[][] = [];
  for (let t = 0; t <= 600; t += 8) frames.push([t, -scale * (t <= 200 ? (40 * t) / 200 : t <= 420 ? 40 * (1 - (t - 200) / 220) : 0), 813]);
  return { name: "push", stage: [1200, 762], start: [0, 813], events, frames };
}

test("a replay doing as the recording did passes", () => {
  assert.equal(check(stroke(), stroke(), []).ok, true);
});

test("a replay whose deltas are negated fails on the sign", () => {
  const r = check(stroke(), stroke(1, -1), []);
  assert.equal(r.ok, false);
  assert.match(r.lines.join("\n"), /sign/);
});

test("a replay that overshoots by more than the repeats' spread fails", () => {
  const r = check(stroke(), stroke(1.5), [stroke(), stroke(1.05)]);
  assert.equal(r.ok, false);
  assert.match(r.lines.join("\n"), /overshoot/);
});

test("a replay within the repeats' spread passes", () => {
  assert.equal(check(stroke(), stroke(1.1), [stroke(), stroke(1.15)]).ok, true);
});

test("a replay whose events AppKit merged passes, as their deltas still add up", () => {
  const merged = stroke(), e = merged.events;
  merged.events = [e[0], [e[1][0], e[1][1] + e[2][1], 0, 4, 0], ...e.slice(3)];
  assert.equal(check(stroke(), merged, []).ok, true);
});

test("a replay that lost deltas fails", () => {
  const lost = stroke();
  lost.events = lost.events.slice(0, 10);
  assert.match(check(stroke(), lost, []).lines.join("\n"), /deltas/);
});

test("a fast flick whose events of 100 pt and more AppKit merged passes, as one merge moves the running total by a whole event", () => {
  const fast = stroke();
  fast.events = [[0, 2, 0, 1, 0], [8, 150, 0, 4, 0], [16, 160, 0, 4, 0], [24, 0, 0, 8, 0]];
  const merged = { ...fast, events: [[0, 2, 0, 1, 0], [17, 310, 0, 4, 0], [24, 0, 0, 8, 0]] };
  assert.equal(check(fast, merged, []).ok, true);
});
