// Safari on the iOS Simulator as a scenario device: it loads the app from this Mac's localhost, keeps a service worker
// and IndexedDB as an iPhone does, and shows the board. Its page's touches go through scripts/sim-finger.m, each event
// stamped for when it was meant, so a gesture's times hold however late a busy runner sends it; its keys, the Home Screen
// and Safari's own touches go through idb (scripts/sim-hid.py). The page is read through the agent the scenarios' server
// puts in it (agent.ts). One finger only. scripts/ios.ts boots the simulator.
import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Device, item, readFlight, type Editor, type Frame, type PointerExtra, type PointerPhase, type Scene, type Sight } from "./device.ts";
import type { AgentPage } from "./agent.ts";
import type { Line } from "./record.ts";
import type { Point } from "../web/types.ts";
import { DOUBLE_MS } from "../web/gestures.ts";

const root = new URL("..", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** HID usages of the keys cases press. */
const KEYS: Record<string, number> = { Enter: 40, Escape: 41, Backspace: 42, Tab: 43, " ": 44 };

/** Each simctl call this process made, for a case's timeline: when, what, how long, and how it failed. */
export const simctlLog: Line[] = [];

/** `xcrun simctl ...args`, its output, noted in simctlLog: a call slow before one that times out is the signal, and its
 * failure says why only in what it wrote to stderr. */
export function simctl(args: string[], { timeout }: { timeout: number }, run: (file: string, args: string[], o: ExecFileSyncOptionsWithStringEncoding) => string = execFileSync): string {
  const t0 = Date.now(), what = `simctl ${args.map((a) => a.length > 80 ? `${a.slice(0, 79)}…` : a).join(" ")}`;
  // a long run's calls, not without end
  if (simctlLog.length > 2000) simctlLog.splice(0, 1000);
  try {
    // a busy iPhone's log show of 5 minutes passes Node's 1 MiB
    const out = run("xcrun", ["simctl", ...args], { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 2 ** 20 });
    simctlLog.push([t0, "simctl", `${what}: ${Date.now() - t0} ms`]);
    return String(out ?? "");
  } catch (e) {
    const { status, signal, stderr } = e as { status?: number | null; signal?: string | null; stderr?: string };
    const said = String(stderr ?? "").trim().replace(/\s+/g, " ").slice(0, 400);
    simctlLog.push([t0, "simctl", `${what}: failed after ${Date.now() - t0} ms, ${signal ? `killed by ${signal}` : `exit ${status}`}${said ? `: ${said}` : ""}`]);
    throw e;
  }
}

/** The simctl calls since `since` that failed, as simctlLog says them. */
export function simctlFailures(since: number): string[] {
  return simctlLog.filter(([at, , what]) => at >= since && /: failed after \d+ ms, /.test(what)).map(([, , what]) => what);
}

/** The errors and faults of a `log show --style compact` of the simulator, as timeline lines of `who`'s, on the wall
 * clock: the rest is too much to read among the case's own, and stays in its file. */
export function iosLogLines(log: string, who: string): Line[] {
  const lines: Line[] = [];
  for (const l of log.split("\n")) {
    const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d{3})\S*\s+([EF])\s+([^[\s]+)\[[^\]]*\]\s*(.*)$/.exec(l);
    if (!m) continue;
    const [y, mo, d, h, mi, s, ms] = m.slice(1, 8).map(Number) as [number, number, number, number, number, number, number];
    lines.push([new Date(y, mo - 1, d, h, mi, s, ms).getTime(), `${who} log`, `${m[8]} ${m[9]}: ${m[10]!.slice(0, 300)}`]);
    if (lines.length >= 200) break;
  }
  return lines;
}

/** What the simulator `udid` was doing as a case on it failed, or a simctl call did, whatever the harness had made of it, into `dir`: its
 * screen, its log of the last 5 minutes from what opens and shows the page, and what of that runs; its log's errors
 * and faults as timeline lines. Each call bounded; what fails is said in its file. */
export function iosState(udid: string, dir: string, who = "iPhone"): Line[] {
  const keep = (name: string, f: () => string) => {
    try {
      writeFileSync(join(dir, `${who} ${name}`), f());
    } catch (e) {
      writeFileSync(join(dir, `${who} ${name}`), `none: ${(e as Error).message.split("\n")[0]}\n`);
    }
  };
  try {
    simctl(["io", udid, "screenshot", "--type=png", join(dir, `${who} screen.png`)], { timeout: 30_000 });
  } catch (e) {
    writeFileSync(join(dir, `${who} screen.txt`), `none: ${(e as Error).message.split("\n")[0]}\n`);
  }
  let log = "";
  keep("log.txt", () => log = simctl(["spawn", udid, "log", "show", "--last", "5m", "--style", "compact", "--predicate",
    'process == "SpringBoard" OR process CONTAINS[c] "safari" OR process CONTAINS[c] "webkit" OR process CONTAINS[c] "webapp" OR process == "launchd"'], { timeout: 60_000 }));
  keep("state.txt", () => [simctl(["list", "devices", "booted"], { timeout: 30_000 }),
    simctl(["spawn", udid, "launchctl", "list"], { timeout: 30_000 }).split("\n").filter((l) => /safari|webkit|webapp|springboard/i.test(l)).join("\n")].join("\n"));
  return iosLogLines(log, who);
}

/** The booted iPhone's id, or null. */
export function bootedIphone(): string | null {
  const { devices } = JSON.parse(simctl(["list", "devices", "booted", "--json"], { timeout: 90_000 })) as
    { devices: Record<string, { udid: string; name: string }[]> };
  return Object.values(devices).flat().find((d) => d.name.startsWith("iPhone"))?.udid ?? null;
}

/** Why Safari on the iOS Simulator cannot run cases here, if it cannot. */
export async function iosUnfit(): Promise<string | false> {
  try {
    execFileSync("which", ["idb_companion"], { stdio: "ignore" });
  } catch {
    return "no idb_companion: brew install facebook/fb/idb-companion";
  }
  return bootedIphone() ? false : "no booted iPhone: run node scripts/ios.ts";
}

/** The name the scenarios' app has on the iPhone's Home Screen. */
export const HOME_ICON = "Breezy Scenarios";

/** Where the Home Screen shows icon `label`, in screen points, or null; SpringBoard's own icons are what its
 * accessibility lists while it is in front. */
/** Forgets the idb companions its record names that have ended, as scripts/sim-hid.py does: idb connects to the one the
 * record names, and its command failed on a record a companion that ended left behind. */
function dropEndedCompanions(state = "/tmp/idb/state") {
  let companions: { pid?: number; path?: string }[];
  try {
    companions = JSON.parse(readFileSync(state, "utf8"));
  } catch {
    return;
  }
  const alive = (c: { pid?: number; path?: string }) => {
    try {
      process.kill(c.pid!, 0);
    } catch {
      return false;
    }
    return !!c.path && existsSync(c.path);
  };
  if (!companions.every(alive)) writeFileSync(state, JSON.stringify(companions.filter(alive)));
}

export function homeIcon(udid: string, label = HOME_ICON): { x: number; y: number } | null {
  // again, a moment later, when idb answers nothing: on CI's runner its command failed once in a run of 38 cases
  let out = "";
  for (let tries = 1; ; tries++) {
    dropEndedCompanions();
    try {
      out = execFileSync("uvx", ["--quiet", "--python", "3.11", "--from", "fb-idb", "idb", "ui", "describe-all", "--udid", udid, "--json"],
        { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
      break;
    } catch (e) {
      if (tries === 3) throw new Error(`idb found no Home Screen: ${(e as { stderr?: string }).stderr?.trim().split("\n").at(-1) ?? (e as Error).message}`);
      execFileSync("sleep", ["2"]);
    }
  }
  return labelled(out, label, ["Button"]);
}

/** The middle of what idb's `describe-all` output `out` lists as one of `types` labelled `label`, in screen points. */
function labelled(out: string, label: string, types: string[]): Point | null {
  const e = (JSON.parse(out) as { AXLabel?: string; type?: string; frame: { x: number; y: number; width: number; height: number } }[])
    .find((x) => types.includes(x.type ?? "") && x.AXLabel === label);
  return e ? { x: e.frame.x + e.frame.width / 2, y: e.frame.y + e.frame.height / 2 } : null;
}

/** Where the iPhone shows iOS's Paste callout, which its accessibility lists as text, or null; not a button, as the
 * page's own Paste is one, which WebKit may hold from closing while the callout shows. Without holding up the cases'
 * clock, as a describe-all takes seconds. */
function pasteCallout(udid: string): Promise<Point | null> {
  dropEndedCompanions();
  return new Promise((resolve) => execFile("uvx", ["--quiet", "--python", "3.11", "--from", "fb-idb", "idb", "ui", "describe-all", "--udid", udid, "--json"],
    { encoding: "utf8", timeout: 30_000 }, (e, out) => resolve(e ? null : labelled(out, "Paste", ["StaticText"]))));
}

/** Clears what the app on the Home Screen keeps, its storage, caches and service worker, while it does not run: cleared
 * from its page instead, it would have to load again, and a page loaded again there sees no touch. */
export function clearHomeApp(udid: string) {
  for (const clip of homeClips(udid)) rmSync(join(clip, "Storage"), { recursive: true, force: true });
}

/** The folders of the Home Screen's web apps named `HOME_ICON`, whatever is in front. */
export function homeClips(udid: string) {
  const clips = join(homedir(), "Library/Developer/CoreSimulator/Devices", udid, "data/Library/WebClips");
  // a share sheet's Add to Home Screen stages a clip with no Info.plist until it is added
  return (existsSync(clips) ? readdirSync(clips) : []).map((c) => join(clips, c)).filter((clip) => existsSync(join(clip, "Info.plist")) &&
    execFileSync("plutil", ["-extract", "Title", "raw", join(clip, "Info.plist")], { encoding: "utf8", timeout: 10_000 }).trim() === HOME_ICON);
}

/** Where the page saw a touch come down, and the screen's top left then, in the board's frame. */
type Down = Point & { vx: number; vy: number };

/** scripts/sim-hid.py on the booted iPhone: a line of JSON per command, answered in turn. */
export class SimHid {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly replies: ((line: string) => void)[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private ended = "";
  /** How many streams of touches it has sent. */
  touched = 0;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (l) => this.replies.shift()?.(l));
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    // a write after it ended fails in answer() instead, naming why it ended
    child.stdin.on("error", () => {});
    child.on("exit", (code) => {
      this.ended = `scripts/sim-hid.py exited with ${code}: ${err.trim().split("\n").at(-1) ?? ""}`;
      for (const r of this.replies.splice(0)) r(JSON.stringify({ error: this.ended }));
    });
  }

  static async start(udid: string): Promise<SimHid> {
    const h = new SimHid(spawn(`${root}scripts/sim-hid.py`, [udid], { stdio: ["pipe", "pipe", "pipe"] }));
    // its first line says it holds the connection
    await h.answer(60_000);
    return h;
  }

  private answer(ms = 30_000) {
    return new Promise<{ ms: number }>((resolve, reject) => {
      if (this.ended) return reject(new Error(this.ended));
      const timer = setTimeout(() => reject(new Error(`scripts/sim-hid.py did not answer in ${ms / 1000} s`)), ms);
      this.replies.push((line) => {
        clearTimeout(timer);
        const r = JSON.parse(line) as { ok?: boolean; ms?: number; error?: string };
        if (r.error) reject(new Error(`scripts/sim-hid.py: ${r.error}`));
        else resolve({ ms: r.ms ?? 0 });
      });
    });
  }

  private send(c: unknown): Promise<{ ms: number }> {
    const done = this.tail.then(() => {
      const a = this.answer();
      if (!this.ended) this.child.stdin.write(`${JSON.stringify(c)}\n`);
      return a;
    });
    this.tail = done.catch(() => {});
    return done;
  }

  /** One finger's events in screen points, each after its wait in ms, as one stream. */
  touches(t: [number, PointerPhase, number, number][]) {
    return this.send({ touches: t }).finally(() => this.touched++);
  }

  text(s: string) {
    return this.send({ text: s });
  }

  key(usage: number) {
    return this.send({ key: usage });
  }

  button(name: "HOME") {
    return this.send({ button: name });
  }

  stop() {
    this.child.kill();
  }
}

/** Safari opened at a URL by `open` until its page asks (`asked`), at most `tries` times: a URL opened while Safari
 * starts goes nowhere, and a simulator busy after its boot gave up on an open after 27 s, at a load of 149 on 3 CPUs. */
/** scripts/sim-finger.m in the booted iPhone, built first: touches stamped with the times they were meant for, as idb's
 * companion overran a tap's 50 ms wait by 90–200 ms on CI's runner, and the board read a tap as a hold. A line of JSON per
 * command, answered in turn. It touches as one of the touchscreens dtuhidd adds once idb has touched, the one `use` names. */
export class SimFinger {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly replies: ((line: string) => void)[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private ended = "";
  /** How many gestures it has sent. */
  touched = 0;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (l) => this.replies.shift()?.(l));
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    child.stdin.on("error", () => {});
    child.on("exit", (code) => {
      this.ended = `scripts/sim-finger.m exited with ${code}: ${err.trim().split("\n").at(-1) ?? ""}`;
      for (const r of this.replies.splice(0)) r(JSON.stringify({ error: this.ended }));
    });
  }

  /** On the booted iPhone `udid`, whose screen is `w` × `h` points. */
  static async start(udid: string, w: number, h: number): Promise<SimFinger> {
    const src = `${root}scripts/sim-finger.m`, bin = `${root}build/sim-finger`;
    if (!existsSync(bin) || statSync(bin).mtimeMs < statSync(src).mtimeMs) {
      mkdirSync(`${root}build`, { recursive: true });
      execFileSync("xcrun", ["--sdk", "iphonesimulator", "clang", "-fobjc-arc", "-arch", "arm64", "-mios-simulator-version-min=17.0",
        "-framework", "Foundation", "-o", bin, src], { stdio: ["ignore", "ignore", "pipe"], timeout: 120_000 });
    }
    const f = new SimFinger(spawn("xcrun", ["simctl", "spawn", udid, bin, String(w), String(h)], { stdio: ["pipe", "pipe", "pipe"] }));
    await f.answer(60_000);
    return f;
  }

  private answer(ms = 30_000) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      if (this.ended) return reject(new Error(this.ended));
      const timer = setTimeout(() => reject(new Error(`scripts/sim-finger.m did not answer in ${ms / 1000} s`)), ms);
      this.replies.push((line) => {
        clearTimeout(timer);
        const r = JSON.parse(line) as { error?: string };
        if (r.error) reject(new Error(`scripts/sim-finger.m: ${r.error}`));
        else resolve(r);
      });
    });
  }

  private send(c: unknown) {
    const done = this.tail.then(() => {
      const a = this.answer();
      if (!this.ended) this.child.stdin.write(`${JSON.stringify(c)}\n`);
      return a;
    });
    this.tail = done.catch(() => {});
    return done;
  }

  /** The touchscreens it may touch as, dtuhidd's first. */
  async touchscreens(): Promise<{ id: string; display: string; transport: string }[]> {
    return (await this.send({ senders: true })).senders as { id: string; display: string; transport: string }[];
  }

  use(id: string) {
    return this.send({ sender: id });
  }

  /** One finger's events in screen points, each after its wait in ms, each stamped for when it was meant. */
  touches(t: [number, PointerPhase, number, number][]) {
    return this.send({ touches: t }).finally(() => this.touched++);
  }

  stop() {
    this.child.kill();
  }
}

export async function openUntilAsked(open: () => Promise<void>, asked: () => Promise<void>, tries: number) {
  for (let attempt = 1; ; attempt++) {
    try {
      await open();
      await asked();
      return;
    } catch (e) {
      if (attempt === tries) throw e;
    }
  }
}

/** How far apart a double tap's taps reached the page, by `times` of its pointer events as the board times them, when
 * too far for the board to take them as one; else null. */
export function apart(times: [string, number][]): number | null {
  const up = times.find(([e]) => e === "pointerup")?.[1], down = times.filter(([e]) => e === "pointerdown")[1]?.[1];
  return up !== undefined && down !== undefined && down - up > DOUBLE_MS ? down - up : null;
}

export class IosDevice extends Device {
  /** In a Safari tab, or the app added to the Home Screen. */
  readonly kind: "ios-safari" | "ios-home";
  readonly page: AgentPage;
  readonly hid: SimHid;
  /** What touches the page, once calibrate has found the touchscreen Safari hears. */
  finger: SimFinger | null = null;
  private readonly fns: { scene: () => Scene; editor: () => Editor | null; weights: (id: string) => number[] | null; sight: () => Sight | null };
  /** Where the visual viewport's top left is on the screen, in points. */
  offset: Point = { x: 0, y: 0 };

  constructor(kind: IosDevice["kind"], page: AgentPage, hid: SimHid, fns: IosDevice["fns"]) {
    super();
    this.kind = kind;
    this.page = page;
    this.hid = hid;
    this.fns = fns;
  }

  /** Finds where the page lies on the screen: a tap the page keeps from itself, in the middle of its screen. */
  async calibrate() {
    await this.page.evaluate(() => {
      const w = window as { calibrating?: (e: Event) => void; tapped?: Point };
      w.calibrating = (e: Event) => {
        e.stopImmediatePropagation();
        ((window as { calibrated?: string[] }).calibrated ??= []).push(e.type);
        // where the screen shows it, in the visual viewport, as a gesture aims
        if (e instanceof PointerEvent && e.type === "pointerdown") w.tapped = { x: e.clientX - (visualViewport!.pageLeft - scrollX), y: e.clientY - (visualViewport!.pageTop - scrollY) };
      };
      for (const type of ["pointerdown", "pointerup", "touchstart", "touchend", "mousedown", "mouseup", "click"]) addEventListener(type, w.calibrating, { capture: true });
    });
    const s = await this.page.evaluate(() => ({ w: screen.width, h: screen.height }));
    const at = { x: Math.round(s.w / 2), y: Math.round(s.h / 2) };
    // again, while it goes unseen: an app just launched from the Home Screen takes no touch for a moment
    let tapped: Point | null = null;
    for (let tries = 0, end = Date.now() + 8000; !(tapped = await this.page.evaluate(() => (window as { tapped?: Point }).tapped ?? null)); await sleep(100)) {
      if (Date.now() > end - 8000 + tries * 2000 && tries < 3) {
        tries++;
        await this.hid.touches([[0, "down", at.x, at.y], [50, "up", at.x, at.y]]);
      }
      if (Date.now() > end) {
        const page = await this.page.evaluate(() => `${location.href}, ${document.visibilityState}, saw ${(window as { calibrated?: string[] }).calibrated?.join(" ") || "nothing"}`);
        throw new Error(`the iPhone's page never saw the calibrating tap at ${at.x},${at.y}: ${page}`);
      }
    }
    // and the touchscreen of dtuhidd's Safari hears, now that idb's tap has started it: only the main display's is, and
    // which that is shows only by trying
    if (!this.finger) {
      const finger = await SimFinger.start(bootedIphone()!, s.w, s.h);
      const tried: string[] = [];
      for (const t of await finger.touchscreens()) {
        await finger.use(t.id);
        await this.page.evaluate(() => void delete (window as { tapped?: Point }).tapped);
        await finger.touches([[0, "down", at.x, at.y], [50, "up", at.x, at.y]]);
        for (const end = Date.now() + 3000; !(await this.page.evaluate(() => !!(window as { tapped?: Point }).tapped)) && Date.now() < end; await sleep(50));
        if (await this.page.evaluate(() => !!(window as { tapped?: Point }).tapped)) {
          this.finger = finger;
          break;
        }
        tried.push(`${t.transport || "the simulator's"} ${t.id} of display ${t.display}`);
      }
      if (!this.finger) {
        finger.stop();
        throw new Error(`Safari heard none of the iPhone's touchscreens: ${tried.join(", ")}`);
      }
    }
    await this.page.evaluate(() => {
      const w = window as { calibrating?: (e: Event) => void };
      for (const type of ["pointerdown", "pointerup", "touchstart", "touchend", "mousedown", "mouseup", "click"]) removeEventListener(type, w.calibrating!, { capture: true });
    });
    this.offset = { x: at.x - tapped.x, y: at.y - tapped.y };
    // its requests to sync.php, its relay socket, the edits waiting to be pushed and its touches, on the wall clock, for
    // a failing case's timeline, as Playwright keeps a browser's: nothing else sees an iPhone's network
    await this.page.evaluate(() => {
      const log: [number, string][] = (window as { syncLog?: [number, string][] }).syncLog = [];
      const note = (what: string) => log.push([Date.now(), what]);
      const fetched = window.fetch;
      window.fetch = async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.includes("sync.php")) return fetched(input, init);
        const t0 = Date.now();
        note(`${init?.method ?? "GET"} sync.php`);
        try {
          const r = await fetched(input, init);
          note(`sync.php answers ${r.status} in ${Date.now() - t0} ms`);
          return r;
        } catch (e) {
          note(`sync.php fails after ${Date.now() - t0} ms: ${e}`);
          throw e;
        }
      };
      const Socket = window.WebSocket;
      window.WebSocket = class extends Socket {
        constructor(...args: ConstructorParameters<typeof WebSocket>) {
          super(...args);
          note("relay socket opens");
          this.addEventListener("close", (e) => note(`relay socket closes, ${e.code}`));
        }
      };
      // and what a touch reached, and where the keyboard's focus went: a tap meant for the board once left the edit open
      const what = (t: EventTarget | null) => t instanceof Element ? `${t.tagName.toLowerCase()}${t.id ? `#${t.id}` : ""}${t.classList.length ? `.${[...t.classList].join(".")}` : ""}` : String(t);
      for (const type of ["pointerdown", "pointerup", "click"]) {
        addEventListener(type, (e) => {
          const p = e as PointerEvent;
          // in the board's frame, as a gesture aims, with where the screen's top left was in it as it came
          const b = document.querySelector("#board")?.getBoundingClientRect() ?? { left: 0, top: 0 };
          // and when, by the event's clock as the board's (apart): a listener run late on a busy phone hears its taps further apart
          ((window as { touchTimes?: [string, number][] }).touchTimes ??= []).push([type, e.timeStamp]);
          if (type === "pointerdown") (window as { down?: Down }).down = { x: p.clientX - b.left, y: p.clientY - b.top, vx: visualViewport!.pageLeft - scrollX - b.left, vy: visualViewport!.pageTop - scrollY - b.top };
          note(`${type} at ${Math.round(p.clientX)},${Math.round(p.clientY)} on ${what(e.target)}`);
        }, { capture: true });
      }
      // and how iOS moves the visual viewport and scrolls the page under the keyboard
      const vv = () => `the visual viewport at ${Math.round(visualViewport!.pageTop)}+${Math.round(visualViewport!.height)}, the page scrolled ${Math.round(scrollY)} of ${innerHeight}`;
      visualViewport!.addEventListener("resize", () => note(`resize: ${vv()}`));
      visualViewport!.addEventListener("scroll", () => note(`scroll: ${vv()}`));
      addEventListener("focusin", (e) => note(`focus to ${what(e.target)}`), { capture: true });
      addEventListener("focusout", (e) => note(`focus leaves ${what(e.target)}`), { capture: true });
      let waiting = document.body.dataset.waiting;
      new MutationObserver(() => {
        if (document.body.dataset.waiting !== waiting) note(`${(waiting = document.body.dataset.waiting) ?? 0} waiting to be pushed`);
      }).observe(document.body, { attributes: true, attributeFilter: ["data-waiting"] });
    });
    // what the keyboard asks of the page, for a typing failure to quote
    await this.page.evaluate(() => {
      const log: string[] = (window as { inputs?: string[] }).inputs = [];
      addEventListener("beforeinput", (e) => log.push(`${e.inputType} ${JSON.stringify(e.data)}${e.getTargetRanges().length ? ` over ${e.getTargetRanges().map((r) => `${r.startOffset}-${r.endOffset}`).join(",")}` : ""}`), { capture: true });
    });
  }

  override async size() {
    return this.page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  }

  scene() {
    return this.page.evaluate(this.fns.scene);
  }

  override get draws() {
    return true;
  }

  override get edits() {
    return true;
  }

  override editor() {
    return this.page.evaluate(this.fns.editor);
  }

  override flight() {
    return this.page.evaluate(readFlight);
  }

  override sight() {
    return this.page.evaluate(this.fns.sight);
  }

  override weights(id: string) {
    return this.page.evaluate(this.fns.weights, id);
  }

  override async syncStatus() {
    return this.page.evaluate(() => document.querySelector(".menu.more .status")?.textContent ?? "");
  }

  override async unpushed() {
    return this.page.evaluate(() => Number(document.body.dataset.waiting ?? 0));
  }

  async wait(ms: number) {
    await sleep(ms);
  }

  /** Where world point `p` is, by the board's frame: the page shrinks under the keyboard, but iOS scrolls the board to
   * show what it covers, so whether a touch reached the page is told by the page (gesture). */
  protected override async onScreen(p: Point) {
    return this.screen(p);
  }

  /** A gesture's frames as one stream, so its waits hold; with one finger. */
  override async gesture(frames: Frame[]) {
    // points in the board's frame, as the camera and tapOn give them, where the screen shows them now: iOS moves the
    // visual viewport, and scrolls the page and the fixed board with it, to show a field the keyboard would cover, and
    // a tap aimed by the page alone landed 60 pt lower, in the card's editor, not on the board
    const vv = await this.page.evaluate(() => {
      const b = document.querySelector("#board")?.getBoundingClientRect() ?? { left: 0, top: 0 };
      return { x: visualViewport!.pageLeft - scrollX - b.left, y: visualViewport!.pageTop - scrollY - b.top };
    });
    const t: [number, PointerPhase, number, number][] = [];
    for (const [ms, phase, moves] of frames) {
      if (moves.length > 1 || moves.some(([f]) => f !== moves[0]![0])) throw new Error("Safari on the iOS Simulator has one finger only");
      for (const [, p] of moves) t.push([ms, phase, p.x - vv.x + this.offset.x, p.y - vv.y + this.offset.y]);
    }
    const fingers = new Set(frames.flatMap(([, , moves]) => moves.map(([f]) => f)));
    if (fingers.size > 1) throw new Error("Safari on the iOS Simulator has one finger only");
    await this.page.evaluate(() => {
      delete (window as { down?: Down }).down;
      (window as { touchTimes?: [string, number][] }).touchTimes = [];
    });
    if (!this.finger) throw new Error("the iPhone was not calibrated");
    await this.finger.touches(t);
    // and the first touch where it was aimed, as a person sees where their finger lands, but for how far the visual
    // viewport moved meanwhile, as it does a moment after typing
    const aimed = frames[0]?.[1] === "down" ? frames[0][2][0]![1] : null;
    let down: Down | null = null;
    // the status bar, or Safari's own bars, take a touch the page never hears of
    for (const end = Date.now() + 2000; aimed && !(down = await this.page.evaluate(() => (window as { down?: Down }).down ?? null)); await sleep(100)) {
      if (Date.now() > end) throw new Error(`a touch aimed at ${Math.round(aimed.x)},${Math.round(aimed.y)} on the page never reached it, the visual viewport at ${Math.round(vv.x)},${Math.round(vv.y)}`);
    }
    if (aimed && down && Math.hypot(down.x - (aimed.x + down.vx - vv.x), down.y - (aimed.y + down.vy - vv.y)) > 2) {
      throw new Error(`a touch aimed at ${Math.round(aimed.x)},${Math.round(aimed.y)} on the page landed at ${Math.round(down.x)},${Math.round(down.y)}, the visual viewport at ${Math.round(vv.x)},${Math.round(vv.y)} then ${Math.round(down.vx)},${Math.round(down.vy)}`);
    }
    // and as long as it was sent, by the events' own times as the board reads them: idb's taps came 90–200 ms long
    if (aimed && t.at(-1)?.[1] === "up") {
      const sent = t.slice(1).reduce((ms, [wait]) => ms + wait, 0);
      let times: [string, number][] = [];
      for (const end = Date.now() + 2000; Date.now() < end; await sleep(50)) {
        times = await this.page.evaluate(() => (window as { touchTimes?: [string, number][] }).touchTimes ?? []);
        if (times.filter(([e]) => e === "pointerup").length === t.filter(([, phase]) => phase === "up").length) break;
      }
      const first = times.find(([e]) => e === "pointerdown")?.[1], last = times.findLast(([e]) => e === "pointerup")?.[1];
      if (first !== undefined && last !== undefined && Math.abs(last - first - sent) > 2) {
        throw new Error(`a gesture sent as ${sent} ms from its first touch to its last lift reached the page ${Math.round(last - first)} ms long`);
      }
    }
  }

  async pointer(phase: PointerPhase, p: Point, extra: PointerExtra = {}) {
    if (extra.kind !== "touch") throw new Error("Safari on the iOS Simulator takes touches only");
    await this.gesture([[0, phase, [[extra.finger ?? 0, p]]]]);
  }

  /** Once an editor has the keyboard; until what was typed shows there, and the board stands still. */
  override async type(text: string) {
    await this.page.waitForFunction(() => {
      const e = document.activeElement;
      return e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement || (e as HTMLElement | null)?.isContentEditable === true;
    }, undefined, { timeout: 5000 });
    const held = () => this.page.evaluate(() => {
      const e = document.activeElement;
      return (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement ? e.value : e?.textContent ?? "").replace(/​/g, "").replace(/\n$/, "");
    });
    const before = await held();
    for (const part of text.split(/(\n)/)) {
      if (part === "\n") await this.hid.key(KEYS.Enter!);
      else if (part) await this.hid.text(part);
    }
    for (const end = Date.now() + 5000; ; await sleep(50)) {
      const now = await held();
      if (now.length >= before.length + text.replace(/\n/g, "").length) break;
      if (Date.now() > end) {
        const inputs = await this.page.evaluate(() => (window as { inputs?: string[] }).inputs?.slice(-12).join("; ") ?? "");
        throw new Error(`${JSON.stringify(text)} typed into ${JSON.stringify(before)}, the editor holds ${JSON.stringify(now)}; the keyboard asked: ${inputs}`);
      }
    }
    await this.still("the keyboard to open and the board to stand still");
  }

  async key(key: string, mods: { meta?: boolean; shift?: boolean } = {}) {
    if (mods.meta) throw new Error("Safari on the iOS Simulator has no ⌘ here");
    const usage = KEYS[key];
    if (usage !== undefined) await this.hid.key(usage);
    else if ([...key].length === 1) await this.hid.text(key);
    else throw new Error(`no key ${key} on the iPhone`);
  }

  /** Until the page's size and the board's camera have not changed for 500 ms, as a person waits to aim, and the board
   * stays put over three frames drawn: on a busy runner Safari drew no frame for longer than that in the middle of a
   * zoom, which looked still. */
  override async still(what: string) {
    let last = "", since = Date.now();
    const drawn = () => Promise.race([this.page.evaluate(async () => {
      const at = () => document.querySelector<HTMLElement>(".world")?.style.transform;
      const was = at();
      for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
      return was === at();
    }), sleep(2000).then(() => false)]);
    for (const end = Date.now() + 10_000; ; await sleep(100)) {
      const now = JSON.stringify([await this.page.evaluate(() => [innerHeight, visualViewport!.height, visualViewport!.offsetTop]), (await this.scene()).camera]);
      if (now !== last) [last, since] = [now, Date.now()];
      if (Date.now() - since >= 500 && await drawn()) return;
      if (Date.now() > end) throw new Error(`timed out after 10000 ms: ${what}`);
    }
  }

  /** As a person makes one on an iPhone: a double tap, a title, and Done. */
  async addCard(x: number, y: number): Promise<string> {
    const had = new Set((await this.scene()).cards.map((c) => c.id));
    // as a person taps a board once it stops moving: a tap stops a board just opened from springing into place, and a
    // double tap 16 ms after the Home Screen app opened its board made no card
    await this.still("the board to stand still");
    // again, as a person does, when no card came: on a busy runner the two taps reached the page 440 ms apart
    let id: string | undefined;
    for (let tries = 1; ; tries++) {
      await this.doubleTap({ x, y });
      for (const end = Date.now() + 2000; !(id = (await this.scene()).cards.find((c) => !had.has(c.id))?.id) && Date.now() < end; await sleep(100));
      if (id) break;
      if (tries === 3) throw new Error("the double tap made no card in three tries");
      await this.note("the double tap made no card: again");
    }
    await this.type("card");
    // Done on the keys bar, as a person ends it on an iPhone
    await this.tapOn('[data-act="key-done"]');
    await this.page.waitForFunction(() => !(document.activeElement as HTMLElement | null)?.isContentEditable, undefined, { timeout: 5000 });
    await this.still("the keyboard to go and the board to stand still");
    return id;
  }

  /** As a person makes one on a phone: + and Lane put it in the middle, and a drag on empty board brings it to the
   * point. */
  async addLane(x: number, y: number): Promise<string> {
    const had = new Set((await this.scene()).lanes.map((l) => l.id));
    // + until its menu shows: a board just opened takes no touch for a moment
    for (let tries = 0; !(await this.page.evaluate(() => document.querySelector<HTMLElement>(".add .menu")?.hidden === false)); tries++) {
      if (tries === 3) throw new Error("+ opened no menu in three taps");
      await this.tapOn(".add > button");
      await sleep(400);
    }
    await this.tapOn('[data-act="new-lane"]');
    await sleep(400);
    let id: string | undefined;
    for (const end = Date.now() + 5000; !(id = (await this.scene()).lanes.find((l) => !had.has(l.id))?.id); await sleep(100)) {
      if (Date.now() > end) throw new Error("+ and Lane made no lane");
    }
    await this.still("the lane to settle");
    // the drag again, from where the lane is, until it shows where the point did: on a busy runner a drag sent to take
    // half a second reached the page over 1.9 s, and moved nothing
    const to = await this.screen({ x, y });
    for (let drags = 0; ; drags++) {
      const off = await this.dragLane(id, to, drags < 3);
      if (off < 4) break;
      if (drags === 3) throw new Error(`the lane is ${Math.round(off)} pt from where it was dragged after three drags`);
      if (drags > 0) await this.note(`the drag left the lane ${Math.round(off)} pt from where it was meant: again`);
    }
    return id;
  }

  /** How far lane `id`'s middle is from screen point `to`; with `drag`, the board dragged to bring it there when it is
   * 4 pt or more off. */
  private async dragLane(id: string, to: Point, drag: boolean): Promise<number> {
    const l = item(await this.scene(), id), at = await this.screen({ x: l.x + l.w / 2, y: l.y + l.h / 2 });
    const d = { x: to.x - at.x, y: to.y - at.y }, off = Math.hypot(d.x, d.y);
    if (off < 4 || !drag) return off;
    const size = await this.size(), lane = await this.screen({ x: l.x, y: l.y });
    const z = (await this.scene()).camera.zoom, box = { x: lane.x, y: lane.y, w: l.w * z, h: l.h * z };
    const on = (p: Point) => p.x >= 10 && p.x <= size.w - 10 && p.y >= 120 && p.y <= size.h - 120;
    const clear = (p: Point) => p.x < box.x || p.x > box.x + box.w || p.y < box.y || p.y > box.y + box.h;
    const from = [[0.85, 0.75], [0.15, 0.75], [0.85, 0.3], [0.15, 0.3], [0.5, 0.75], [0.5, 0.3]]
      .map(([fx, fy]) => ({ x: size.w * fx!, y: size.h * fy! })).find((p) => clear(p) && on(p) && on({ x: p.x + d.x, y: p.y + d.y }));
    if (!from) throw new Error(`no empty board to drag the lane ${Math.round(d.x)},${Math.round(d.y)} from`);
    const moves: Frame[] = [];
    for (let i = 1; i <= 12; i++) moves.push([16, "move", [[0, { x: from.x + (d.x * i) / 12, y: from.y + (d.y * i) / 12 }]]]);
    // held still at the end, so that the pan does not coast on
    await this.gesture([[0, "down", [[0, from]]], ...moves, [300, "up", [[0, { x: from.x + d.x, y: from.y + d.y }]]]]);
    await this.still("the pan to settle");
    return off;
  }

  /** Again, as a person does, when its taps reached the page too far apart to be one: on a busy runner they came 600
   * ms apart, and a double tap at 25 % zoom made no card and left the board at 25 %. */
  override async doubleTap(p: Point) {
    for (let tries = 1; ; tries++) {
      await this.page.evaluate(() => void ((window as { touchTimes?: [string, number][] }).touchTimes = []));
      await super.doubleTap(p);
      const gap = apart(await this.page.evaluate(() => (window as { touchTimes?: [string, number][] }).touchTimes ?? []));
      if (gap === null) return;
      if (tries === 3) throw new Error(`the double tap's taps reached the page ${Math.round(gap)} ms apart, three times`);
      await this.note(`the double tap's taps reached the page ${Math.round(gap)} ms apart, two taps: again`);
      await sleep(2 * DOUBLE_MS);
    }
  }

  /** `what` in the iPhone's timeline. */
  private note(what: string) {
    return this.page.evaluate((w: string) => void (window as { syncLog?: [number, string][] }).syncLog?.push([Date.now(), w]), what);
  }

  /** A tap on the middle of the first of what `selector` finds that shows, and reads `text` when given. */
  override async tapOn(selector: string, text?: string) {
    const r = await this.page.evaluate(([s, t]: readonly [string, string | null]) => {
      const b = [...document.querySelectorAll(s)].filter((e) => t === null || e.textContent?.trim() === t)
        .map((e) => e.getBoundingClientRect()).find((b) => b.width && b.height);
      // in the board's frame, as a gesture aims
      const o = document.querySelector("#board")?.getBoundingClientRect() ?? { left: 0, top: 0 };
      return b ? { x: b.x + b.width / 2 - o.left, y: b.y + b.height / 2 - o.top } : null;
    }, [selector, text ?? null] as const);
    if (!r) throw new Error(`nothing shows ${selector}`);
    await this.tapAt(r);
  }

  /** WebKit holds the page while iOS's Paste callout shows, as when another app wrote the clipboard, and the tap's check
   * that the page saw it with it: the callout is tapped by where it shows, as long as the tap waits. */
  override async tapToPaste(selector: string) {
    let tapped = false;
    // its error kept for later, not left unhandled meanwhile
    const tap = this.tapOn(selector).then(() => null, (e: Error) => e).finally(() => (tapped = true));
    const udid = bootedIphone()!, touched = this.finger?.touched;
    // looked for once the tap is sent, as a callout an earlier page left showing is not this one's
    while (!tapped && this.finger?.touched === touched) await sleep(50);
    let callout: Point | null = null;
    while (!tapped && !(callout = await pasteCallout(udid))) await sleep(250);
    if (callout) await this.finger!.touches([[0, "down", callout.x, callout.y], [50, "up", callout.x, callout.y]]);
    const error = await tap;
    if (error) throw error;
    if (callout) await this.note(`tapped iOS's Paste at ${Math.round(callout.x)},${Math.round(callout.y)}`);
  }

  /** A tap at page point `p`. */
  private tapAt(p: Point) {
    return this.gesture([[0, "down", [[0, p]]], [50, "up", [[0, p]]]]);
  }

  /** What the page noted of its sync, for the timeline. */
  async syncLog(): Promise<[number, string][]> {
    return this.page.evaluate(() => (window as { syncLog?: [number, string][] }).syncLog ?? []);
  }

  stop() {
    this.hid.stop();
    this.finger?.stop();
  }
}
