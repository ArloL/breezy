// The rules over frames on the owner's 41 reference strokes (Reference/, take 5), replayed into the Mac app: they find
// nothing on AppKit's own, as recorded or replayed, and pinpoint each of the four things the owner saw on the bounded
// board at 7e0248e (docs/superpowers/specs/2026-11-11-breezy-native-reference-2-design.md). Each build's findings are
// held in mac-pinch-known.json, a ratchet: a fix shows as a finding gone, to take out. The fixtures are made on the
// owner's Mac by scripts/frames-fixture.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { check, REPLAYED, RECORDED, track } from "../frames/check.ts";
import { coverage, curve, edgePops, flicker, scrollers, type Finding } from "../frames/rules.ts";
import type { FrameTrack } from "../../web/flight.ts";

const dir = new URL("./fixtures/mac-pinch/", import.meta.url).pathname;
const strokes = readdirSync(dir + "reference").map((f) => f.replace(".json", "")).sort();
const at = (who: string, s: string) => track(`${dir}${who}/${s}.json`);
const KNOWN: Record<string, Record<string, string[]>> = JSON.parse(readFileSync(new URL("./mac-pinch-known.json", import.meta.url), "utf8"));
const where = (f: Finding[]) => f.slice(0, 2).map((x) => `${x.rule} ${Math.round(x.from)}–${Math.round(x.to)} ms: ${x.say}`).join("; ");

/** What the owner said of the bounded board, and the checks that find it, each against AppKit's replay of the stroke. */
const REPORTS: Record<string, (t: FrameTrack, ref: FrameTrack) => Finding[]> = {
  "the background looks off": (t, ref) => coverage(t, ref),
  "the background flickers": (t, ref) => edgePops(t, ref, REPLAYED.edge),
  "the scrollbars are weird": (t) => [...scrollers(t), ...flicker(t, ["viewW", "viewH", "boardW", "boardH"])],
  "it jumps back weirdly": (t, ref) => curve(t, ref, "zoom", REPLAYED.curve),
};

test("the owner's strokes, as AppKit drew them, pass every rule", () => {
  for (const s of strokes) assert.deepEqual(check(at("reference", s), at("reference", s), RECORDED), [], s);
});

test("AppKit's replays of them pass every rule, against the owner's", () => {
  for (const s of strokes) assert.equal(where(check(at("reference-replay", s), at("reference", s), REPLAYED)), "", s);
});

for (const [report, find] of Object.entries(REPORTS))
  test(`bounded-7e0248e: ${report}`, () => {
    const found = strokes.filter((s) => find(at("bounded-7e0248e", s), at("reference-replay", s)).length);
    assert.deepEqual(found, KNOWN["bounded-7e0248e"][report], `found on ${found.join(", ")}`);
    const s = found[0];
    assert.ok(s, "pinpointed on no stroke");
    assert.match(where(find(at("bounded-7e0248e", s), at("reference-replay", s))), /ms:/);
  });

for (const build of Object.keys(KNOWN).filter((b) => b !== "bounded-7e0248e"))
  test(`${build}: finds only what is known`, () => {
    const found: Record<string, string[]> = {};
    for (const s of strokes)
      for (const f of check(at(build, s), at("reference-replay", s), REPLAYED)) if (!(found[f.rule] ??= []).includes(s)) found[f.rule].push(s);
    assert.deepEqual(found, KNOWN[build], "a finding gone is a fix: take it out of mac-pinch-known.json; a new one is a regression");
  });
