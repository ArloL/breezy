#!/usr/bin/env node
// Mutation testing of the cores' unit tests (TESTING.md, L1): each module's code changed one operator at a time, in
// copies of the tree so that changes run side by side. A web module's change runs the test files that import it; a
// BreezyKit module's is built once more, incrementally, and runs all of BreezyKit/Tests, which takes 2 s. A change the
// tests pass with survived; one the compiler refuses counts for nothing. node scripts/mutate.ts [--module PREFIX]
// [--update] fails when a module scores below its floor in scripts/mutation-floors.json, which --update sets 2 points
// under the scores of this run; each module's survivors go to build/mutation/.
import { execFile, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export interface Mutant {
  line: number;
  what: string;
  source: string;
}

/** Each operator and what it becomes; comparisons and arithmetic need a space each side, as the code is written, which
 * leaves generics, arrows, signs, ranges and types alone. */
const OPS: [RegExp, (m: string) => string][] = [
  [/ (===|!==) /g, (m) => (m === " === " ? " !== " : " === ")],
  [/ (&&|\|\|) /g, (m) => (m === " && " ? " || " : " && ")],
  [/ (<=|>=|<|>) /g, (m) => ({ " < ": " <= ", " <= ": " < ", " > ": " >= ", " >= ": " > " })[m]!],
  [/ [+-] /g, (m) => (m === " + " ? " - " : " + ")],
  [/\b(true|false)\b/g, (m) => (m === "true" ? "false" : "true")],
];
const SWIFT_OPS: typeof OPS = [...OPS, [/ (==|!=) /g, (m) => (m === " == " ? " != " : " == ")]];

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

/** Swift's `source` with comments and strings blanked, the code in a string's `\(…)` kept. */
function swiftCodeOnly(s: string) {
  const out = s.split("");
  const blank = (from: number, to: number) => { for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = "\0"; };
  const comment = (i: number) => {
    const block = s.startsWith("/*", i), at = s.indexOf(block ? "*/" : "\n", i + 2);
    const end = at < 0 ? s.length : at + (block ? 2 : 0);
    blank(i, end);
    return end;
  };
  /** From `i` to the `)` that closes an interpolation, or the end. */
  const code = (i: number, inner: boolean): number => {
    for (let depth = 0; i < s.length;) {
      if (s.startsWith("//", i) || s.startsWith("/*", i)) i = comment(i);
      else if (s[i] === '"' || s.startsWith('#"', i)) i = string(i);
      else if (s[i] === ")" && inner && depth === 0) return i;
      else {
        if (s[i] === "(") depth++;
        if (s[i] === ")") depth--;
        i++;
      }
    }
    return i;
  };
  const string = (i: number): number => {
    const raw = s[i] === "#", quote = s.startsWith('"""', i + +raw) ? '"""' : '"', close = quote + (raw ? "#" : "");
    let j = i + +raw + quote.length;
    while (j < s.length && !s.startsWith(close, j)) {
      if (!raw && s.startsWith("\\(", j)) {
        blank(i, j + 2);
        i = j = code(j + 2, true);
      } else j += !raw && s[j] === "\\" ? 2 : 1;
    }
    blank(i, j + close.length);
    return j + close.length;
  };
  code(0, false);
  return out.join("");
}

/** Every mutant of `source`, in the order its changes come in it; Swift's when `swift`. */
export function mutants(source: string, swift = false): Mutant[] {
  const code = swift ? swiftCodeOnly(source) : codeOnly(source), found: (Mutant & { at: number })[] = [];
  for (const [re, to] of swift ? SWIFT_OPS : OPS) {
    for (const m of code.matchAll(re)) {
      const from = m[0], into = to(from), at = m.index!;
      found.push({ at, line: source.slice(0, at).split("\n").length, what: `${from.trim()} → ${into.trim()}`, source: source.slice(0, at) + into + source.slice(at + from.length) });
    }
  }
  return found.sort((a, b) => a.at - b.at).map(({ at: _, ...m }) => m);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const KIT = "BreezyKit/Sources/BreezyKit";
/** What each side's tests read: the web's beside web/, and package.json, whose "type": "module" has the vendored Motion
 * set its global; BreezyKit's package, built in each copy once. */
const TREE = { web: ["package.json", "web", "relay/src", "BreezyKit/Tests/Fixtures"], swift: ["BreezyKit/Package.swift", "BreezyKit/Sources", "BreezyKit/Tests"] };
/** The modules whose tests are held to a floor: the web core's pure rules, the camera, the input, and the sync, each
 * with a test of its own; and all of BreezyKit's. */
export const MODULES = [
  "web/rules.ts", "web/model.ts", "web/camera.ts", "web/gestures.ts", "web/mouse.ts", "web/keys.ts", "web/press.ts",
  "web/sync/merge.ts", "web/sync/order-key.ts", "web/sync/records.ts", "web/sync/compact.ts", "web/sync/msgpack.ts", "web/sync/track.ts",
  ...readdirSync(join(root, KIT)).filter((f) => f.endsWith(".swift")).sort().map((f) => `${KIT}/${f}`),
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

const running = new Set<number>();
/** Whether `command` passes within `ms` and `mb`, run in a process group of its own and killed whole: a looping mutant's
 * test file outlived its runner and spun for hours, and BreezyKit's looping tests, which no heap limit holds, outlived
 * theirs and took the Mac's memory. */
export function run(cwd: string, command: string[], ms = 60_000, more: NodeJS.ProcessEnv = {}, mb = 4096): Promise<boolean> {
  return new Promise((resolve) => {
    // a runner of its own, not a subtest of one this runs under
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    const child = spawn(command[0]!, command.slice(1), { cwd, env: { ...env, ...more }, stdio: "ignore", detached: true });
    running.add(child.pid!);
    // the group, and what names the copy: swift test runs its tests in a group of their own, which outlived it, looping
    const copy = /breezy-mutate-[^/]+/.exec(cwd)?.[0];
    const ours = (pgid: number, cmd: string) => pgid === child.pid || (copy !== undefined && cmd.includes(copy));
    const kill = () => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch {}
      // before the copy's next command starts
      if (copy) spawnSync("pkill", ["-9", "-f", copy]);
    };
    const timer = setTimeout(kill, ms);
    // their memory, often enough that a loop allocating as fast as it can is stopped a few GB past `mb`
    const watch = setInterval(() => execFile("ps", ["-axwwo", "pgid=,rss=,command="], { maxBuffer: 64 << 20 }, (_, out) => {
      const kb = out.split("\n").map((l) => /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(l)).filter((m) => m && ours(Number(m[1]), m[3]!)).reduce((sum, m) => sum + Number(m![2]), 0);
      if (kb <= mb * 1024) return;
      console.error(`${cwd}: ${command.join(" ")} killed at ${Math.round(kb / 1024)} MB`);
      kill();
    }), 200);
    child.on("exit", (code) => {
      clearTimeout(timer);
      clearInterval(watch);
      // what the group left behind once its leader ended
      kill();
      running.delete(child.pid!);
      resolve(code === 0);
    });
  });
}

/** BreezyKit's copies built side by side, and compiler jobs each: five copies at a job per core took past 12 GB to
 * build, two at four take 2 GB. */
const SWIFT_COPIES = 2, SWIFT_JOBS = 4;

/** What a mutant of `module` in `dir` came to. */
async function verdict(dir: string, module: string): Promise<"killed" | "survived" | "refused"> {
  if (module.endsWith(".ts")) return (await run(dir, ["node", "--test", ...testsOf(module)])) ? "survived" : "killed";
  // SwiftPM's locks and the tests' files in the copy, removed with it
  const kit = join(dir, "BreezyKit"), env = { TMPDIR: join(dir, "tmp") };
  mkdirSync(env.TMPDIR, { recursive: true });
  if (!(await run(kit, ["swift", "build", "--build-tests", "--jobs", String(SWIFT_JOBS)], 300_000, env))) return "refused";
  return (await run(kit, ["swift", "test", "--skip-build"], 60_000, env)) ? "survived" : "killed";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { module: { type: "string" }, update: { type: "boolean" } } });
  const floors: Record<string, number> = existsSync(FLOORS) ? JSON.parse(readFileSync(FLOORS, "utf8")) : {};
  const modules = values.module ? MODULES.filter((m) => m.startsWith(values.module!)) : MODULES;
  if (!modules.length) throw new Error(`no module starts with ${values.module}`);
  const side = (m: string) => (m.endsWith(".swift") ? "swift" : "web");
  const workers: Record<string, string[]> = {};
  const cleanUp = () => {
    for (const pid of running) try { process.kill(-pid, "SIGKILL"); } catch {}
    for (const dir of Object.values(workers).flat()) rmSync(dir, { recursive: true, force: true });
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => (cleanUp(), process.exit(130)));
  const out = join(root, "build", "mutation");
  mkdirSync(out, { recursive: true });
  let below = 0;
  try {
    for (const s of new Set(modules.map(side))) {
      workers[s] = Array.from({ length: s === "swift" ? SWIFT_COPIES : Math.max(1, Math.floor(cpus().length / 2)) }, () => {
        const dir = mkdtempSync(join(tmpdir(), "breezy-mutate-"));
        for (const t of TREE[s as keyof typeof TREE]) cpSync(join(root, t), join(dir, t), { recursive: true });
        return dir;
      });
      // each copy's first build, and the suite unchanged
      if (s !== "swift") continue;
      const first = await Promise.all(workers[s].map((dir) => verdict(dir, modules.find((m) => side(m) === s)!)));
      const failed = first.findIndex((v) => v !== "survived");
      if (failed >= 0) {
        // once more where all can see why
        const dir = workers[s][failed]!;
        spawnSync("swift", first[failed] === "refused" ? ["build", "--build-tests"] : ["test", "--skip-build"], { cwd: join(dir, "BreezyKit"), env: { ...process.env, TMPDIR: join(dir, "tmp") }, stdio: "inherit" });
        throw new Error(`BreezyKit's tests fail unchanged: ${first.join(", ")}`);
      }
    }
    for (const module of modules) {
      const swift = side(module) === "swift", dirs = workers[side(module)]!;
      const source = readFileSync(join(root, module), "utf8"), all = mutants(source, swift);
      if (!swift && !testsOf(module).length) throw new Error(`no test imports ${module}`);
      if (!swift && (await verdict(dirs[0]!, module)) !== "survived") throw new Error(`${module}'s tests fail unchanged`);
      const survived: Mutant[] = [];
      let refused = 0, next = 0;
      const started = Date.now();
      await Promise.all(dirs.map(async (dir) => {
        for (let i = next++; i < all.length; i = next++) {
          const file = join(dir, module);
          writeFileSync(file, all[i]!.source);
          const v = await verdict(dir, module);
          if (v === "survived") survived.push(all[i]!);
          if (v === "refused") refused++;
          writeFileSync(file, source);
        }
      }));
      const viable = all.length - refused;
      const score = viable ? Math.round(((viable - survived.length) / viable) * 1000) / 10 : 100;
      const floor = floors[module] ?? 0;
      writeFileSync(join(out, `${module.replace(/^web\//, "").replace(/\//g, "-")}.txt`),
        survived.sort((a, b) => a.line - b.line).map((m) => `${module}:${m.line} ${m.what}`).join("\n") + "\n");
      console.log(`${module}: ${score} % of ${viable} killed${refused ? ` (${refused} more refused by the compiler)` : ""}, in ${Math.round((Date.now() - started) / 1000)} s${score < floor ? `, below its floor of ${floor} %` : ""}`);
      if (score < floor) below++;
      if (values.update) floors[module] = Math.max(0, Math.floor(score) - 2);
    }
  } finally {
    cleanUp();
  }
  if (values.update) writeFileSync(FLOORS, `${JSON.stringify(Object.fromEntries(Object.entries(floors).sort()), null, 2)}\n`);
  process.exitCode = below ? 1 : 0;
}
