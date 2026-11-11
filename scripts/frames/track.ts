// A frame track, as both cores and the reference apps write it: docs/superpowers/specs/2026-11-11-breezy-native-reference-2-design.md.
import { readFileSync } from "node:fs";
import type { FrameTrack, Recording } from "../../web/flight.ts";

const LISTED: { common: string[]; mac: string[] } = JSON.parse(readFileSync(new URL("./fields.json", import.meta.url), "utf8"));

/** What every platform writes, in order: the time, the camera, the view and the board, the input. */
export const FIELDS: readonly string[] = LISTED.common;
/** What the Mac app writes after them: its scrollers' knobs, and the view past the board's edge as drawn. */
export const MAC_FIELDS: readonly string[] = LISTED.mac;

export function column(t: FrameTrack, name: string): (number | null)[] {
  const i = t.fields.indexOf(name);
  if (i < 0) throw new Error(`the track has no field ${name}: it has ${t.fields.join(", ")}`);
  return t.rows.map((r) => r[i]);
}

export function frames(r: Recording): FrameTrack {
  if (!r.frames) throw new Error("the recording has no frames");
  return r.frames;
}
