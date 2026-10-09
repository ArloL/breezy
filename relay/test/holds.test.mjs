import { test } from "node:test";
import assert from "node:assert/strict";
import { conflicts, holdsOf, lapsed, unauthenticated, validIDs, HOLD_TIMEOUT_MS, AUTH_TIMEOUT_MS } from "../src/holds.js";

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
