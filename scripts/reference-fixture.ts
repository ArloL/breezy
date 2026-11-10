// Builds web/test/appkit-edge.json from the owner's strokes in the reference app (build/reference/<name>-<n>.json)
// and what Firefox made of each one's median repeat (build/reference/firefox/<name>-<n>.json, the latest kept).
//
//   node scripts/reference-fixture.ts                  writes the fixture
//   node scripts/reference-fixture.ts --median <name>  the path of <name>'s median repeat, to replay
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MARGIN } from "../web/camera.ts";
import { fromClip, type Curve } from "../web/test/helpers/measures.ts";
import { liftOf, measuresOf } from "./reference-check.ts";
import type { Capture, Stroke } from "./replay.ts";

export interface FixtureStroke {
  name: string;
  stage: { w: number; h: number };
  from: { x: number; y: number; zoom: number };
  /** When the finger lifted in the median repeat, ms. */
  lift: number;
  /** The median repeat's camera, which Firefox's events came from. */
  appkit: Curve;
  repeats: Curve[];
  firefox: [t: number, dx: number, dy: number][];
}
export interface Fixture { about: string; strokes: FixtureStroke[] }

const tenth = (n: number) => Math.round(n * 10) / 10;
const curve = (s: Stroke): Curve => fromClip(s.frames).map(([t, x, y]) => [tenth(t), tenth(x), tenth(y)]);

/** The repeat whose overshoot is the median of the repeats'. */
export function median(repeats: Stroke[]): Stroke {
  const sorted = [...repeats].sort((a, b) => measuresOf(a).overshoot - measuresOf(b).overshoot);
  return sorted[(sorted.length - 1) >> 1];
}

const byName = (strokes: Stroke[]) => Map.groupBy(strokes.filter((s) => !s.name.endsWith("-replay")), (s) => s.name);

export function buildFixture(strokes: Stroke[], captures: Record<string, Capture>): Fixture {
  const out: FixtureStroke[] = [];
  for (const [name, repeats] of byName(strokes)) {
    const m = median(repeats), c = captures[name];
    if (!c) throw new Error(`no Firefox capture of ${name}: node scripts/replay.ts "$(node scripts/reference-fixture.ts --median ${name})" --into firefox`);
    out.push({
      name, stage: { w: m.stage[0], h: m.stage[1] }, from: { x: MARGIN - m.start[0], y: MARGIN - m.start[1], zoom: 1 }, lift: liftOf(m),
      appkit: curve(m), repeats: repeats.map(curve), firefox: c.events,
    });
  }
  return {
    about: "The owner's trackpad strokes at the board's edge in AppKit's NSScrollView (Reference/), each repeated, as the camera every frame; and the wheel events Firefox made of the median repeat, posted by scripts/replay.ts. Built by scripts/reference-fixture.ts.",
    strokes: out,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url)), dir = `${root}build/reference`;
  const files = (d: string) => readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => `${d}/${f}`);
  const strokes = files(dir).map((path) => ({ path, s: JSON.parse(readFileSync(path, "utf8")) as Stroke }));
  const at = process.argv.indexOf("--median");
  if (at > 0) {
    const name = process.argv[at + 1], repeats = strokes.filter((x) => x.s.name === name);
    if (!repeats.length) throw new Error(`no strokes named ${name} in ${dir}`);
    const m = median(repeats.map((x) => x.s));
    console.log(repeats.find((x) => x.s === m)!.path);
  } else {
    // the latest capture of each stroke
    const n = (f: string) => Number(/-(\d+)\.json$/.exec(f)![1]);
    const captures: Record<string, Capture> = {};
    for (const f of files(`${dir}/firefox`).sort((a, b) => n(a) - n(b))) captures[f.split("/").pop()!.replace(/-\d+\.json$/, "")] = JSON.parse(readFileSync(f, "utf8"));
    const fixture = buildFixture(strokes.map((x) => x.s), captures);
    writeFileSync(`${root}web/test/appkit-edge.json`, JSON.stringify(fixture));
    console.log(`web/test/appkit-edge.json: ${fixture.strokes.map((s) => `${s.name} ×${s.repeats.length}`).join(", ")}`);
  }
}
