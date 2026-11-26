// The owner's 41 reference strokes, replayed into Firefox on the dev server with native panning (scripts/web-fixture.ts),
// judged by every rule over frames against AppKit's replay of each. Each build's findings are held in
// web-pinch-known.json, a ratchet as mac-pinch.test.ts's: a finding gone is a fix, to take out; a new one a regression.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { check, REPLAYED, track } from "../frames/check.ts";

/** Firefox's own replay error: its three replays of each stroke parted from one another's zoom by up to 0.204, on
 * pinch-out-slow-4, and slipped the board from under the fingers by up to 0.3 pt; AppKit's replays' stand otherwise. */
export const FIREFOX = { ...REPLAYED, curve: 0.204 };

const dir = new URL("./fixtures/", import.meta.url).pathname;
const KNOWN: Record<string, Record<string, string[]>> = JSON.parse(readFileSync(new URL("./web-pinch-known.json", import.meta.url), "utf8"));

for (const build of Object.keys(KNOWN))
  test(`${build}: finds only what is known`, () => {
    const found: Record<string, string[]> = {};
    for (const f of readdirSync(`${dir}web-pinch/${build}`).sort()) {
      const s = f.replace(".json", "");
      for (const x of check(track(`${dir}web-pinch/${build}/${f}`), track(`${dir}mac-pinch/reference-replay/${f}`), FIREFOX)) {
        if (!(found[x.rule] ??= []).includes(s)) found[x.rule].push(s);
      }
    }
    assert.deepEqual(found, KNOWN[build], "a finding gone is a fix: take it out of web-pinch-known.json; a new one is a regression");
  });
