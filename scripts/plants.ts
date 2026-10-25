#!/usr/bin/env node
// The plants that prove each level fails on its classes (TESTING.md's matrix): each is a past bug put back by name, and
// each level's run must pass without it and fail with it. node scripts/plants.ts [--level L1,L3] keeps each run's output
// in build/plants/ and exits 1 when a plant survives or a level fails without one.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export interface Plant {
  plant: string;
  class: string;
  level: string;
  /** The level's run; a plant BREEZY_PLANT names reaches Node, the hub and pages, SCENARIO_PLANT real devices. */
  command: string[];
}

const test = (...args: string[]) => ["node", "--test", "--test-force-exit", ...args];

export const PLANTS: Plant[] = [
  { plant: "reveal-current", class: "B1", level: "L3", command: test("--test-name-pattern=25 %", "scenarios/cases.test.ts") },
  { plant: "reveal-current", class: "B1", level: "L6", command: test("--test-name-pattern=25 %", "scenarios/browsers.e2e.ts") },
  { plant: "ime-keys", class: "B2", level: "L1", command: test("web/test/ime.test.ts") },
  { plant: "lost-release", class: "B3", level: "L1", command: test("web/test/mouse.test.ts") },
  { plant: "merge-local", class: "B4", level: "L1", command: test("web/test/merge.test.ts") },
  { plant: "merge-local", class: "B4", level: "L4", command: ["node", "scripts/fuzz.ts", "--seeds", "1", "--web", "3", "--swift", "0"] },
  { plant: "pushed-skip", class: "B4", level: "L4", command: ["node", "scripts/fuzz.ts", "--seeds", "1", "--web", "2", "--swift", "2"] },
  { plant: "half-deploy", class: "B5", level: "L1", command: test("web/test/sw.test.ts") },
];

/** The fuzzer takes its plant on its command line, as its hub sets the plant for the devices it runs. */
const withPlant = (p: Plant) => p.command[1] === "scripts/fuzz.ts" ? [...p.command, "--plant", p.plant] : p.command;

function run(p: Plant, planted: boolean) {
  const cmd = planted ? withPlant(p) : p.command;
  const { BREEZY_PLANT: _b, SCENARIO_PLANT: _s, ...rest } = process.env;
  const env = planted ? { ...rest, BREEZY_PLANT: p.plant, SCENARIO_PLANT: p.plant } : rest;
  const r = spawnSync(cmd[0]!, cmd.slice(1), { env, encoding: "utf8", maxBuffer: 256 << 20, timeout: 30 * 60_000 });
  const dir = join(fileURLToPath(new URL("..", import.meta.url)), "build", "plants");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${p.level} ${p.plant}${planted ? "" : " unplanted"}.log`), `${cmd.join(" ")}\n${r.stdout}${r.stderr}`);
  return r.status === 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { level: { type: "string" } } });
  const levels = values.level?.split(",");
  let bad = 0;
  for (const p of PLANTS.filter((p) => !levels || levels.includes(p.level))) {
    const clean = run(p, false), caught = clean && !run(p, true);
    const verdict = !clean ? "FAILS WITHOUT IT" : caught ? "caught" : "SURVIVED";
    if (verdict !== "caught") bad++;
    console.log(`${p.level} ${p.class} ${p.plant}: ${verdict}`);
  }
  process.exitCode = bad ? 1 : 0;
}
