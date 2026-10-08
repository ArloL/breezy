import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeRecord, equalRecords } from "../sync/merge.js";
import { fixture } from "./helpers/fixture.js";

test("merges match the shared cases", () => {
  for (const c of fixture("merge.json")) {
    const r = mergeRecord(c.base, c.local, c.incoming);
    assert.deepEqual(r.record, c.record, c.name);
    assert.deepEqual(r.copy, c.copy, c.name);
  }
});

test("records are equal whatever the order of their fields", () => {
  assert.ok(equalRecords({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }));
  assert.ok(!equalRecords({ a: 1 }, { a: 1, b: 2 }));
  assert.ok(!equalRecords({ a: 1 }, null));
});

test("only a deleted field of exactly true deletes a record", () => {
  const base = { format: 1, kind: "card", board: "B", text: "a", notes: "", color: 1, pos: [0, 0], w: 240, order: "V" };
  const local = { ...base, text: "b" };
  const r = mergeRecord(base, local, { ...base, deleted: 1 });
  assert.equal(r.record.text, "b");
  assert.equal(r.copy, null);
});
