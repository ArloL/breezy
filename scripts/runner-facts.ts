#!/usr/bin/env node
// What ran under a night's cases, job by job, from what each case recorded: the runner's load, the stalls of the process
// driving the case, how long simctl took, what was busiest, and the environment. With --against, the same held to another
// run: what changed in the environment, and how long the cases that passed on both took.
//   node scripts/runner-facts.ts DIR... [--against DIR...] [--json FILE]
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runs } from "./controls.ts";

/** Over this, the driving process stood still long enough to fail a wait. */
const STALL_MS = 5000;
// what says something ran, not how the page or the iPhone felt about it
const NOISE = /^(runner|iPhone log)|page$|^d\d+ \S+ (app|page)$/;
const QUIET = /^(page |relay |app |push |pull )/;

export interface Line { at: number; who: string; text: string }
interface Spread { n: number; median: number; p95: number; max: number }
export interface Stall { test: string; lateMs: number; at: number; around: string[]; firstCase: boolean }
/** A case that failed, where in its job it ran and at what load: a job's first cases run as its iPhone still settles. */
export interface Failure { test: string; position: number; load: number | null; error: string }
export interface JobFacts {
  job: string;
  environment: Record<string, unknown>;
  cases: number;
  failed: number;
  failures: Failure[];
  load: Spread | null;
  firstCaseLoad: Spread | null;
  stalledCases: number;
  stalls: Stall[];
  simctl: Record<string, Spread & { failed: number }>;
  busiest: { name: string; percent: number }[];
  ms: Record<string, number>;
}

export function parseTimeline(text: string): Line[] {
  const lines: Line[] = [];
  for (const l of text.split("\n")) {
    const m = /^\S+\s+\+(-?\d+)\s+(\S+(?: \S+)*?)\s{2,}(.*)$/.exec(l);
    if (m) lines.push({ at: Number(m[1]), who: m[2]!, text: m[3]! });
  }
  return lines;
}

export function spread(values: number[]): Spread | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return { n: s.length, median: at(0.5), p95: at(0.95), max: s.at(-1)! };
}

/** What began while the process stood still, and just before: a synchronous call shows here, as it notes when it began. */
function around(lines: Line[], at: number, lateMs: number): string[] {
  return lines
    .filter((l) => l.at >= at - lateMs - 1000 && l.at <= at && !NOISE.test(l.who) && !QUIET.test(l.text))
    .map((l) => `${l.who}: ${l.text.replace(/[0-9A-F]{8}-[0-9A-F-]{27}/g, "U").slice(0, 70)}`)
    .slice(0, 4);
}

export function jobFacts(dir: string): JobFacts {
  const all = [...runs(dir)].sort((a, b) => String(a.started).localeCompare(String(b.started)));
  const envFile = join(dir, "environment.json");
  const load: number[] = [], stalls: Stall[] = [], calls: Record<string, number[]> = {}, failed: Record<string, number> = {};
  const busy: Record<string, number> = {}, ms: Record<string, number> = {};
  let firstCaseLoad: number[] = [], samples = 0, stalledCases = 0;
  const failures: Failure[] = [];
  all.forEach((r, i) => {
    if (r.verdict === "passed") ms[r.test] = r.ms;
    const path = join(r.dir, "timeline.txt");
    if (!existsSync(path)) return;
    const lines = parseTimeline(readFileSync(path, "utf8"));
    const before = stalls.length;
    for (const l of lines) {
      if (l.who === "runner") {
        const m = /^load ([\d.]+) of \d+ CPUs.*up to (\d+) ms late/.exec(l.text);
        if (m) {
          load.push(Number(m[1]));
          if (i === 0) firstCaseLoad.push(Number(m[1]));
          if (Number(m[2]) > STALL_MS) stalls.push({ test: r.test, lateMs: Number(m[2]), at: l.at, around: around(lines, l.at, Number(m[2])), firstCase: i === 0 });
        }
        const b = /^busiest: (.*)$/.exec(l.text);
        if (b) {
          samples++;
          for (const [, name, percent] of b[1]!.matchAll(/([^,]+?) (\d+) %/g)) {
            // a job's name ends in the number launchd gave it
            const n = name!.trim().replace(/\d+$/, "");
            busy[n] = (busy[n] ?? 0) + Number(percent);
          }
        }
      } else if (l.who === "simctl") {
        const m = /^simctl (\S+)(?: .*)?: (?:(\d+) ms|failed after (\d+) ms)/.exec(l.text);
        if (m) {
          (calls[m[1]!] ??= []).push(Number(m[2] ?? m[3]));
          if (m[3]) failed[m[1]!] = (failed[m[1]!] ?? 0) + 1;
        }
      }
    }
    if (stalls.length > before) stalledCases++;
    if (r.verdict !== "passed") {
      const here = lines.flatMap((l) => l.who === "runner" ? /^load ([\d.]+) of/.exec(l.text)?.[1] ?? [] : []).map(Number);
      failures.push({ test: r.test, position: i, load: spread(here)?.median ?? null, error: (r.error ?? r.verdict).split("\n")[0]!.slice(0, 120) });
    }
  });
  return {
    // Android's artifact holds its cases a folder down, in build/scenarios
    job: basename(dir) === "scenarios" ? basename(dirname(resolve(dir))) : basename(dir),
    environment: existsSync(envFile) ? JSON.parse(readFileSync(envFile, "utf8")) : {},
    cases: all.length,
    failed: all.filter((r) => r.verdict !== "passed").length,
    failures,
    load: spread(load),
    firstCaseLoad: spread(firstCaseLoad),
    stalledCases,
    stalls: stalls.sort((a, b) => b.lateMs - a.lateMs),
    simctl: Object.fromEntries(Object.entries(calls).map(([k, v]) => [k, { ...spread(v)!, failed: failed[k] ?? 0 }])),
    busiest: Object.entries(busy).map(([name, sum]) => ({ name, percent: Math.round(sum / samples) })).sort((a, b) => b.percent - a.percent).slice(0, 6),
    ms,
  };
}

/** Each folder under dirs that holds a job's environment.json, or dirs themselves when none does. */
export function jobDirs(dirs: string[]): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    if (existsSync(join(d, "environment.json"))) return void found.push(d);
    for (const n of readdirSync(d)) if (statSync(join(d, n)).isDirectory()) walk(join(d, n));
  };
  for (const d of dirs) if (existsSync(d)) walk(d);
  return found;
}

/** The mean of a / b over pairs, on the log scale, with its 95 % interval by bootstrap: the same seed, the same answer. */
export function ratio(pairs: [number, number][]): { n: number; ratio: number; low: number; high: number } | null {
  if (pairs.length < 2) return null;
  const logs = pairs.map(([a, b]) => Math.log(a / b));
  const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
  let seed = 1;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const means = Array.from({ length: 2000 }, () => mean(logs.map(() => logs[Math.floor(random() * logs.length)]!))).sort((a, b) => a - b);
  return { n: pairs.length, ratio: Math.exp(mean(logs)), low: Math.exp(means[50]!), high: Math.exp(means[1949]!) };
}

/** What differs between two environments, but for what differs each run: its address, its commit, its runner's number. */
export function environmentChanges(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const seen = (v: unknown) => JSON.stringify(v)?.replace(/GitHub Actions \d+, /, "");
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => k !== "run" && k !== "commit")
    .filter((k) => seen(before[k]) !== seen(after[k]))
    .map((k) => `${k}: ${seen(before[k])} → ${seen(after[k])}`);
}

const seconds = (ms: number) => (ms / 1000).toFixed(1);
const loads = (s: Spread | null) => s ? `${Math.round(s.median)} / ${Math.round(s.p95)} / ${Math.round(s.max)}` : "—";

export function report(jobs: JobFacts[], against: JobFacts[] = []): string {
  if (!jobs.length) return "";
  const out = ["## The runner under the cases", "",
    "| job | cases | failed | load median / p95 / max | first case's load median | cases with a stall over 5 s | CPUs, memory |", "|---|---|---|---|---|---|---|"];
  for (const j of jobs) out.push(`| ${j.job} | ${j.cases} | ${j.failed} | ${loads(j.load)} | ${j.firstCaseLoad ? Math.round(j.firstCaseLoad.median) : "—"} | ${j.stalledCases} | ${j.environment.cpus ?? "?"}, ${j.environment.memory ?? "?"} |`);
  const failures = jobs.flatMap((j) => j.failures.map((f) => ({ job: j.job, ...f })));
  if (failures.length) {
    out.push("", "### Failed cases", "", "| job | case's place in the job, from 0 | load median | error | case |", "|---|---|---|---|---|");
    for (const f of failures) out.push(`| ${f.job} | ${f.position} | ${f.load === null ? "—" : Math.round(f.load)} | ${f.error.replaceAll("|", "\\|")} | ${f.test.slice(0, 80)} |`);
  }
  const stalls = jobs.flatMap((j) => j.stalls.map((s) => ({ job: j.job, ...s })));
  if (stalls.length) {
    out.push("", "### Longest stalls", "", "| job | s late | s into the case | job's first case | what began meanwhile | case |", "|---|---|---|---|---|---|");
    for (const s of stalls.sort((a, b) => b.lateMs - a.lateMs).slice(0, 10)) out.push(`| ${s.job} | ${seconds(s.lateMs)} | ${seconds(s.at)} | ${s.firstCase ? "yes" : "no"} | ${s.around.join("; ").replaceAll("|", "\\|") || "nothing noted"} | ${s.test.slice(0, 80)} |`);
  }
  const calls = jobs.flatMap((j) => Object.entries(j.simctl).map(([verb, c]) => ({ job: j.job, verb, ...c })));
  if (calls.length) {
    out.push("", "### simctl", "", "| job | call | n | median ms | p95 ms | max ms | failed |", "|---|---|---|---|---|---|---|");
    for (const c of calls) out.push(`| ${c.job} | ${c.verb} | ${c.n} | ${c.median} | ${c.p95} | ${c.max} | ${c.failed} |`);
  }
  const busy = jobs.filter((j) => j.busiest.length);
  if (busy.length) {
    out.push("", "### Busiest, mean % of a CPU over the samples", "");
    for (const j of busy) out.push(`- ${j.job}: ${j.busiest.map((b) => `${b.name} ${b.percent}`).join(", ")}`);
  }
  out.push("", "### Environment", "");
  for (const j of jobs) out.push(`- ${j.job}: ${[j.environment.runner, j.environment.os, j.environment.xcode, j.environment.iosRuntime, j.environment.disk].filter(Boolean).join(", ")}`);
  if (against.length) {
    out.push("", "### Against the other run", "", "| job | environment that changed | cases on both | this run's time / the other's (95 % CI over cases) |", "|---|---|---|---|");
    const pairs: [number, number][] = [];
    for (const j of jobs) {
      const o = against.find((a) => a.job === j.job);
      if (!o) {
        out.push(`| ${j.job} | not in the other run | | |`);
        continue;
      }
      const these = Object.keys(j.ms).filter((t) => o.ms[t]).map((t): [number, number] => [j.ms[t]!, o.ms[t]!]);
      pairs.push(...these);
      const r = ratio(these);
      out.push(`| ${j.job} | ${environmentChanges(o.environment, j.environment).join("; ").replaceAll("|", "\\|") || "none"} | ${these.length} | ${r ? `${r.ratio.toFixed(2)} (${r.low.toFixed(2)}–${r.high.toFixed(2)})` : "—"} |`);
    }
    const r = ratio(pairs);
    if (r) out.push(`| all | | ${r.n} | ${r.ratio.toFixed(2)} (${r.low.toFixed(2)}–${r.high.toFixed(2)}) |`);
    out.push("", "Read a job's ratio against the spread of the jobs': each is one runner against another, and its interval is over the cases, not over runners.");
  }
  return out.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const json = args.indexOf("--json");
  const file = json >= 0 ? args.splice(json, 2)[1] : undefined;
  const split = args.indexOf("--against");
  const jobs = jobDirs(split >= 0 ? args.slice(0, split) : args).map(jobFacts);
  const against = split >= 0 ? jobDirs(args.slice(split + 1)).map(jobFacts) : [];
  if (file) writeFileSync(file, `${JSON.stringify(jobs, null, 2)}\n`);
  console.log(report(jobs, against));
}
