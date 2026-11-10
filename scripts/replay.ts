// Replays a stroke the reference app recorded (Reference/) into it again, to check the replay is faithful, or into
// Firefox on the dev server: docs/superpowers/specs/2026-11-10-breezy-native-reference-design.md. The events are
// posted by scripts/replay-helper.swift, started once from Terminal.app, which holds Accessibility.
//
//   node scripts/replay.ts build/reference/push-hold-1.json --into reference|firefox
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MARGIN } from "../web/camera.ts";
import type { Recording } from "../web/flight.ts";
import type { Stream } from "../web/wheel.ts";

export const HELPER = "http://127.0.0.1:58569";
const DEV = "http://127.0.0.1:58565";
const root = fileURLToPath(new URL("../", import.meta.url));
export const REFERENCE_APP = `${root}build/reference-dd/Build/Products/Debug/BreezyReference.app/Contents/MacOS/BreezyReference`;

/** A stroke as the reference app writes it: events `[t, dx, dy, phase, momentumPhase]`, frames `[t, clipX, clipY]`. */
export interface Stroke { name: string; stage: [number, number]; start: [number, number]; events: number[][]; frames: number[][] }

const SCROLL: Record<number, number> = { 0: 0, 1: 1, 4: 2, 8: 4, 16: 8, 32: 128 };
const MOMENTUM: Record<number, number> = { 0: 0, 1: 1, 4: 2, 8: 3 };

/** NSEvent's phase and momentum phase, as CGEvent numbers them; scripts/replay-helper.swift holds the same table. */
export function toCGPhases(phase: number, momentum: number) {
  const scroll = SCROLL[phase], m = MOMENTUM[momentum];
  if (scroll === undefined) throw new Error(`no CGScrollPhase for NSEvent phase ${phase}`);
  if (m === undefined) throw new Error(`no CGMomentumScrollPhase for NSEvent momentum ${momentum}`);
  return { scroll, momentum: m };
}

async function helper(path: string, body?: unknown, ms = 2000) {
  const r = await fetch(`${HELPER}${path}`, { method: body ? "POST" : "GET", body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(ms) })
    .catch((e: Error) => { throw path === "/ping" ? new Error("start the helper from Terminal.app: swift scripts/replay-helper.swift") : e; });
  if (!r.ok) throw new Error(`helper ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

/** Posts `s`'s events into the app `bundle`, at their recorded times; resolves once the last is posted. */
export async function post(s: Stroke, bundle: string): Promise<{ posted: number }> {
  await helper("/ping");
  const events = s.events.map(([t, dx, dy, p, m]) => { const c = toCGPhases(p, m); return [t, dx, dy, c.scroll, c.momentum]; });
  return helper("/replay", { app: bundle, events }, Math.ceil((s.events.at(-1)?.[0] ?? 0) + 10_000));
}

/** Launches the reference at `s`'s start, replays `s` into it and gives the path of the stroke it recorded. */
export async function intoReference(s: Stroke): Promise<string> {
  await helper("/ping");
  const app = spawn(REFERENCE_APP, ["--stage", s.stage.join("x"), "--start", s.start.join(","), "--name", `${s.name}-replay`], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const lines: string[] = [], waiting: ((l: string) => void)[] = [];
    app.stdout.on("data", (d: Buffer) => { for (const l of d.toString().split("\n").filter(Boolean)) waiting.length ? waiting.shift()!(l) : lines.push(l); });
    const exited = new Promise<never>((_, no) => app.on("exit", (code) => no(new Error(`the reference app exited (${code}) before recording`))));
    const line = (ms: number, what: string) => Promise.race([
      new Promise<string>((ok) => (lines.length ? ok(lines.shift()!) : waiting.push(ok))), exited,
      new Promise<never>((_, no) => setTimeout(() => no(new Error(`the reference app ${what} in ${ms / 1000} s`)), ms).unref()),
    ]);
    // a first launch takes seconds to show its window
    if ((await line(15_000, "showed no window")) !== "ready") throw new Error("the reference app said something before it was ready");
    await post(s, "local.breezy.reference");
    return await line(20_000, "recorded nothing");
  } finally {
    app.kill();
  }
}

/** What Firefox made of a replay: its wheel events from the first, in the browser's deltas, as replay() takes them. */
export interface Capture { stage: number[]; from: number[]; events: [t: number, dx: number, dy: number][] }

/** The capture in a fresh page's recording, its streams joined; refused when it is more than 2 short of the posted events. */
export function captureOf(r: Recording, posted: Stroke): Capture {
  const streams = r.entries.filter((e) => e[1] === "input" && e[2] === "wheel").map((e) => e[3] as unknown as Stream);
  if (!streams.length) throw new Error("no wheel stream in the page's recording");
  const [w, h] = streams[0].stage;
  if (Math.abs(w - posted.stage[0]) > 1 || Math.abs(h - posted.stage[1]) > 1) throw new Error(`Firefox's board is ${w} × ${h}, the reference's ${posted.stage[0]} × ${posted.stage[1]}: resize Firefox's window, or record at its size`);
  const t0 = streams[0].at;
  // a stream keeps the pan it gave, against the delta
  const events = streams.flatMap((s) => s.events.map(([t, dx, dy]) => [Math.round((s.at + t - t0) * 10) / 10, -dx + 0, -dy + 0] as [number, number, number]));
  const sent = posted.events.filter(([, dx, dy]) => dx || dy).length;
  if (events.length < sent - 2) throw new Error(`${events.length} wheel events for ${sent} posted: the page missed the start, or Firefox was not in front`);
  return { stage: streams[0].stage, from: streams[0].from, events };
}

/** Sends Firefox's page on the dev server to an empty board at `s`'s start, replays `s` into it and gives the
 * path of what it captured. */
export async function intoFirefox(s: Stroke): Promise<string> {
  const who = Math.random().toString(36).slice(2, 8), flight = `${root}build/flight/firefox ${who}.json`;
  const url = `/?reference=${MARGIN - s.start[0]},${MARGIN - s.start[1]}&who=${who}`;
  const goto = () => fetch(`${DEV}/goto?url=${encodeURIComponent(url)}`, { method: "POST", signal: AbortSignal.timeout(2000) })
    .then((r) => r.json() as Promise<{ pages: number }>)
    .catch(() => { throw new Error("start the dev server: npm run dev"); });
  let pages = (await goto()).pages;
  if (!pages) {
    spawn("open", ["-a", "Firefox", `http://localhost:58565${url}`]);
    for (const until = Date.now() + 15_000; !pages && Date.now() < until; await new Promise((r) => setTimeout(r, 500))) pages = (await goto()).pages;
    if (!pages) throw new Error("Firefox opened no page on the dev server in 15 s");
  }
  // each page would write the same flight file
  if (pages > 1) throw new Error(`${pages} pages on the dev server: close all Breezy tabs but one`);
  await new Promise((r) => setTimeout(r, 1500));
  await post(s, "org.mozilla.firefox");
  // pages post their recording every 5 s
  for (const until = Date.now() + 12_000; Date.now() < until; await new Promise((r) => setTimeout(r, 500))) {
    if (!existsSync(flight)) continue;
    const r: Recording = JSON.parse(readFileSync(flight, "utf8"));
    if (!r.entries.some((e) => e[2] === "wheel")) continue;
    const c = captureOf(r, s), dir = `${root}build/reference/firefox`;
    mkdirSync(dir, { recursive: true });
    let n = 1;
    while (existsSync(`${dir}/${s.name}-${n}.json`)) n++;
    writeFileSync(`${dir}/${s.name}-${n}.json`, JSON.stringify(c));
    return `${dir}/${s.name}-${n}.json`;
  }
  throw new Error(`no wheel stream in ${flight} after 12 s: was Firefox's page on the reference board, in front?`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, flag, into] = process.argv.slice(2);
  if (!file || flag !== "--into" || !["reference", "firefox"].includes(into)) {
    console.error("usage: node scripts/replay.ts <stroke.json> --into reference|firefox");
    process.exit(2);
  }
  const s: Stroke = JSON.parse(readFileSync(file, "utf8"));
  console.log(await (into === "firefox" ? intoFirefox(s) : intoReference(s)));
}
