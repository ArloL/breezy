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

test("Swift's equality flips, and its ranges, arrows and generics are left alone", () => {
  const ms = mutants("func f(a: Array<Int>) -> Bool { a.count == 1 && (0..<n).isEmpty != false }\n", true);
  assert.deepEqual(ms.map((m) => m.what), ["== → !=", "&& → ||", "!= → ==", "false → true"]);
  assert.equal(ms[0]!.source, "func f(a: Array<Int>) -> Bool { a.count != 1 && (0..<n).isEmpty != false }\n");
});

test("Swift's strings are left alone but the code they interpolate is not", () => {
  const ms = mutants('let s = "a == b \\(n == 1 ? "x && y" : f(a + b)) c < d" // e > f\nlet t = """\nx < y\n"""\nlet u = #"\\(a + b)"#\n', true);
  assert.deepEqual(ms.map((m) => `${m.line} ${m.what}`), ["1 == → !=", "1 + → -"]);
});

test("an apostrophe is no string in Swift", () => {
  assert.deepEqual(mutants("// the Mac's\nlet a = b < c\n", true).map((m) => m.what), ["< → <="]);
});

test("a command that never ends leaves no process behind once its time is up", async () => {
  const dir = mkdtempSync(join(tmpdir(), "breezy-mutate-test-"));
  try {
    const file = `loop-${process.pid}.test.ts`;
    writeFileSync(join(dir, file), 'import { test } from "node:test";\ntest("loops", () => { for (;;) {} });\n');
    assert.equal(await run(dir, ["node", "--test", file], 2000), false);
    const left = () => { try { return execFileSync("pgrep", ["-f", file], { encoding: "utf8" }).trim(); } catch { return ""; } };
    // the kill lands within a moment
    for (let i = 0; i < 20 && left(); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(left(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a command whose memory grows without end is killed at its limit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "breezy-mutate-test-"));
  try {
    // Buffers, which no heap limit holds; it stops by itself at 2 GB, should the watch fail
    writeFileSync(join(dir, "grow.js"), "const a = []; for (let i = 0; i < 2048; i++) a.push(Buffer.alloc(1 << 20, 1)); setInterval(() => {}, 1000);\n");
    const started = Date.now();
    assert.equal(await run(dir, ["node", "grow.js"], 20_000, {}, 256), false);
    assert.ok(Date.now() - started < 10_000, `killed after ${Date.now() - started} ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("what a command starts in a group of its own is killed with it, as swift test starts its tests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "breezy-mutate-test-"));
  try {
    writeFileSync(join(dir, "loop.js"), "for (;;) {}\n");
    writeFileSync(join(dir, "start.js"), `require("node:child_process").spawn(process.execPath, [${JSON.stringify(join(dir, "loop.js"))}], { detached: true, stdio: "ignore" }).unref(); setInterval(() => {}, 1000);\n`);
    assert.equal(await run(dir, ["node", "start.js"], 1000), false);
    const left = () => { try { return execFileSync("pgrep", ["-f", join(dir, "loop.js")], { encoding: "utf8" }).trim(); } catch { return ""; } };
    assert.equal(left(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
