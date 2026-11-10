// The owner's trackpad strokes at the board's edge, as AppKit's NSScrollView moved them, against WheelPan given the
// wheel events Firefox made of the same strokes: docs/superpowers/specs/2026-11-10-breezy-native-reference-design.md.
// Each case is told apart only beyond its noise, how far AppKit's own replay of the stroke landed from it. Where WheelPan
// does not yet move as AppKit does, the case is a todo naming the gap (appkit-edge-known.json), until WheelPan is tuned
// or replaced.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gap, measure, referenceLimits } from "./helpers/measures.ts";
import type { Curve } from "./helpers/measures.ts";
import { replay } from "./helpers/replay.ts";
import type { Case, Fixture } from "../../scripts/reference-fixture.ts";

const fixture: Fixture = JSON.parse(readFileSync(new URL("./appkit-edge.json", import.meta.url), "utf8"));
const FLOOR = { stretch: 2, overshoot: 2, settle: 16, gap: 2 };
// Where WheelPan moves otherwise than AppKit today, as "<case> <measure>": a todo until it is tuned or replaced. A gap
// found anywhere else fails.
const KNOWN = new Set<string>(JSON.parse(readFileSync(new URL("./appkit-edge-known.json", import.meta.url), "utf8")));
const KEYS = ["stretch", "overshoot", "settle", "gap"] as const;

/** What WheelPan, given Firefox's events, and AppKit did with a case, on each measure. */
export function compare(c: Case) {
  const l = referenceLimits(c.stage);
  const web: Curve = replay({ name: c.name, stage: c.stage, from: c.from, restsAt: { x: 0, y: 0 }, events: c.firefox }, l).track;
  const a = { ...measure(c.appkit, l, c.lift), gap: 0 }, w = { ...measure(web, l, c.lift), gap: gap(c.appkit, web, l) };
  return KEYS.map((k) => ({ k, appkit: a[k], wheelpan: w[k], within: Math.max(FLOOR[k], c.noise[k]), off: Math.abs(a[k] - w[k]) }));
}

test("the fixture has pushes held and released, flicks from rest and from the middle, a push into a bounce, a pull back and a diagonal", () => {
  const kinds = new Set(fixture.cases.map((c) => c.name.replace(/-\d+$/, "")));
  for (const k of ["push-hold", "release", "flick", "flick-mid", "push-after-bounce", "pull-back", "diagonal"]) assert.ok(kinds.has(k), k);
});

for (const c of fixture.cases) {
  for (const m of compare(c)) {
    const unit = m.k === "settle" ? "ms" : "pt", say = `WheelPan ${m.wheelpan.toFixed(1)} ${unit}, AppKit ${m.appkit.toFixed(1)}, within ${m.within.toFixed(1)}`;
    const todo = KNOWN.has(`${c.name} ${m.k}`) ? `${m.k}: ${say}` : undefined;
    test(`${c.name}: ${m.k} as AppKit's`, { todo }, () => assert.ok(m.off <= m.within, say));
  }
}
