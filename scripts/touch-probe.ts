#!/usr/bin/env node
// Where a tap's time goes on the booted iPhone, for when the nightly's taps reach its page too long or too far apart:
//
//   node scripts/touch-probe.ts taps [--taps N] [--stress 0,60,150]   taps through idb and through scripts/sim-finger.m
//   node scripts/touch-probe.ts log LABEL                              what of the iPhone's log composes, and why not
//   node scripts/touch-probe.ts boot [--minutes 5]                     what runs here, and the log composing after the boot
//
// Each driver taps a page in Safari, sent as 50 ms, N times under each load: the runner's own, then with that many busy
// processes added. Per tap it keeps when the driver sent it, each event's own time (the HID stamp WebKit reads) and when
// the page heard it, and whether the board would take it as a tap (web/gestures.ts). idb's companion waits out the 50
// ms and hands each event to dtuhidd, which stamps it as it comes; sim-finger stamps each event with the time it was
// meant for. Into build/touch-probe: taps.jsonl, summary.md, and the iPhone's and the host's logs of the run.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, cpSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync, writeSync } from "node:fs";
import { createServer } from "node:http";
import { loadavg } from "node:os";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { bootedIphone, SimFinger, SimHid, simctl } from "../scenarios/ios.ts";
import { Gestures, type GestureHandler } from "../web/gestures.ts";

const out = "build/touch-probe";
mkdirSync(out, { recursive: true });
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : fallback;
};
const udid = bootedIphone();
if (!udid) throw new Error("no iPhone booted: node scripts/ios.ts");

type Ev = { type: string; ev: number; heard: number };
type Tap = { driver: string; stress: number; load: number; sent: number; answered: number; stamped?: number[]; dispatched?: number[]; companion?: number[]; down?: Ev; up?: Ev; took: string };

/** The page: each pointer event's own time and when it was heard, on the wall clock as the host's. */
const PAGE = `<!DOCTYPE html><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<style>html,body{margin:0;height:100%;touch-action:none;background:#eef;font:16px system-ui}</style><p id="n">probe</p>
<script>
const q = [], o = performance.timeOrigin;
for (const type of ["pointerdown", "pointerup", "pointercancel"]) addEventListener(type, (e) => {
  q.push({ type, ev: o + e.timeStamp, heard: o + performance.now() });
  n.textContent = type;
}, { capture: true });
const post = (b) => fetch("/events", { method: "POST", body: JSON.stringify(b) });
post([{ type: "ready", screen: [screen.width, screen.height] }]);
setInterval(() => q.length && post(q.splice(0)), 20);
</script>`;

async function taps(n: number, stresses: number[]) {
  const started = new Date();
  const events: Ev[] = [];
  let screen: [number, number] | null = null;
  const server = createServer((req, res) => {
    if (req.method !== "POST") return void res.setHeader("content-type", "text/html").end(PAGE);
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      for (const e of JSON.parse(body) as (Ev & { screen?: [number, number] })[]) {
        if (e.type === "ready") screen = e.screen!;
        else events.push(e);
      }
      res.end();
    });
  }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  // again, as the simulator busy after its boot gives up on a URL now and then
  for (let tries = 1; !screen; tries++) {
    if (tries > 4) throw new Error("Safari never showed the probe page");
    simctl(["openurl", udid!, `http://localhost:${port}/`], { timeout: 60_000 });
    for (const end = Date.now() + 20_000; !screen && Date.now() < end; await sleep(200));
  }
  const [w, h] = screen as [number, number];
  const at = { x: w / 2, y: h / 2 };

  const notes: string[] = [];
  const all: Tap[] = [];
  const hid = await SimHid.start(udid!);
  const finger = await SimFinger.start(udid!, w, h);
  try {
    // which touchscreens there are before idb's first touch and after, which HID transport its companion chose, and
    // which touchscreen Safari hears from sim-finger: locally dtuhidd's come with idb's first touch and replace the
    // simulator's own main screen's, and only that display's of them is heard; on CI none came, and none was heard
    type Sender = { id: string; display: string; transport: string };
    const list = () => finger.touchscreens();
    const show = (ss: Sender[]) => ss.map((x) => `${x.transport || "simulator's"} ${x.id} of ${x.display.slice(0, 8)}`).join(", ") || "none";
    const calibrated = new Date();
    notes.push(`Touchscreens before idb's first tap: ${show(await list())}.`);
    let seen = events.length;
    const first = Date.now();
    await hid.touches([[0, "down", at.x, at.y], [50, "up", at.x, at.y]]);
    for (const after of [500, 2000, 5000, 10_000]) {
      await sleep(Math.max(0, first + after - Date.now()));
      notes.push(`${after / 1000} s after it: ${show(await list())}.`);
    }
    notes.push(events.length > seen ? `The page heard idb's first tap, ${Math.round(events[seen]!.heard - first)} ms after it was sent.` : "The page did not hear idb's first tap in 10 s.");
    const transport = existsSync(`/tmp/idb/logs/${udid}`) ? readFileSync(`/tmp/idb/logs/${udid}`, "utf8").split("\n").filter((l) => /Negotiated/.test(l)).at(-1) : undefined;
    notes.push(`idb's companion: ${transport ?? "no Negotiated line in its log"}.`);
    let heard = "";
    for (const x of await list()) {
      await finger.use(x.id);
      seen = events.length;
      const t0 = Date.now();
      await finger.touches([[0, "down", at.x, at.y], [50, "up", at.x, at.y]]);
      for (const end = Date.now() + 10_000; events.length === seen && Date.now() < end; await sleep(20));
      const got = events.length > seen;
      notes.push(`sim-finger as ${show([x])}: ${got ? `heard ${Math.round(events[seen]!.heard - t0)} ms after it was sent` : "not heard in 10 s"}.`);
      if (got && !heard) heard = show([x]);
    }
    if (heard) await finger.use((await list()).find((x) => show([x]) === heard)!.id);
    // what backboardd made of those touches
    saveLog(`calibration backboardd.txt`, ["xcrun", "simctl", "spawn", udid!, "log", "show", "--start", local(calibrated), "--info", "--debug", "--style", "compact", "--predicate", 'process == "backboardd" OR process == "dtuhidd"']);
    await sleep(500);
    const drivers = heard ? ["idb", "sim-finger"] : ["idb"];

    const log = `${out}/taps.jsonl`;
    writeFileSync(log, "");
    for (const stress of stresses) {
      const busy: ChildProcess[] = Array.from({ length: stress }, () => spawn("yes", { stdio: "ignore" }));
      try {
        await sleep(stress ? 5000 : 0);
        for (let i = 0; i < drivers.length * n; i++) {
          const driver = drivers[i % drivers.length]!;
          const seen = events.length, sent = Date.now();
          const tap: Tap = { driver, stress, load: Math.round(loadavg()[0]! * 10) / 10, sent, answered: 0, took: "" };
          if (driver === "idb") await hid.touches([[0, "down", at.x, at.y], [50, "up", at.x, at.y]]);
          else {
            const r = await finger.touches([[0, "down", at.x, at.y], [50, "up", at.x, at.y]]) as { stamped: number[]; sent: number[] };
            Object.assign(tap, { stamped: r.stamped, dispatched: r.sent });
          }
          tap.answered = Date.now();
          // until its lift is heard, or not at all
          for (const end = Date.now() + 3000; !events.slice(seen).some((e) => e.type !== "pointerdown") && Date.now() < end; await sleep(10));
          await sleep(30);
          const mine = events.slice(seen);
          tap.down = mine.find((e) => e.type === "pointerdown");
          tap.up = mine.find((e) => e.type !== "pointerdown");
          tap.took = took(tap);
          all.push(tap);
          appendFileSync(log, `${JSON.stringify(tap)}\n`);
          // apart, as two taps and not a double tap
          await sleep(400);
        }
      } finally {
        for (const b of busy) b.kill();
      }
    }
  } finally {
    hid.stop();
    finger.stop();
    server.close();
    companion(all);
    const summary = `${all.length ? summarise(all) + split(all) : ""}${notes.join("\n\n")}\n\n`;
    writeFileSync(`${out}/summary.md`, summary);
    process.stdout.write(summary);
    logs(started);
  }
}

/** When idb's companion sent each of an idb tap's events, by its own log, which times each to the ms. */
function companion(all: Tap[]) {
  const file = `/tmp/idb/logs/${udid}`;
  if (!existsSync(file)) return;
  const sends = readFileSync(file, "utf8").split("\n").flatMap((l) => {
    const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d+)([+-]\d\d)(\d\d) .*Sending Touch/.exec(l);
    return m ? [Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`)] : [];
  });
  for (const t of all.filter((t) => t.driver === "idb")) t.companion = sends.filter((at) => at >= t.sent - 5 && at <= t.answered + 5);
}

/** Where an idb tap's stretch went: the companion's 50 ms wait overrunning, or dtuhidd stamping the lift later after its
 * send than the down. */
function split(all: Tap[]): string {
  const ts = all.filter((t) => t.driver === "idb" && t.down && t.up && t.companion?.length === 2);
  if (!ts.length) return "No idb tap's sends were found in its companion's log.\n\n";
  const rows = ts.map((t) => {
    const [cDown, cUp] = t.companion as [number, number];
    return { t, stretch: t.up!.ev - t.down!.ev - 50, wait: cUp - cDown - 50, stamp: (t.up!.ev - cUp) - (t.down!.ev - cDown), toCompanion: cDown - t.sent };
  });
  const three = (xs: number[]) => `${r(q(xs, 0.5))} / ${r(q(xs, 0.99))} / ${r(Math.max(...xs))}`;
  const worst = [...rows].sort((a, b) => b.stretch - a.stretch).slice(0, 10)
    .map((x) => `| ${r(x.stretch)} | ${r(x.wait)} | ${r(x.stamp)} | ${r(x.toCompanion)} | ${x.t.stress} | ${x.t.load} | ${x.t.took} |`);
  return [`## Where idb's taps stretched (${ts.length} found in the companion's log)`, "",
    "| | p50 / p99 / max |", "|---|---|",
    `| stretch: down→up by events, less 50 | ${three(rows.map((x) => x.stretch))} |`,
    `| the companion's 50 ms wait, less 50 | ${three(rows.map((x) => x.wait))} |`,
    `| dtuhidd's stamp of the lift after its send, less the down's | ${three(rows.map((x) => x.stamp))} |`,
    `| the driver's send to the companion's of the down | ${three(rows.map((x) => x.toCompanion))} |`, "",
    "The ten most stretched:", "", "| Stretch | Wait over | Stamp later | To companion | Busy added | Load | Took |", "|---|---|---|---|---|---|---|", ...worst, "", ""].join("\n");
}

/** What the board takes it as, by its events' own times. */
function took(t: Tap): string {
  if (!t.down || !t.up) return t.down ? "no lift" : "nothing";
  if (t.up.type === "pointercancel") return "cancelled";
  let got = "";
  const g = new Gestures(new Proxy({} as GestureHandler, { get: (_, k) => () => void (got ||= String(k)) }));
  g.down(1, 0, 0, t.down.ev);
  g.up(1, 0, 0, t.up.ev);
  return got;
}

const q = (xs: number[], p: number) => xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]! : NaN;
const r = (x: number) => Number.isNaN(x) ? "–" : String(Math.round(x));

/** The 95 % Clopper-Pearson interval of k in n, in %. */
function ci(k: number, n: number): string {
  const cdf = (p: number, upTo: number) => {
    let s = 0, term = (1 - p) ** n;
    for (let i = 0; i <= upTo; i++) {
      s += term;
      term *= ((n - i) / (i + 1)) * (p / (1 - p));
    }
    return s;
  };
  const solve = (f: (p: number) => boolean) => {
    let lo = 0, hi = 1;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (f(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  const lower = k === 0 ? 0 : solve((p) => 1 - cdf(p, k - 1) < 0.025);
  const upper = k === n ? 1 : solve((p) => cdf(p, k) > 0.025);
  return `${(lower * 100).toFixed(2)}–${(upper * 100).toFixed(2)} %`;
}

function summarise(all: Tap[]): string {
  const rows = ["| Driver | Busy added | Load | Taps | Not a tap (95 % CI) | down→up by events p50 / p99 / max | sent→down stamped p50 / p99 / max | up stamped→heard p50 / p99 / max |", "|---|---|---|---|---|---|---|---|"];
  const groups = Map.groupBy(all, (t) => `${t.driver} ${t.stress}`);
  for (const ts of groups.values()) {
    const ok = ts.filter((t) => t.down && t.up);
    const gap = ok.map((t) => t.up!.ev - t.down!.ev), toDown = ok.map((t) => t.down!.ev - t.sent), heard = ok.map((t) => t.up!.heard - t.up!.ev);
    const bad = ts.filter((t) => t.took !== "tap").length;
    const three = (xs: number[]) => `${r(q(xs, 0.5))} / ${r(q(xs, 0.99))} / ${r(Math.max(...xs))}`;
    rows.push(`| ${ts[0]!.driver} | ${ts[0]!.stress} | ${r(q(ts.map((t) => t.load), 0.5))} | ${ts.length} | ${bad}, ${ci(bad, ts.length)} | ${three(gap)} | ${three(toDown)} | ${three(heard)} |`);
  }
  const odd = all.filter((t) => t.took !== "tap");
  const kinds = Object.entries(Object.groupBy(odd, (t) => `${t.driver}: ${t.took}`)).map(([k, v]) => `${k} ${v!.length}`).join(", ");
  return `## Taps sent as 50 ms\n\n${rows.join("\n")}\n\nNot taps: ${kinds || "none"}. In ms; "sent→down stamped" is from the driver's send to the down's own time, which for idb is when dtuhidd stamped it.\n\n`;
}

/** What runs here, and the iPhone's text of its shared cache as it comes after the boot, with how much of its log fails to
 * compose meanwhile: a Mac's iPhone writes it into its data folder within seconds of its boot, and its log composes. Every
 * 20 s for at most --minutes, 5 by default, until two samples in a row compose. */
async function bootFacts() {
  const run = (f: string, args: string[]) => {
    try {
      return execFileSync(f, args, { encoding: "utf8", timeout: 60_000 }).trim().replace(/\s*\n\s*/g, " ");
    } catch (e) {
      return (e as Error).message.split("\n")[0]!;
    }
  };
  const lines = ["## What runs here", "",
    `- macOS ${run("sw_vers", ["-productVersion"])} (${run("sw_vers", ["-buildVersion"])}), ${run("xcodebuild", ["-version"])}`,
    `- CoreSimulator ${run("defaults", ["read", "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/Info.plist", "CFBundleVersion"])}`,
    `- ${run("brew", ["list", "--versions", "idb-companion"])}`,
    `- runtimes: ${run("xcrun", ["simctl", "list", "runtimes"])}`, "",
    "## The iPhone's text of its shared cache, after its boot", "",
    "| At | Load | data/var/db/uuidtext/dsc | Log lines of the last 20 s | Did not compose |", "|---|---|---|---|---|"];
  const dir = `${process.env.HOME}/Library/Developer/CoreSimulator/Devices/${udid}/data/var/db/uuidtext/dsc`;
  let good = 0;
  for (const end = Date.now() + Number(arg("minutes", "5")) * 60_000; good < 2 && Date.now() < end; await sleep(20_000)) {
    const files = existsSync(dir) ? readdirSync(dir).map((f) => {
      const st = statSync(`${dir}/${f}`);
      return `${f.slice(0, 8)} ${st.size} B, born ${st.birthtime.toISOString().slice(11, 19)}, written ${st.mtime.toISOString().slice(11, 19)}`;
    }).join("; ") || "empty" : "no such folder";
    const { entries, failed } = await composes("20s");
    good = entries && failed / entries < 0.01 ? good + 1 : 0;
    lines.push(`| ${new Date().toISOString().slice(11, 19)} | ${loadavg()[0]!.toFixed(0)} | ${files} | ${entries} | ${failed} |`);
  }
  // what writes that text: the iPhone's own logd_helper, which launchd_sim starts, a Mac's within seconds of the boot
  const data = `${process.env.HOME}/Library/Developer/CoreSimulator/Devices/${udid}/data`;
  const uuidtext = `${data}/var/db/uuidtext`;
  const texts = existsSync(uuidtext) ? readdirSync(uuidtext, { recursive: true }).map(String) : [];
  const crashes = [`${process.env.HOME}/Library/Logs/DiagnosticReports`, `${data}/Library/Logs/CrashReporter`]
    .flatMap((d) => existsSync(d) ? readdirSync(d, { recursive: true }).map(String).filter((f) => /logd/i.test(f)).map((f) => `${d}/${f}`) : []);
  lines.push("", "## What writes it", "",
    `- logd_helper processes: ${run("sh", ["-c", "pgrep -lf logd_helper | cut -c1-160 || true"]) || "none"}`,
    `- the iPhone's launchd on logd: ${run("sh", ["-c", `xcrun simctl spawn ${udid} launchctl list | grep -i logd || true`]) || "nothing"}`,
    `- data/var/db: ${run("ls", ["-la", `${data}/var/db`])}`,
    `- data/var/db/uuidtext: ${existsSync(uuidtext) ? `${texts.length} entries, ${texts.filter((f) => /\//.test(f)).length} files in its folders` : "no such folder"}`,
    `- crash reports of logd: ${crashes.join(", ") || "none"}`);
  const text = `${lines.join("\n")}\n\n`;
  writeFileSync(`${out}/boot facts.md`, text);
  process.stdout.write(text);
}

/** How many of the iPhone's log lines of the last `last` there are, and how many of them did not compose. */
async function composes(last: string) {
  const child = spawn("xcrun", ["simctl", "spawn", udid!, "log", "show", "--last", last, "--info", "--style", "ndjson"], { stdio: ["ignore", "pipe", "ignore"] });
  const timer = setTimeout(() => child.kill(), 120_000);
  let entries = 0, failed = 0;
  for await (const line of createInterface({ input: child.stdout! })) {
    if (!line.startsWith("{")) continue;
    entries++;
    if (line.includes("compose failure")) failed++;
  }
  clearTimeout(timer);
  return { entries, failed };
}

/** `since` in local time, as log reads it. */
const local = (since: Date) => new Date(since.getTime() - since.getTimezoneOffset() * 60_000).toISOString().replace("T", " ").slice(0, 19);

/** What a command prints into `file` in the probe's output, or why it failed. */
function saveLog(file: string, args: string[]) {
  const fd = openSync(`${out}/${file}`, "w");
  try {
    execFileSync(args[0]!, args.slice(1), { stdio: ["ignore", fd, "inherit"], timeout: 300_000 });
  } catch (e) {
    appendFileSync(`${out}/${file}`, `\nfailed: ${(e as Error).message}\n`);
  } finally {
    closeSync(fd);
  }
}

/** The iPhone's and the host's logs since `since`, of what carries a touch: idb's companion, CoreSimulator, dtuhidd,
 * backboardd, SpringBoard, Safari and WebKit. */
function logs(since: Date) {
  const start = local(since);
  const save = saveLog;
  save("iPhone log.txt", ["xcrun", "simctl", "spawn", udid!, "log", "show", "--start", start, "--info", "--debug", "--style", "compact", "--predicate",
    'process IN {"dtuhidd", "backboardd", "SpringBoard", "MobileSafari", "com.apple.WebKit.WebContent", "com.apple.WebKit.GPU"}']);
  save("host log.txt", ["log", "show", "--start", start, "--info", "--debug", "--style", "compact", "--predicate",
    'process BEGINSWITH "idb_companion" OR process == "CoreSimulatorService" OR process == "launchd_sim" OR process == "SimulatorTrampoline"']);
  // the companion's own, where idb keeps it
  if (existsSync("/tmp/idb")) cpSync("/tmp/idb", `${out}/idb`, { recursive: true, filter: (f) => !/\.sock$/.test(f) });
}

/** Which shared cache the iPhone's SpringBoard maps, each cache's UUID, which its log lines name, and how CoreSimulator's
 * own builds of them went: a Mac's iPhone maps its runtime's own, and CI's runner has built its own besides. */
function caches(runtimeDirs: string[]): string[] {
  const built = "/Library/Developer/CoreSimulator/Caches/dyld";
  const files = [...runtimeDirs.map((d) => `${d}/dyld_sim_shared_cache_arm64`),
    ...(existsSync(built) ? readdirSync(built, { recursive: true }).map(String).filter((f) => f.endsWith("dyld_sim_shared_cache_arm64")).map((f) => `${built}/${f}`) : [])];
  const uuid = (f: string) => {
    try {
      // dyld_cache_header's uuid
      const fd = openSync(f, "r"), head = Buffer.alloc(0x68);
      readSync(fd, head, 0, 0x68, 0);
      closeSync(fd);
      const b = head.subarray(0x58, 0x68).toString("hex").toUpperCase();
      return `${b.slice(0, 8)}-${b.slice(8, 12)}-${b.slice(12, 16)}-${b.slice(16, 20)}-${b.slice(20)}`;
    } catch (e) {
      return (e as Error).message;
    }
  };
  let mapped = "";
  try {
    const pid = execFileSync("pgrep", ["-f", "RuntimeRoot/System/Library/CoreServices/SpringBoard.app/SpringBoard"], { encoding: "utf8" }).trim().split("\n")[0]!;
    mapped = execFileSync("lsof", ["-p", pid], { encoding: "utf8", maxBuffer: 64 * 2 ** 20 }).split("\n").filter((l) => /dyld/.test(l))
      .map((l) => l.replace(/^.*?(\/\S.*)$/, "$1")).join("; ");
  } catch (e) {
    mapped = (e as Error).message.split("\n")[0]!;
  }
  const outputs = existsSync(built) ? readdirSync(built, { recursive: true }).map(String).filter((f) => /update_dyld_sim_shared_cache-std(err|out)\.txt$/.test(f) && f.includes("iOS-27")) : [];
  return [`- SpringBoard maps: ${mapped || "no dyld file"}`, ...files.map((f) => `- ${f}: UUID ${uuid(f)}`),
    ...outputs.map((f) => `- ${f}, its last lines: \`${readFileSync(`${built}/${f}`, "utf8").trim().split("\n").slice(-8).join(" ⏎ ").slice(0, 1500)}\``)];
}

/** How much of the last minutes of the iPhone's log composes, which code wrote what did not, and where the simulator's
 * shared caches are: CI's logs came 85–96 % `<compose failure [shared UUID]>`, a Mac's none. */
async function logCheck(label: string) {
  // as a line each, read a line at a time: a booted iPhone's 3 minutes on CI came over 512 MB
  const file = `${out}/log ${label}.ndjson`, fd = openSync(file, "w");
  execFileSync("xcrun", ["simctl", "spawn", udid!, "log", "show", "--last", "3m", "--info", "--style", "ndjson"], { stdio: ["ignore", fd, "inherit"], timeout: 600_000 });
  closeSync(fd);
  type Entry = { eventMessage?: string; processImagePath?: string; senderImagePath?: string; senderImageUUID?: string };
  const failures = openSync(`${out}/log ${label} failures.ndjson`, "w");
  const by = { processImagePath: new Map<string, number>(), senderImagePath: new Map<string, number>() };
  let entries = 0, failed = 0, first: Entry | null = null;
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    if (!line.startsWith("{")) continue;
    entries++;
    const e = JSON.parse(line) as Entry;
    if (!e.eventMessage?.includes("compose failure")) continue;
    failed++;
    first ??= e;
    writeSync(failures, `${line}\n`);
    for (const k of ["processImagePath", "senderImagePath"] as const) by[k].set(String(e[k] ?? "?"), (by[k].get(String(e[k] ?? "?")) ?? 0) + 1);
  }
  closeSync(failures);
  const top = (k: keyof typeof by) => [...by[k]].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([v, c]) => `  - ${c} ${v}`).join("\n");
  const ls = (dir: string) => {
    try {
      return readdirSync(dir, { recursive: true }).slice(0, 40).join(", ") || "empty";
    } catch (e) {
      return (e as Error).message;
    }
  };
  const runtime = (JSON.parse(simctl(["list", "runtimes", "--json"], { timeout: 60_000 })) as { runtimes: { identifier: string; runtimeRoot: string }[] })
    .runtimes.filter((r) => r.identifier.includes("iOS"));
  const home = process.env.HOME!;
  const text = [`## The iPhone's log, ${label}`, "",
    `${failed} of ${entries} entries in its last 3 minutes did not compose.`, "",
    "- By the process that logged:", top("processImagePath"), "- By the code that logged:", top("senderImagePath"),
    `- One raw: \`${JSON.stringify(first).slice(0, 600)}\``, "",
    ...runtime.flatMap((r) => [`- ${r.identifier}'s own dyld caches: ${ls(`${r.runtimeRoot}/System/Library/Caches/com.apple.dyld`)}`,
      `- ${r.identifier}'s own uuidtext/dsc: ${ls(`${r.runtimeRoot}/private/var/db/uuidtext/dsc`)}`]),
    `- CoreSimulator's dyld caches: ${ls("/Library/Developer/CoreSimulator/Caches/dyld")}`,
    `- The user's: ${ls(`${home}/Library/Developer/CoreSimulator/Caches/dyld`)}`,
    `- The iPhone's uuidtext/dsc: ${ls(`${home}/Library/Developer/CoreSimulator/Devices/${udid}/data/var/db/uuidtext/dsc`)}`,
    `- The host's uuidtext/dsc: ${ls("/private/var/db/uuidtext/dsc")}`,
    ...caches(runtime.map((r) => `${r.runtimeRoot}/System/Library/Caches/com.apple.dyld`)), "", ""].join("\n");
  writeFileSync(`${out}/log ${label}.md`, text);
  process.stdout.write(text);
}

if (process.argv[2] === "log") await logCheck(process.argv[3] ?? "now");
else if (process.argv[2] === "boot") await bootFacts();
else if (process.argv[2] === "taps") await taps(Number(arg("taps", "300")), arg("stress", "0,60,150").split(",").map(Number));
else throw new Error("usage: node scripts/touch-probe.ts taps [--taps N] [--stress 0,60,150] | log LABEL | boot");
