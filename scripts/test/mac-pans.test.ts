// The owner's 16 pans (straight, diagonal, flicks), recorded on 2026-11-26 in the reference app with its axes free
// (scripts/reference-strokes/pans), as AppKit drew them and replayed them, and as the Mac app replayed them on a board as wide as
// AppKit's (fixtures/mac-pans/board.breezy). Each build's findings are held in mac-pans-known.json, a ratchet as
// mac-pinch.test.ts's. The pinches could not see the owner's diagonal pans held to one axis (#327): none of them pans
// alone, and no rule followed a pan's travel; path does, and these strokes give it pans.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { check, REPLAYED, track } from "../frames/check.ts";
import { path } from "../frames/rules.ts";
import { pathTolerance } from "../frames/sets.ts";

const set = new URL("./fixtures/mac-pans/", import.meta.url).pathname;
const strokes = readdirSync(`${set}reference`).map((f) => f.replace(".json", "")).sort();
const at = (who: string, s: string) => track(`${set}${who}/${s}.json`);
const KNOWN: Record<string, Record<string, string[]>> = JSON.parse(readFileSync(new URL("./mac-pans-known.json", import.meta.url), "utf8"));
setTimeout(() => { console.error("mac-pans ran past 60 s"); process.exit(1); }, 60_000).unref();

test("the set holds straight pans, diagonal pans and flicks", () => {
  for (const k of ["pan-straight", "pan-diagonal", "pan-flick"]) assert.ok(strokes.filter((s) => s.startsWith(k)).length >= 5, k);
});

for (const build of Object.keys(KNOWN))
  test(`${build}: finds only what is known`, () => {
    const found: Record<string, string[]> = {};
    const ref = build === "reference-replay" ? "reference" : "reference-replay";
    for (const s of strokes)
      for (const f of check(at(build, s), at(ref, s), { ...REPLAYED, path: pathTolerance(set, s) })) if (!(found[f.rule] ??= []).includes(s)) found[f.rule].push(s);
    assert.deepEqual(found, KNOWN[build], "a finding gone is a fix: take it out of mac-pans-known.json; a new one is a regression");
  });

test("path finds a diagonal held to the axis it began on, as the Mac app's were before #327, on every diagonal", () => {
  const build = Object.keys(KNOWN).find((b) => b !== "reference-replay")!;
  for (const s of strokes.filter((s) => s.startsWith("pan-diagonal"))) {
    const t = at(build, s), x = t.fields.indexOf("camX"), x0 = t.rows[0]![x];
    const locked = { fields: t.fields, rows: t.rows.map((r) => r.map((v, i) => (i === x ? x0 : v))) };
    assert.ok(path(locked, at("reference-replay", s), pathTolerance(set, s)).length > 0, s);
  }
});
