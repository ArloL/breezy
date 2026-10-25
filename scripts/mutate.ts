#!/usr/bin/env node
// Mutation testing of the web core's unit tests (TESTING.md, L1): each module's code changed one operator at a time,
// and the test files that import it run against each change, in copies of the tree so that changes run side by side.
// A change the tests pass with survived. node scripts/mutate.ts [--module web/rules.ts] [--update] fails when a module
// scores below its floor in scripts/mutation-floors.json, which --update raises to the scores of this run; each
// module's survivors go to build/mutation/.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export interface Mutant {
  line: number;
  what: string;
  source: string;
}

/** Each operator and what it becomes; comparisons and arithmetic need a space each side, as the code is written, which
 * leaves generics, arrows, signs and types alone. */
const OPS: [RegExp, (m: string) => string][] = [
  [/ (===|!==) /g, (m) => (m === " === " ? " !== " : " === ")],
  [/ (&&|\|\|) /g, (m) => (m === " && " ? " || " : " && ")],
  [/ (<=|>=|<|>) /g, (m) => ({ " < ": " <= ", " <= ": " < ", " > ": " >= ", " >= ": " > " })[m]!],
  [/ [+-] /g, (m) => (m === " + " ? " - " : " + ")],
  [/\b(true|false)\b/g, (m) => (m === "true" ? "false" : "true")],
];

/** `source` with everything but code blanked: comments, strings and template literals. */
function codeOnly(source: string) {
  let out = "", i = 0;
  while (i < source.length) {
    const c = source[i]!, two = source.slice(i, i + 2);
    let end = i + 1;
    if (two === "//") end = source.indexOf("\n", i) < 0 ? source.length : source.indexOf("\n", i);
    else if (two === "/*") end = source.indexOf("*/", i + 2) < 0 ? source.length : source.indexOf("*/", i + 2) + 2;
    else if (c === '"' || c === "'" || c === "`") {
      for (end = i + 1; end < source.length && source[end] !== c; end++) if (source[end] === "\\") end++;
      end++;
    } else {
      out += c;
      i++;
      continue;
    }
    out += source.slice(i, end).replace(/[^\n]/g, "\0");
    i = end;
  }
  return out;
}

/** Every mutant of `source`, in the order its changes come in it. */
export function mutants(source: string): Mutant[] {
  const code = codeOnly(source), found: (Mutant & { at: number })[] = [];
  for (const [re, to] of OPS) {
    for (const m of code.matchAll(re)) {
      const from = m[0], into = to(from), at = m.index!;
      found.push({ at, line: source.slice(0, at).split("\n").length, what: `${from.trim()} → ${into.trim()}`, source: source.slice(0, at) + into + source.slice(at + from.length) });
    }
  }
  return found.sort((a, b) => a.at - b.at).map(({ at: _, ...m }) => m);
}

const root = fileURLToPath(new URL("..", import.meta.url));
/** What the web tests read beside web/, and package.json, whose "type": "module" has the vendored Motion set its global. */
const TREE = ["package.json", "web", "relay/src", "BreezyKit/Tests/Fixtures"];
/** The modules whose tests are held to a floor: the web core's pure rules, the camera, the input, and the sync, each with a test of its own. */
export const MODULES = [
  "web/rules.ts", "web/model.ts", "web/camera.ts", "web/gestures.ts", "web/mouse.ts", "web/keys.ts", "web/press.ts",
  "web/sync/merge.ts", "web/sync/order-key.ts", "web/sync/records.ts", "web/sync/compact.ts", "web/sync/msgpack.ts", "web/sync/track.ts",
];
const FLOORS = join(root, "scripts/mutation-floors.json");

/** The test files that import `module`. */
function testsOf(module: string) {
  const dir = join(root, "web/test");
  return readdirSync(dir).filter((f) => f.endsWith(".test.ts")).filter((f) => {
    const imports = [...readFileSync(join(dir, f), "utf8").matchAll(/from "(\.[^"]+)"/g)].map((m) => join(dir, m[1]!));
    return imports.includes(join(root, module));
  }).map((f) => join("web/test", f));
}

function run(cwd: string, tests: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("node", ["--test", ...tests], { cwd, stdio: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("exit", (code) => (clearTimeout(timer), resolve(code === 0)));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { module: { type: "string" }, update: { type: "boolean" } } });
  const floors: Record<string, number> = existsSync(FLOORS) ? JSON.parse(readFileSync(FLOORS, "utf8")) : {};
  const modules = values.module ? [values.module] : MODULES;
  const workers = Array.from({ length: Math.max(1, Math.floor(cpus().length / 2)) }, () => {
    const dir = mkdtempSync(join(tmpdir(), "breezy-mutate-"));
    for (const t of TREE) cpSync(join(root, t), join(dir, t), { recursive: true });
    return dir;
  });
  const out = join(root, "build", "mutation");
  mkdirSync(out, { recursive: true });
  let below = 0;
  try {
    for (const module of modules) {
      const tests = testsOf(module), source = readFileSync(join(root, module), "utf8"), all = mutants(source);
      if (!tests.length) throw new Error(`no test imports ${module}`);
      if (!(await run(workers[0]!, tests))) throw new Error(`${module}'s tests fail unchanged`);
      const survived: Mutant[] = [];
      let next = 0;
      await Promise.all(workers.map(async (dir) => {
        for (let i = next++; i < all.length; i = next++) {
          const file = join(dir, module);
          writeFileSync(file, all[i]!.source);
          if (await run(dir, tests)) survived.push(all[i]!);
          writeFileSync(file, source);
        }
      }));
      const score = all.length ? Math.round(((all.length - survived.length) / all.length) * 1000) / 10 : 100;
      const floor = floors[module] ?? 0;
      writeFileSync(join(out, `${relative("web", module).replace(/\//g, "-")}.txt`),
        survived.sort((a, b) => a.line - b.line).map((m) => `${module}:${m.line} ${m.what}`).join("\n") + "\n");
      console.log(`${module}: ${score} % of ${all.length} killed${score < floor ? `, below its floor of ${floor} %` : ""}`);
      if (score < floor) below++;
      if (values.update) floors[module] = score;
    }
  } finally {
    for (const dir of workers) rmSync(dir, { recursive: true, force: true });
  }
  if (values.update) writeFileSync(FLOORS, `${JSON.stringify(Object.fromEntries(Object.entries(floors).sort()), null, 2)}\n`);
  process.exitCode = below ? 1 : 0;
}
