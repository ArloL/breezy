import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutants, run } from "../mutate.ts";

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

test("a mutant that never ends leaves no process behind once its time is up", async () => {
  const dir = mkdtempSync(join(tmpdir(), "breezy-mutate-test-"));
  try {
    const file = `loop-${process.pid}.test.ts`;
    writeFileSync(join(dir, file), 'import { test } from "node:test";\ntest("loops", () => { for (;;) {} });\n');
    assert.equal(await run(dir, [file], 2000), false);
    const left = () => { try { return execFileSync("pgrep", ["-f", file], { encoding: "utf8" }).trim(); } catch { return ""; } };
    // the kill lands within a moment
    for (let i = 0; i < 20 && left(); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(left(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
