// The recorder: a bounded ring of what the app saw and decided, on its clock, that never throws into the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { box, Flight } from "../flight.ts";

test("keeps the newest entries, in order, and counts what it dropped", () => {
  const f = new Flight({ size: 4000 });
  for (let i = 0; i < 10_000; i++) f.note("input", "tap", { n: i });
  const r = f.recording();
  assert.equal(r.entries.length, 4000);
  assert.equal(r.entries[0]![3]!.n, 6000);
  assert.equal(r.entries.at(-1)![3]!.n, 9999);
  assert.equal(r.dropped, 6000);
});

test("stamps entries on its clock and its origin on the wall", () => {
  const times = [100, 250.04];
  const f = new Flight({ now: () => times.shift()!, wall: () => 1_000_000 });
  f.note("life", "visible");
  const r = f.recording();
  assert.equal(r.schema, 1);
  assert.equal(r.origin, 1_000_000 - 100);
  assert.deepEqual(r.entries, [[250, "life", "visible"]]);
});

test("never throws", () => {
  const f = new Flight();
  const data = { get x(): number { throw new Error("no"); } };
  f.note("geometry", "viewport", data);
  assert.deepEqual(f.recording().entries[0]!.slice(1), ["geometry", "viewport", { unreadable: true }]);
});

test("keeps what it was given, not what it became", () => {
  const f = new Flight();
  const data = { n: 1 };
  f.note("input", "tap", data);
  data.n = 2;
  assert.equal(f.recording().entries[0]![3]!.n, 1);
});

test("rounds boxes", () => {
  assert.deepEqual(box({ x: 1.234, y: 2, w: 3.06, h: 4 }), [1.2, 2, 3.1, 4]);
  assert.equal(box(null), null);
});
