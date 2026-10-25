import { test } from "node:test";
import assert from "node:assert/strict";
import { mutants } from "../mutate.ts";

test("each operator gives one mutant per place, with its line", () => {
  const ms = mutants("if (a === b && c < d) return true;\n");
  assert.deepEqual(ms.map((m) => m.what), ["=== → !==", "&& → ||", "< → <=", "true → false"]);
  assert.equal(ms[0]!.source, "if (a !== b && c < d) return true;\n");
  assert.equal(ms[2]!.source, "if (a === b && c <= d) return true;\n");
  assert.ok(ms.every((m) => m.line === 1));
});

test("comments and strings are left alone", () => {
  assert.deepEqual(mutants('// a === b\nconst s = "a < b && true";\n/** x > y */\n'), []);
});

test("generics, arrows and types are no comparisons", () => {
  assert.deepEqual(mutants("const f = <T>(x: T) => x;\nlet m: Map<string, number>;\n"), []);
});

test("a binary plus or minus flips, a sign does not", () => {
  assert.deepEqual(mutants("const a = b + c - d;\nconst e = -f;\n").map((m) => m.what), ["+ → -", "- → +"]);
});
