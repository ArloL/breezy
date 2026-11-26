// The recorder: a bounded ring of what the app saw and decided, on its clock, that never throws into the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { box, Flight, thrown } from "../flight.ts";

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

test("keeps the device's context apart from the ring, so a long session still says which device it was", () => {
  const f = new Flight({ size: 10 });
  f.context({ model: "iPhone" });
  for (let i = 0; i < 100; i++) f.note("input", "tap");
  assert.deepEqual(f.recording().context, { model: "iPhone" });
});

test("an error is kept as a hash of its message and where it was thrown, never its words", () => {
  const e = new Error("card x.js:12 said hello");
  e.stack = "Error: card x.js:12 said hello\n    at reveal (https://breezy.k5d.de/app-3f2a.js:41:7)";
  assert.equal(thrown(e).where, "app-3f2a.js:41");
  assert.match(String(thrown(e).message), /^23:[0-9a-f]+$/);
  assert.ok(!JSON.stringify(thrown(e)).includes("hello"));
});

test("keeps nothing on a page that turned recording off, for its cost to be measured against", () => {
  const g = globalThis as { __breezyNoFlight?: boolean };
  g.__breezyNoFlight = true;
  try {
    const f = new Flight();
    f.note("input", "tap");
    assert.deepEqual(f.recording().entries, []);
  } finally {
    delete g.__breezyNoFlight;
  }
});

test("rounds boxes", () => {
  assert.deepEqual(box({ x: 1.234, y: 2, w: 3.06, h: 4 }), [1.2, 2, 3.1, 4]);
  assert.equal(box(null), null);
});

const row = (v: number) => Flight.frameFields.slice(1).map((f) => (f === "f1x" ? null : v));

test("frames keep thirty seconds at 120 Hz", () => {
  let now = 0;
  const f = new Flight({ now: () => now });
  for (let i = 0; i < 7200; i++) {
    now = i * 8.3;
    f.frame(row(i));
  }
  const rows = f.recording().frames!.rows;
  assert.ok(rows.every((r) => r[0]! >= now - 30_000), "a row older than 30 s");
  assert.ok(rows[0]![0]! < now - 29_990, "dropped a row within 30 s");
});

test("frame fields match the checker", () => {
  const listed = JSON.parse(readFileSync(new URL("../../scripts/frames/fields.json", import.meta.url), "utf8"));
  assert.deepEqual(Flight.frameFields, [...listed.common, ...listed.web]);
});

test("a frame of another length is not kept", () => {
  const f = new Flight();
  f.frame([1, 2, 3]);
  assert.equal(f.recording().frames, undefined);
});

test("no frames while recording is off", () => {
  const g = globalThis as { __breezyNoFlight?: boolean };
  g.__breezyNoFlight = true;
  try {
    const f = new Flight();
    f.frame(row(1));
    assert.equal(f.recording().frames, undefined);
  } finally {
    delete g.__breezyNoFlight;
  }
});

test("frames hold numbers only", () => {
  const f = new Flight();
  f.frame(row(1.25));
  const t = f.recording().frames!;
  assert.deepEqual(t.fields, Flight.frameFields);
  assert.ok(t.rows.flat().every((v) => v === null || typeof v === "number"));
});
