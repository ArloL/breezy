// What a scenario run on real devices keeps, passing or failing, in build/scenarios/<when> <test>/: case.json, for a
// soak to count failures by case, pair and step (scripts/scenario-stats.ts), and timeline.txt, every source on one
// wall clock: the case's steps, each device's page and sync, the touches sent, the runner's load, and on a failing phone
// the emulator's log. A failure should explain itself from these without a rerun.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, freemem, loadavg, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { promisify } from "node:util";

const root = new URL("..", import.meta.url).pathname;
export const RECORDS = join(root, "build", "scenarios");

/** Something a device or the world was asked to do, on Date.now(). */
export interface Step {
  who: string;
  action: string;
  args: string;
  at: number;
  /** How long it took; none while it runs, or once it never ended. */
  ms?: number;
  /** How many in a row, for waits. */
  times?: number;
  error?: string;
  /** What its device showed just after it, read while the case went on. */
  after?: string;
}

/** A source's line on Date.now(). */
export type Line = [at: number, source: string, what: string];

/** Methods that only look, and so are no step. */
export const LOOKS = new Set(["scene", "size", "screen", "world", "editor", "weights", "sight", "syncStatus", "unpushed", "state", "constructor"]);

export const brief = (v: unknown): string => {
  if (typeof v === "function") return "ƒ";
  const s = JSON.stringify(v, (_, x) => typeof x === "number" ? Math.round(x * 10) / 10 : typeof x === "function" ? "ƒ" : x) ?? String(v);
  return s.length > 160 ? `${s.slice(0, 159)}…` : s;
};

export class Steps {
  readonly list: Step[] = [];
  private readonly reads: Promise<unknown>[] = [];

  /** `f` as a step of `who`'s; `after`, if given, read once it ends without the case waiting for it. */
  async run<T>(who: string, action: string, args: unknown[], f: () => Promise<T>, after?: () => Promise<string>): Promise<T> {
    const last = this.list.at(-1);
    // a polling loop's waits, as one step from its first to its last, the looks between them in it
    if (action === "wait" && last?.who === who && last.action === "wait" && last.ms !== undefined) {
      last.ms = undefined;
      try {
        return await f();
      } finally {
        last.times = (last.times ?? 1) + 1;
        last.ms = Date.now() - last.at;
      }
    }
    const step: Step = { who, action, args: args.map(brief).join(", "), at: Date.now() };
    this.list.push(step);
    try {
      return await f();
    } catch (e) {
      step.error = (e as Error).message?.split("\n")[0] ?? String(e);
      throw e;
    } finally {
      step.ms = Date.now() - step.at;
      if (after && action !== "wait") this.reads.push(after().then((s) => (step.after = s), (e: Error) => (step.after = `unread: ${e.message.split("\n")[0]}`)));
    }
  }

  /** `d` with each method a case calls on it a step of `who`'s, its state after it read by `state`; what `d` calls on
   * itself is no step. */
  wrap<T extends object>(d: T, who: string, state: () => Promise<string>): T {
    return new Proxy(d, {
      get: (target, prop) => {
        const v = Reflect.get(target, prop, target);
        if (typeof v !== "function" || typeof prop !== "string" || LOOKS.has(prop)) return typeof v === "function" ? v.bind(target) : v;
        return (...args: unknown[]) => this.run(who, prop, args, () => v.apply(target, args), state);
      },
    });
  }

  /** Once each state read has ended, or after `ms`. */
  async read(ms = 3000) {
    await Promise.race([Promise.allSettled(this.reads), new Promise((r) => setTimeout(r, ms))]);
  }

  /** The step that threw, else the one that never ended. */
  failed(): Step | undefined {
    return this.list.find((s) => s.error) ?? this.list.findLast((s) => s.ms === undefined);
  }

  lines(): Line[] {
    return this.list.flatMap((s): Line[] => {
      const head = `${s.action}(${s.args})${s.times ? ` ×${s.times}` : ""}`;
      if (s.ms === undefined) return [[s.at, s.who, `▶ ${head}, never ended`]];
      return [[s.at, s.who, `▶ ${head}`], [s.at + s.ms, s.who, `◀ ${s.action} ${s.ms} ms${s.error ? `, threw ${s.error}` : ""}${s.after ? `: ${s.after}` : ""}`]];
    });
  }
}

/** The runner's load every `ms`, and how late node's own timers ran, as a starved runner makes a flake. */
export function sampleRunner(lines: Line[], ms = 2000) {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  const timer = setInterval(() => {
    const [one] = loadavg();
    lines.push([Date.now(), "runner", `load ${one!.toFixed(2)} of ${cpus().length} CPUs, ${Math.round(freemem() / 2 ** 20)} MB free, node's timers up to ${Math.round(delay.max / 1e6)} ms late`]);
    delay.reset();
  }, ms);
  timer.unref();
  return () => {
    clearInterval(timer);
    delay.disable();
  };
}

/** One text of `lines` in time, each with its wall clock and ms from `start`. */
export function timeline(lines: Line[], start: number): string {
  const width = Math.max(0, ...lines.map(([, s]) => s.length));
  return lines
    .map((l, i) => [l, i] as const)
    // in order of time, else as given: a step's start before what it caused at the same ms
    .sort(([a, i], [b, j]) => a[0] - b[0] || i - j)
    .map(([[at, source, what]]) => `${new Date(at).toISOString().slice(11, 23)} ${`+${Math.round(at - start)}`.padStart(7)}  ${source.padEnd(width)}  ${what}`)
    .join("\n");
}

/** The lines of a `logcat -v threadtime -v epoch` log to see among the case's own: errors, and what the browsers, the
 * keyboard, the window manager and the frame scheduler say; a line repeated at once counted, not repeated. */
export function logcatLines(log: string, source: string): Line[] {
  const lines: Line[] = [];
  let last = "", times = 1;
  for (const l of log.split("\n")) {
    const m = /^\s*(\d+\.\d+)\s+\d+\s+\d+\s+([VDIWEF])\s+(.*?)\s*: (.*)$/.exec(l);
    if (!m) continue;
    const [, at, level, tag, text] = m as unknown as [string, string, string, string, string];
    const ours = /^(chromium|cr_\w+|Gecko\w*|GeckoConsole|ImeTracker|InputMethodManagerService|WindowManager|ActivityManager|ActivityTaskManager|Choreographer|ANRManager|DEBUG|libc)$/.test(tag);
    if (!(level === "E" || level === "F" || ours && level !== "V" && level !== "D")) continue;
    const what = `${level} ${tag}: ${text}`;
    if (what === last) {
      lines.at(-1)![2] = `${what} (×${++times})`;
      continue;
    }
    [last, times] = [what, 1];
    lines.push([Number(at) * 1000, source, what]);
  }
  return lines;
}

const run = promisify(execFile);

/** `adb -s serial args`, its output, bounded by `timeout`: adb waits without end on a wedged emulator. */
export async function adb(serial: string, args: string[], timeout = 10_000): Promise<string> {
  return (await run("adb", ["-s", serial, ...args], { encoding: "utf8", timeout, maxBuffer: 256 * 2 ** 20 })).stdout;
}

/** `adb -s serial args` as bytes, bounded by `timeout`. */
export async function adbBytes(serial: string, args: string[], timeout = 10_000): Promise<Buffer> {
  return (await run("adb", ["-s", serial, ...args], { encoding: "buffer", timeout, maxBuffer: 256 * 2 ** 20 })).stdout;
}

let env: Promise<Record<string, unknown>> | undefined;

/** What ran the scenarios: the runner, node and Playwright, and the emulator, its renderer and its browsers when adb
 * sees one. Read once, and kept in build/scenarios/environment.json too. */
export function environment(): Promise<Record<string, unknown>> {
  return env ??= (async () => {
    const e: Record<string, unknown> = {
      os: `${platform()} ${release()} ${arch()}`,
      cpus: `${cpus().length} × ${cpus()[0]?.model ?? "?"}`,
      memory: `${Math.round(totalmem() / 2 ** 30)} GB`,
      kvm: platform() === "linux" ? existsSync("/dev/kvm") : undefined,
      node: process.version,
      playwright: JSON.parse(readFileSync(join(root, "node_modules/playwright-core/package.json"), "utf8")).version,
      runner: process.env.RUNNER_NAME && `${process.env.RUNNER_NAME}, ${process.env.ImageOS} ${process.env.ImageVersion}`,
      run: process.env.GITHUB_RUN_ID && `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT}`,
      commit: process.env.GITHUB_SHA,
    };
    try {
      const serial = /^(emulator-\d+)\tdevice$/m.exec((await run("adb", ["devices"], { encoding: "utf8", timeout: 10_000 })).stdout)?.[1];
      if (serial) {
        const prop = async (p: string) => (await adb(serial, ["shell", "getprop", p]).catch(() => "")).trim();
        const version = async (pkg: string) => /versionName=(\S+)/.exec(await adb(serial, ["shell", "dumpsys", "package", pkg]).catch(() => ""))?.[1];
        // the renderer the emulator chose, which only its own log says: SwiftShader once deadlocked Firefox's display
        const log = join(root, "build", "android-emulator.log");
        e.emulator = {
          image: await prop("ro.build.fingerprint"),
          sdk: await prop("ro.build.version.sdk"),
          screen: (await adb(serial, ["shell", "wm", "size"]).catch(() => "")).trim().split("\n").at(-1),
          density: (await adb(serial, ["shell", "wm", "density"]).catch(() => "")).trim().split("\n").at(-1),
          renderer: existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => /Graphics backend|gles_mode_selected|Graphics Adapter|forcing software|Emulator version/i.test(l)).map((l) => l.replace(/^\w+\s*\|\s*/, "").trim()) : "no build/android-emulator.log",
          chrome: await version("com.android.chrome"),
          firefox: await version("org.mozilla.firefox"),
          keyboard: (await adb(serial, ["shell", "settings", "get", "secure", "default_input_method"]).catch(() => "")).trim(),
        };
      }
    } catch {}
    mkdirSync(RECORDS, { recursive: true });
    writeFileSync(join(RECORDS, "environment.json"), `${JSON.stringify(e, null, 2)}\n`);
    return e;
  })();
}
