import { test } from "node:test";
import assert from "node:assert/strict";
import { Track } from "../sync/track.js";
import { fixture } from "./helpers/fixture.js";

for (const c of fixture("track.json").cases) {
  test(`track: ${c.name}`, () => {
    const t = new Track();
    for (const [at, arrival, value] of c.samples) t.push(at, arrival, value);
    assert.equal(t.delay, c.delay);
    for (const [now, value] of c.queries) assert.deepEqual(t.sample(now), value, `at ${now}`);
    for (const [now, playing] of c.playing ?? []) assert.equal(t.playing(now), playing, `playing at ${now}`);
  });
}
