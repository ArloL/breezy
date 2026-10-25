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
  /** What the run says when the plant is what failed it, rather than a flake or a crash. */
  expect: RegExp;
  /** What the run needs set, over what the job sets. */
  env?: Record<string, string>;
}

const test = (...args: string[]) => ["node", "--test", "--test-force-exit", ...args];

/** The iOS new card's case failing as the plant makes it: the zoom stopped short, or the card left out of sight. */
const iosNewCard = /fingers edit at 100 %|out of sight on/;

export const PLANTS: Plant[] = [
  { plant: "reveal-current", class: "B1", level: "L3", command: test("--test-name-pattern=25 %", "scenarios/cases.test.ts"), expect: iosNewCard },
  { plant: "reveal-current", class: "B1", level: "L6", command: test("--test-name-pattern=25 %", "scenarios/browsers.e2e.ts"), expect: iosNewCard },
  { plant: "ime-keys", class: "B2", level: "L1", command: test("web/test/ime.test.ts"), expect: /✖ a key an input method takes is composing/ },
  { plant: "lost-release", class: "B3", level: "L1", command: test("web/test/mouse.test.ts"), expect: /✖ a press ends a drag left open by a lost release/ },
  { plant: "merge-local", class: "B4", level: "L1", command: test("web/test/merge.test.ts"), expect: /✖ merges match the shared cases/ },
  { plant: "merge-local", class: "B4", level: "L4", command: ["node", "scripts/fuzz.ts", "--seeds", "1", "--web", "3", "--swift", "0"], expect: /lost in the merge/ },
  { plant: "pushed-skip", class: "B4", level: "L4", command: ["node", "scripts/fuzz.ts", "--seeds", "1", "--web", "2", "--swift", "2"], expect: /boards differ/ },
  { plant: "half-deploy", class: "B5", level: "L1", command: test("web/test/sw.test.ts"), expect: /✖ a deploy caught halfway/ },
  {
    plant: "no-snapshot", class: "B5", level: "L6", env: { SCENARIO_PAIRS: "chromium:chromium" },
    command: test("--test-name-pattern=launched without network", "scenarios/browsers.e2e.ts"), expect: /launched without network/,
  },
  { plant: "half-uploaded", class: "B7", level: "L8", command: ["node", "scripts/deploy-check.ts"], expect: /app\.js is not as built/ },
];

/** The fuzzer takes its plant on its command line, as its hub sets the plant for the devices it runs. */
const withPlant = (p: Plant) => p.command[1] === "scripts/fuzz.ts" ? [...p.command, "--plant", p.plant] : p.command;

/** Whether the run passed; with a plant, whether it failed as the plant makes it fail, or null when it says nothing:
 * killed, or failing some other way, as a flake would. */
function run(p: Plant, planted: boolean): boolean | null {
  const cmd = planted ? withPlant(p) : p.command;
  const { BREEZY_PLANT: _b, SCENARIO_PLANT: _s, ...rest } = process.env;
  const records = { SCENARIO_RECORDS: join(fileURLToPath(new URL("..", import.meta.url)), "build", "plants", "scenarios") };
  const env = planted ? { ...rest, ...records, ...p.env, BREEZY_PLANT: p.plant, SCENARIO_PLANT: p.plant } : { ...rest, ...records, ...p.env };
  const r = spawnSync(cmd[0]!, cmd.slice(1), { env, encoding: "utf8", maxBuffer: 256 << 20, timeout: 30 * 60_000 });
  const dir = join(fileURLToPath(new URL("..", import.meta.url)), "build", "plants");
  mkdirSync(dir, { recursive: true });
  // the plant's records apart from the runs' own, as its case fails on purpose
  writeFileSync(join(dir, `${p.level} ${p.plant}${planted ? "" : " unplanted"}.log`), `${cmd.join(" ")}\n${r.stdout}${r.stderr}`);
  if (r.status === null) return null;
  if (!planted) return r.status === 0;
  return r.status !== 0 && p.expect.test(`${r.stdout}${r.stderr}`) ? false : r.status === 0 ? true : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { level: { type: "string" } } });
  const levels = values.level?.split(",");
  let bad = 0;
  for (const p of PLANTS.filter((p) => !levels || levels.includes(p.level))) {
    const clean = run(p, false), planted = clean ? run(p, true) : null;
    const verdict = !clean ? "FAILS WITHOUT IT" : planted === false ? "caught" : planted === true ? "SURVIVED" : "FAILED OTHERWISE";
    if (verdict !== "caught") bad++;
    console.log(`${p.level} ${p.class} ${p.plant}: ${verdict}`);
  }
  process.exitCode = bad ? 1 : 0;
}
