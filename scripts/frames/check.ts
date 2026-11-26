// Prints what the rules over frames find in a recording or frame track, each finding with its frames:
//
//   node scripts/frames/check.ts <recording.json> [--ref <ref.json>] [--replayed]
//
// --ref judges it against the reference's stroke, both aligned at their first input; --replayed allows a replay's own
// error, measured as AppKit's replays of the owner's strokes against their recordings (scripts/test/mac-pinch.test.ts).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FrameTrack } from "../../web/flight.ts";
import { chrome, continuity, coverage, curve, edgePops, fades, flicker, follow, scrollers, type Finding } from "./rules.ts";

/** A replay's own error: AppKit's replays of the owner's strokes slipped the board up to 0.8 pt from under the fingers,
 * parted from the owner's zoom by up to 0.113, on fast pinches, and leapt past the board's corner 30 pt a frame further. */
export const REPLAYED = { follow: 1.5, curve: 0.12, edge: 40 };
export const RECORDED = { follow: 0.5, curve: 0.05, edge: 20 };

/** A recording's frames, or a bare frame track as the fixtures keep it. */
export const track = (path: string): FrameTrack => {
  const j = JSON.parse(readFileSync(path, "utf8"));
  return j.frames ?? j;
};

/** Every rule's findings over `t`, judged against `ref`'s stroke when given. */
export function check(t: FrameTrack, ref?: FrameTrack, tol = RECORDED): Finding[] {
  // each platform's own rules only where its track has their fields: the Mac's knobs and layers, the web's top bar
  const has = (f: string) => t.fields.includes(f);
  const flickers = ["zoom", "grey", "grid", "viewW", "viewH", "boardW", "boardH"].filter(has);
  return [...follow(t, tol.follow), ...coverage(t, ref), ...continuity(t), ...flicker(t, flickers),
    ...edgePops(t, ref, tol.edge), ...(has("knobH") ? scrollers(t) : []), ...(has("fading") ? fades(t) : []),
    ...(has("coverTop") ? chrome(t) : []), ...(ref ? curve(t, ref, "zoom", tol.curve) : [])];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const ref = arg("--ref");
  const found = check(track(process.argv[2]), ref ? track(ref) : undefined, process.argv.includes("--replayed") ? REPLAYED : RECORDED);
  for (const f of found) console.log(`${f.rule}\t${Math.round(f.from)}–${Math.round(f.to)} ms\t${f.say}`);
  if (!found.length) console.log("nothing found");
}
