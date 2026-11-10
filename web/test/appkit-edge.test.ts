// The owner's trackpad strokes at the board's edge, as AppKit's NSScrollView moved them, against WheelPan given the
// wheel events Firefox made of the same strokes: docs/superpowers/specs/2026-11-10-breezy-native-reference-design.md.
// Each case is told apart only beyond its noise, how far AppKit's own replay of the stroke landed from it. Where WheelPan
// does not yet move as AppKit does, the gap is held where it is (appkit-edge-known.json) until WheelPan is tuned or
// replaced.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compare } from "./helpers/appkit.ts";
import type { Fixture } from "../../scripts/reference-fixture.ts";

const fixture: Fixture = JSON.parse(readFileSync(new URL("./appkit-edge.json", import.meta.url), "utf8"));
// Where WheelPan moves otherwise than AppKit today, "<case> <measure>" to how far off it is: a ratchet. Such a gap may
// not grow beyond that and the case's noise; once it closes, its entry goes. A gap found anywhere else fails.
const KNOWN: Record<string, number> = JSON.parse(readFileSync(new URL("./appkit-edge-known.json", import.meta.url), "utf8"));

test("the fixture has pushes held and released, flicks from rest and from the middle, a push into a bounce, a pull back and a diagonal", () => {
  const kinds = new Set(fixture.cases.map((c) => c.name.replace(/-\d+$/, "")));
  for (const k of ["push-hold", "release", "flick", "flick-mid", "push-after-bounce", "pull-back", "diagonal"]) assert.ok(kinds.has(k), k);
});

for (const c of fixture.cases) {
  for (const m of compare(c)) {
    const unit = m.k === "settle" ? "ms" : "pt", say = `WheelPan ${m.wheelpan.toFixed(1)} ${unit}, AppKit ${m.appkit.toFixed(1)}, within ${m.within.toFixed(1)}`;
    const known = KNOWN[`${c.name} ${m.k}`];
    if (known === undefined) test(`${c.name}: ${m.k} as AppKit's`, () => assert.ok(m.off <= m.within, say));
    else test(`${c.name}: ${m.k} no further from AppKit's than ${known}`, () => {
      assert.ok(m.off > m.within, `matches AppKit now (${say}): take "${c.name} ${m.k}" out of appkit-edge-known.json`);
      assert.ok(m.off <= known + m.within, `${m.off.toFixed(1)} off, was ${known}: ${say}`);
    });
  }
}
