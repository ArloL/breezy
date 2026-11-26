// Level 2 (docs/superpowers/plans/2026-11-26-breezy-feel-levels.md, Task 1): the owner's 41 reference strokes, as
// Firefox handed each to the page in camera mode (scripts/web-fixture.ts's captures), replayed in Node through the
// web core, the board's camera, the wheel's pan and the recorder of frames, and judged by every rule against AppKit's
// replay of the stroke. Each build's findings are held in web-core-strokes-known.json, a ratchet as web-pinch's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { replayCapture } from "./helpers/stroke-replay.ts";
import { check, REPLAYED, track } from "../../scripts/frames/check.ts";
import type { FrameTrack } from "../flight.ts";

const fixtures = new URL("../../scripts/test/fixtures/", import.meta.url).pathname;
const KNOWN: Record<string, Record<string, string[]>> = JSON.parse(readFileSync(new URL("./web-core-strokes-known.json", import.meta.url), "utf8"));
setTimeout(() => { console.error("web-core-strokes ran past 60 s"); process.exit(1); }, 60_000).unref();

test("one event a frame reproduces the capture's camera", () => {
  // 20 frames of a wheel 10 pt each, AppKit's way round, inside the board: the view goes 200 pt down it, from -200
  const fields = ["t", "zoom", "camX", "camY", "viewW", "viewH", "px", "py", "wheelDX", "wheelDY", "magnify"];
  const rows = Array.from({ length: 20 }, (_, i) => [i * 8, 1, -300, -200, 1495, 932, 700, 400, 0, -10, 0]);
  const out = replayCapture({ fields, rows } as FrameTrack);
  const y = out.rows.map((r) => r[out.fields.indexOf("camY")]!);
  assert.ok(Math.abs(y.at(-1)! - (-200 + 200)) < 1, `camY ${y[0]} → ${y.at(-1)}, from -200`);
});

for (const build of Object.keys(KNOWN))
  test(`${build}: each stroke replayed in Node, every rule against AppKit's replay`, () => {
    const dir = `${fixtures}web-pinch/${build}`;
    const spread: Record<string, number> = JSON.parse(readFileSync(`${dir}-spread.json`, "utf8"));
    const found: Record<string, string[]> = {};
    for (const f of readdirSync(dir).sort()) {
      const s = f.replace(".json", ""), out = replayCapture(track(`${dir}/${f}`));
      for (const x of check(out, track(`${fixtures}mac-pinch/reference-replay/${f}`), { ...REPLAYED, curve: Math.max(REPLAYED.curve, spread[s] ?? 0) })) {
        if (!(found[x.rule] ??= []).includes(s)) found[x.rule].push(s);
      }
    }
    assert.deepEqual(found, KNOWN[build], "a finding gone is a fix: take it out of web-core-strokes-known.json; a new one is a regression");
  });
