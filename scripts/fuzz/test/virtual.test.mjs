import { test } from "node:test";
import assert from "node:assert/strict";
import * as V from "../virtual.mjs";

V.install();

test("timers under a context fire in virtual order, and a context's clock carries its skew", () => {
  const a = new V.Context(0, 1), b = new V.Context(1, 2);
  b.skew = 5000;
  const seen = [];
  V.run(a, () => {
    setTimeout(() => seen.push("a300"), 300);
    setTimeout(() => seen.push("a100"), 100);
  });
  V.run(b, () => setTimeout(() => seen.push("b50"), 50));
  assert.equal(V.next(a), V.now + 100);
  V.setTime(V.now + 300);
  V.fire(a);
  assert.deepEqual(seen, ["a100", "a300"]);
  V.fire(b);
  assert.deepEqual(seen, ["a100", "a300", "b50"]);
  const [ta, tb] = [V.run(a, () => Date.now()), V.run(b, () => Date.now())];
  assert.equal(tb - ta, 5000);
});

test("cleared timers do not fire, and timers set while firing for now fire too", () => {
  const a = new V.Context(0, 1);
  const seen = [];
  V.run(a, () => {
    const t = setTimeout(() => seen.push("no"), 10);
    clearTimeout(t);
    setTimeout(() => setTimeout(() => seen.push("chained"), 0), 10);
  });
  V.setTime(V.now + 10);
  V.fire(a);
  assert.deepEqual(seen, ["chained"]);
});

test("random bytes are seeded per context", () => {
  const draw = (seed) => V.run(new V.Context(0, seed), () => crypto.getRandomValues(new Uint8Array(8)).join());
  assert.equal(draw(7), draw(7));
  assert.notEqual(draw(7), draw(8));
});
