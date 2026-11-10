// Where the dev server may send its pages for a replay (scripts/replay.ts): a page of its own, asked from this Mac.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gotoTarget } from "../dev-goto.ts";

const ask = { "x-breezy-replay": "1" };

test("a path on the dev server goes through, with its query", () => {
  assert.equal(gotoTarget("/?reference=1194,432&who=ab", ask), "/?reference=1194,432&who=ab");
});

test("a path that a browser reads as another site is refused", () => {
  for (const to of ["//evil.example/", "/\t/evil.example", "/\\evil.example", "http://evil.example/", "https:evil.example", " /x", ""]) assert.equal(gotoTarget(to, ask), null, JSON.stringify(to));
});

test("a request a web page could make is refused: no replay header, or an Origin", () => {
  assert.equal(gotoTarget("/", {}), null);
  assert.equal(gotoTarget("/", { ...ask, origin: "https://evil.example" }), null);
});
