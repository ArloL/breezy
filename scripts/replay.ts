// Replays a stroke the reference app recorded (Reference/) into it again, to check the replay is faithful, or into
// Firefox on the dev server: docs/superpowers/specs/2026-11-10-breezy-native-reference-design.md. The events are
// posted by scripts/replay-helper.swift, started once from Terminal.app, which holds Accessibility.
//
//   node scripts/replay.ts build/reference/push-hold-1.json --into reference
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const HELPER = "http://127.0.0.1:58569";
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
  return helper("/replay", { app: bundle, events }, (s.events.at(-1)?.[0] ?? 0) + 10_000);
}

/** Launches the reference at `s`'s start, replays `s` into it and gives the path of the stroke it recorded. */
export async function intoReference(s: Stroke): Promise<string> {
  await helper("/ping");
  const app = spawn(REFERENCE_APP, ["--stage", s.stage.join("x"), "--start", s.start.join(","), "--name", `${s.name}-replay`], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const recorded = new Promise<string>((ok, no) => {
      app.stdout.on("data", (d: Buffer) => ok(d.toString().trim().split("\n")[0]));
      app.on("exit", (code) => no(new Error(`the reference app exited (${code}) before recording`)));
    });
    await new Promise((r) => setTimeout(r, 1500));
    await post(s, "local.breezy.reference");
    const deadline = new Promise<never>((_, no) => setTimeout(() => no(new Error("the reference app recorded nothing in 20 s")), 20_000).unref());
    return await Promise.race([recorded, deadline]);
  } finally {
    app.kill();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, flag, into] = process.argv.slice(2);
  if (!file || flag !== "--into" || into !== "reference") {
    console.error("usage: node scripts/replay.ts <stroke.json> --into reference");
    process.exit(2);
  }
  const s: Stroke = JSON.parse(readFileSync(file, "utf8"));
  console.log(await intoReference(s));
}
