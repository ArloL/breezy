// Safari on the iOS Simulator as a scenario device: it loads the app from this Mac's localhost, keeps a service worker
// and IndexedDB as an iPhone does, and shows the board. Its touches and keys go through idb as one HID stream per
// gesture (scripts/sim-hid.py), so a double tap's waits hold; the page is read through the agent the scenarios' server
// puts in it (agent.ts). One finger only: idb's touch has one point. scripts/ios.ts boots the simulator.
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Device, item, type Editor, type Frame, type PointerExtra, type PointerPhase, type Scene } from "./device.ts";
import type { AgentPage } from "./agent.ts";
import type { Point } from "../web/types.ts";

const root = new URL("..", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** HID usages of the keys cases press. */
const KEYS: Record<string, number> = { Enter: 40, Escape: 41, Backspace: 42, Tab: 43, " ": 44 };

/** The booted iPhone's id, or null. */
export function bootedIphone(): string | null {
  const { devices } = JSON.parse(execFileSync("xcrun", ["simctl", "list", "devices", "booted", "--json"], { encoding: "utf8", timeout: 30_000 })) as
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
export function homeIcon(udid: string, label = HOME_ICON): { x: number; y: number } | null {
  const out = execFileSync("uvx", ["--quiet", "--python", "3.11", "--from", "fb-idb", "idb", "ui", "describe-all", "--udid", udid, "--json"],
    { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "ignore"] });
  const e = (JSON.parse(out) as { AXLabel?: string; type?: string; frame: { x: number; y: number; width: number; height: number } }[])
    .find((x) => x.type === "Button" && x.AXLabel === label);
  return e ? { x: e.frame.x + e.frame.width / 2, y: e.frame.y + e.frame.height / 2 } : null;
}

/** Clears what the app on the Home Screen keeps, its storage, caches and service worker, while it does not run: cleared
 * from its page instead, it would have to load again, and a page loaded again there sees no touch. */
export function clearHomeApp(udid: string) {
  const clips = join(homedir(), "Library/Developer/CoreSimulator/Devices", udid, "data/Library/WebClips");
  for (const clip of existsSync(clips) ? readdirSync(clips) : []) {
    const title = execFileSync("plutil", ["-extract", "Title", "raw", join(clips, clip, "Info.plist")], { encoding: "utf8", timeout: 10_000 }).trim();
    if (title === HOME_ICON) rmSync(join(clips, clip, "Storage"), { recursive: true, force: true });
  }
}

/** scripts/sim-hid.py on the booted iPhone: a line of JSON per command, answered in turn. */
export class SimHid {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly replies: ((line: string) => void)[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private ended = "";

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (l) => this.replies.shift()?.(l));
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
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
      this.child.stdin.write(`${JSON.stringify(c)}\n`);
      return a;
    });
    this.tail = done.catch(() => {});
    return done;
  }

  /** One finger's events in screen points, each after its wait in ms, as one stream. */
  touches(t: [number, PointerPhase, number, number][]) {
    return this.send({ touches: t });
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

export class IosDevice extends Device {
  /** In a Safari tab, or the app added to the Home Screen. */
  readonly kind: "ios-safari" | "ios-home";
  readonly page: AgentPage;
  readonly hid: SimHid;
  private readonly fns: { scene: () => Scene; editor: () => Editor | null; weights: (id: string) => number[] | null };
  /** Where the page's top left is on the screen, in points. */
  private offset: Point = { x: 0, y: 0 };

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
        if (e instanceof PointerEvent && e.type === "pointerdown") w.tapped = { x: e.clientX, y: e.clientY };
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
    await this.page.evaluate(() => {
      const w = window as { calibrating?: (e: Event) => void };
      for (const type of ["pointerdown", "pointerup", "touchstart", "touchend", "mousedown", "mouseup", "click"]) removeEventListener(type, w.calibrating!, { capture: true });
    });
    this.offset = { x: at.x - tapped.x, y: at.y - tapped.y };
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

  /** A gesture's frames as one stream, so its waits hold; with one finger. */
  override async gesture(frames: Frame[]) {
    const t: [number, PointerPhase, number, number][] = [];
    for (const [ms, phase, moves] of frames) {
      if (moves.length > 1 || moves.some(([f]) => f !== moves[0]![0])) throw new Error("Safari on the iOS Simulator has one finger only");
      for (const [, p] of moves) t.push([ms, phase, p.x + this.offset.x, p.y + this.offset.y]);
    }
    const fingers = new Set(frames.flatMap(([, , moves]) => moves.map(([f]) => f)));
    if (fingers.size > 1) throw new Error("Safari on the iOS Simulator has one finger only");
    await this.hid.touches(t);
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
    await this.doubleTap({ x, y });
    await this.type("card");
    const id = (await this.scene()).cards.find((c) => !had.has(c.id))?.id;
    if (!id) throw new Error("the double tap made no card");
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
    const l = item(await this.scene(), id), at = await this.screen({ x: l.x + l.w / 2, y: l.y + l.h / 2 }), to = await this.screen({ x, y });
    const d = { x: to.x - at.x, y: to.y - at.y }, size = await this.size(), lane = await this.screen({ x: l.x, y: l.y });
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
    return id;
  }

  /** A tap on the middle of the first of what `selector` finds that shows. */
  async tapOn(selector: string) {
    const r = await this.page.evaluate((s: string) => {
      const b = [...document.querySelectorAll(s)].map((e) => e.getBoundingClientRect()).find((b) => b.width && b.height);
      return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
    }, selector);
    if (!r) throw new Error(`nothing shows ${selector}`);
    await this.tapAt(r);
  }

  /** A tap at page point `p`. */
  private tapAt(p: Point) {
    return this.gesture([[0, "down", [[0, p]]], [50, "up", [[0, p]]]]);
  }

  stop() {
    this.hid.stop();
  }
}
