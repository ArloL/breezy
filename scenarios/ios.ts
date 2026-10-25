// Safari on the iOS Simulator as a scenario device: it loads the app from this Mac's localhost, keeps a service worker
// and IndexedDB as an iPhone does, and shows the board. Its touches and keys go through idb as one HID stream per
// gesture (scripts/sim-hid.py), so a double tap's waits hold; the page is read through the agent the scenarios' server
// puts in it (agent.ts). One finger only: idb's touch has one point. scripts/ios.ts boots the simulator.
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

  stop() {
    this.child.kill();
  }
}

export class IosDevice extends Device {
  readonly kind = "ios-safari";
  readonly page: AgentPage;
  private readonly hid: SimHid;
  private readonly fns: { scene: () => Scene; editor: () => Editor | null; weights: (id: string) => number[] | null };
  /** Where the page's top left is on the screen, in points. */
  private offset: Point = { x: 0, y: 0 };

  constructor(page: AgentPage, hid: SimHid, fns: IosDevice["fns"]) {
    super();
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
        if (e instanceof PointerEvent && e.type === "pointerdown") w.tapped = { x: e.clientX, y: e.clientY };
      };
      for (const type of ["pointerdown", "pointerup", "touchstart", "touchend", "mousedown", "mouseup", "click"]) addEventListener(type, w.calibrating, { capture: true });
    });
    const s = await this.page.evaluate(() => ({ w: screen.width, h: screen.height }));
    const at = { x: Math.round(s.w / 2), y: Math.round(s.h / 2) };
    await this.hid.touches([[0, "down", at.x, at.y], [50, "up", at.x, at.y]]);
    let tapped: Point | null = null;
    for (const end = Date.now() + 5000; !(tapped = await this.page.evaluate(() => (window as { tapped?: Point }).tapped ?? null)); await sleep(100)) {
      if (Date.now() > end) throw new Error("the iPhone's page never saw the calibrating tap");
    }
    await this.page.evaluate(() => {
      const w = window as { calibrating?: (e: Event) => void };
      for (const type of ["pointerdown", "pointerup", "touchstart", "touchend", "mousedown", "mouseup", "click"]) removeEventListener(type, w.calibrating!, { capture: true });
    });
    this.offset = { x: at.x - tapped.x, y: at.y - tapped.y };
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
      if (Date.now() > end) throw new Error(`${JSON.stringify(text)} typed into ${JSON.stringify(before)}, the editor holds ${JSON.stringify(now)}`);
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

  /** Until the page's size and the board's camera have not changed for 500 ms, as a person waits to aim. */
  override async still(what: string) {
    let last = "", since = Date.now();
    for (const end = Date.now() + 5000; ; await sleep(100)) {
      const now = JSON.stringify([await this.page.evaluate(() => [innerHeight, visualViewport!.height, visualViewport!.offsetTop]), (await this.scene()).camera]);
      if (now !== last) [last, since] = [now, Date.now()];
      if (Date.now() - since >= 500) return;
      if (Date.now() > end) throw new Error(`timed out after 5000 ms: ${what}`);
    }
  }

  /** As a person makes one on a phone: a double tap, a title, and a tap on the board just above it. */
  async addCard(x: number, y: number): Promise<string> {
    const had = new Set((await this.scene()).cards.map((c) => c.id));
    await this.doubleTap({ x, y });
    await this.type("card");
    const id = (await this.scene()).cards.find((c) => !had.has(c.id))?.id;
    if (!id) throw new Error("the double tap made no card");
    const c = item(await this.scene(), id);
    await this.tap({ x: c.x + c.w / 2, y: c.y - 40 });
    await this.page.waitForFunction(() => !(document.activeElement as HTMLElement | null)?.isContentEditable, undefined, { timeout: 5000 });
    await this.still("the keyboard to go and the board to stand still");
    return id;
  }

  /** As a person makes one on a phone: the board dragged to bring the point to the middle, then + and Lane. */
  async addLane(x: number, y: number): Promise<string> {
    const had = new Set((await this.scene()).lanes.map((l) => l.id));
    const size = await this.size(), from = await this.screen({ x, y }), mid = { x: size.w / 2, y: size.h / 2 };
    const moves: Frame[] = [];
    for (let i = 1; i <= 10; i++) moves.push([16, "move", [[0, { x: from.x + ((mid.x - from.x) * i) / 10, y: from.y + ((mid.y - from.y) * i) / 10 }]]]);
    // a drag that starts where the point is, on empty board, pans
    await this.gesture([[0, "down", [[0, from]]], ...moves, [300, "up", [[0, mid]]]]);
    await this.still("the pan to settle");
    for (const sel of [".add > button", '[data-act="new-lane"]']) {
      const r = await this.page.evaluate((s: string) => {
        const b = document.querySelector(s)?.getBoundingClientRect();
        return b && b.width ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
      }, sel);
      if (!r) throw new Error(`nothing shows ${sel}`);
      await this.gesture([[0, "down", [[0, r]]], [50, "up", [[0, r]]]]);
      await sleep(400);
    }
    for (const end = Date.now() + 5000; ; await sleep(100)) {
      const id = (await this.scene()).lanes.find((l) => !had.has(l.id))?.id;
      if (id) return id;
      if (Date.now() > end) throw new Error("+ and Lane made no lane");
    }
  }

  stop() {
    this.hid.stop();
  }
}
