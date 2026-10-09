import { test } from "node:test";
import assert from "node:assert/strict";
import { conflicts, holdsOf, lapsed, refusal, unauthenticated, validIDs, HOLD_TIMEOUT_MS, AUTH_TIMEOUT_MS, MAX_HELD } from "../src/holds.js";

const id = (n) => String(n).padStart(22, "A");
const conns = [
  { id: "a", authed: true, opened: 0, last: 0, holds: [id(1), id(2)] },
  { id: "b", authed: true, opened: 0, last: 0, holds: [] },
];

test("an id someone else holds conflicts; one's own do not", () => {
  assert.deepEqual(conflicts(conns, "b", [id(2), id(3)]), [id(2)]);
  assert.deepEqual(conflicts(conns, "a", [id(1)]), []);
});

test("holds list only the connections holding something", () => {
  assert.deepEqual(holdsOf(conns), { a: [id(1), id(2)] });
});

test("holds lapse after the timeout without a message", () => {
  assert.deepEqual(lapsed(conns, HOLD_TIMEOUT_MS), []);
  assert.deepEqual(lapsed(conns, HOLD_TIMEOUT_MS + 1).map((c) => c.id), ["a"]);
});

test("a connection must authenticate in time", () => {
  const all = [{ id: "x", authed: false, opened: 0, last: 0, holds: [] }, ...conns];
  assert.deepEqual(unauthenticated(all, AUTH_TIMEOUT_MS), []);
  assert.deepEqual(unauthenticated(all, AUTH_TIMEOUT_MS + 1).map((c) => c.id), ["x"]);
});

test("ids are 22 base64url characters", () => {
  assert.ok(validIDs([id(1), "AbC-_0123456789abcdefg"]));
  assert.ok(!validIDs(["short"]));
  assert.ok(!validIDs("x"));
  assert.ok(!validIDs([1]));
});

test("a malformed or oversize hold is refused whole", () => {
  const many = Array.from({ length: MAX_HELD }, (_, i) => id(i));
  assert.equal(refusal([], many), null);
  assert.equal(refusal(many.slice(0, 10), many.slice(5)), null);
  assert.deepEqual(refusal([id(MAX_HELD)], many), many);
  assert.deepEqual(refusal([], ["short", id(1)]), ["short", id(1)]);
  assert.deepEqual(refusal([], [1, id(1)]), []);
  assert.deepEqual(refusal([], "x"), []);
});
