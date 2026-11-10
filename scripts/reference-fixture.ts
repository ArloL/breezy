// Builds web/test/appkit-edge.json from the cases scripts/reference-batch.ts replayed: each of the owner's strokes in the
// reference app, AppKit's own replay of it, and what Firefox made of it.
//
//   node scripts/reference-fixture.ts
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MARGIN } from "../web/camera.ts";
import { fromClip, gap, referenceLimits, type Curve, type Measures } from "../web/test/helpers/measures.ts";
import { deltas, liftOf, measuresOf } from "./reference-check.ts";
import type { Capture, Stroke } from "./replay.ts";

export interface Case {
  /** The recording's file, without .json. */
  name: string;
  stage: { w: number; h: number };
  from: { x: number; y: number; zoom: number };
  /** When the finger lifted, ms. */
  lift: number;
  /** AppKit's camera every frame, from the owner's stroke. */
  appkit: Curve;
  /** How far AppKit's own replay of the stroke landed from it, on each measure and the gap: what a replay can tell apart. */
  noise: Measures & { gap: number };
  firefox: [t: number, dx: number, dy: number][];
}
export interface Fixture { about: string; cases: Case[] }

const tenth = (n: number) => Math.round(n * 10) / 10;
const curve = (s: Stroke): Curve => fromClip(s.frames).map(([t, x, y]) => [tenth(t), tenth(x), tenth(y)]);

/** A touch, or the tail of momentum after a reset: under 10 events, or the board never moved a point. */
export function isStray(s: Stroke) {
  if (s.events.length < 10 || !s.frames.length) return true;
  const [, x0, y0] = s.frames[0];
  return !s.frames.some(([, x, y]) => Math.abs(x - x0) >= 1 || Math.abs(y - y0) >= 1);
}

export function buildFixture(cases: { file: string; recorded: Stroke; replayed: Stroke; firefox: Capture }[]): Fixture {
  return {
    about: "The owner's trackpad strokes at the board's edge in AppKit's NSScrollView (Reference/), as the camera every frame; how far AppKit's own replay of each landed; and the wheel events Firefox made of the same events, posted by scripts/replay.ts. Built by scripts/reference-fixture.ts from scripts/reference-batch.ts's cases.",
    cases: cases.map(({ file, recorded: r, replayed, firefox }) => {
      // a replay that lost or turned its deltas would make its own noise the tolerance
      const off = deltas(r, replayed);
      if (off.length) throw new Error(`${file}: AppKit's replay is wrong, ${off.join("; ")}; replay it again`);
      const a = measuresOf(r), b = measuresOf(replayed), l = referenceLimits({ w: r.stage[0], h: r.stage[1] });
      return {
        name: file.replace(/\.json$/, ""), stage: { w: r.stage[0], h: r.stage[1] }, from: { x: MARGIN - r.start[0], y: MARGIN - r.start[1], zoom: 1 }, lift: liftOf(r),
        appkit: curve(r),
        noise: { stretch: tenth(Math.abs(a.stretch - b.stretch)), overshoot: tenth(Math.abs(a.overshoot - b.overshoot)), settle: tenth(Math.abs(a.settle - b.settle)), gap: gap(fromClip(r.frames), fromClip(replayed.frames), l) },
        // a wheel event comes of an NSEvent with a delta alone
        firefox: firefox.events.map(([t, dx, dy]) => [tenth(t + (r.events.find((e) => e[1] || e[2])?.[0] ?? 0)), dx, dy]),
      };
    }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const read = (f: string) => JSON.parse(readFileSync(f, "utf8"));
  const cases: { recorded: string; replayed: string; firefox: string; faithful: boolean }[] = read(`${root}build/reference/cases.json`);
  const fixture = buildFixture(cases.map((c) => ({ file: c.recorded.split("/").pop()!, recorded: read(c.recorded), replayed: read(c.replayed), firefox: read(c.firefox) })));
  writeFileSync(`${root}web/test/appkit-edge.json`, JSON.stringify(fixture));
  console.log(`web/test/appkit-edge.json: ${fixture.cases.length} cases`);
}
