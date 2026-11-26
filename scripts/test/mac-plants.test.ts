// The Mac's visual glitches, planted (TESTING.md, B8 at L7): a SelfTest stroke on the clean build and on the planted one
// keeps what it drew in scripts/test/fixtures/mac-plants/<plant>/, and the rules over them find nothing on the clean
// build. BREEZY_PLANT naming a plant judges its planted build instead, which scripts/plants.ts requires to fail. Each
// fixture is made on a Mac: fades by scripts/selftest/fades.breezy with -BreezyRecordingOut, its frames kept;
// editor-shift by edit-in-place with -BreezyCaptureOut.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { editorHolds, fades, type Finding } from "../frames/rules.ts";
import type { FrameTrack } from "../../web/flight.ts";

const at = (plant: string) => {
  const which = process.env.BREEZY_PLANT === plant ? "planted" : "clean";
  return JSON.parse(readFileSync(new URL(`./fixtures/mac-plants/${plant}/${which}.json`, import.meta.url), "utf8")) as FrameTrack;
};
const say = (f: Finding[]) => f.map((x) => x.say).join("; ");

test("nothing cross-fades as the cards change", () => assert.equal(say(fades(at("cross-fade"))), ""));

test("a card's pixels hold as its editor opens", () => assert.equal(say(editorHolds(at("editor-shift"))), ""));
