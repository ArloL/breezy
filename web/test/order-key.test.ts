import { test } from "node:test";
import assert from "node:assert/strict";
import { between, valid, assign } from "../sync/order-key.js";
import { fixture } from "./helpers/fixture.js";

const cases = fixture("order-key.json");

test("order keys match the shared cases", () => {
  for (const [a, b, want] of cases.between) assert.equal(between(a, b), want, `${a} ${b}`);
  for (const c of cases.assign) assert.deepEqual(assign(c.ids, c.keys), c.result, c.name);
});

test("keys made one after another keep increasing", () => {
  const keys = [];
  let last = "";
  for (let i = 0; i < 200; i++) keys.push((last = between(last, null)));
  assert.deepEqual(keys, [...keys].sort());
  assert.equal(new Set(keys).size, 200);
  assert.ok(keys.every(valid));
});

test("a key between two sorts between them", () => {
  let hi = "W";
  for (let i = 0; i < 50; i++) {
    const m = between("V", hi);
    assert.ok("V" < m && m < hi);
    hi = m;
  }
});
