// The web app built as it ships, in headless Chromium, WebKit and Firefox and in Chrome and Firefox on Android, against
// sync.php and the relay under wrangler dev, on the wall clock: the same scenarios as on the hub, through the browsers'
// own input and the DOM.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { connect, type Socket } from "node:net";
import { extname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { _android, chromium, firefox, webkit, type AndroidDevice, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import { inviteLink } from "../web/sync/crypto.ts";
import { Device, type Box, type Editor, type Frame, type PointerExtra, type PointerPhase, type Scene, type SceneItem } from "./device.ts";
import { MacDevice } from "./mac.ts";
import type { Point } from "../web/types.ts";

export * from "./device.ts";

export type BrowserKind = "chromium" | "webkit" | "firefox" | "android" | "firefox-android";
export type RealKind = BrowserKind | "mac";

const root = new URL("..", import.meta.url).pathname;
// inside Android's ephemeral port range: scripts/android.ts reserves them on the emulator as it boots
export const WEB = 58565, SERVER = 58566, RELAY = 58568;
/** The emulator's adbd over TCP, through its port redirect: its own adb pipe drops every connection on it under load, a
 * few times an hour on some runners, and the page with them. scripts/android.ts connects it. */
export const EMULATOR_TCP = "127.0.0.1:5600";
/** Firefox for Android's package, and the port of its WebDriver BiDi on the emulator and on this machine: below both
 * systems' ephemeral ports. */
export const FENIX = "org.mozilla.firefox", FENIX_BIDI = 29222;
/** The Firefox for Android scripts/android.ts installs. */
export const FENIX_VERSION = "157.0.1";
/** The web app's version, so that its service worker runs as on breezy.k5d.de. */
const VERSION = "scenarios";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, test: () => Promise<T | false | null | undefined> | T | false | null | undefined, ms = 20_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const v = await test();
    if (v) return v;
  }
  throw new Error(`timed out: ${what}`);
}

/** What the page draws, read off the DOM as `sceneOf` would say it: runs in the page. */
function readScene(): Scene {
  const num = (s: string) => Number.parseFloat(s) || 0;
  const translate = (t: string) => {
    const m = t.match(/translate\((-?[\d.e+-]+)px, (-?[\d.e+-]+)px\)(?: scale\(([\d.]+)\))?/);
    return m ? { x: Number(m[1]), y: Number(m[2]), scale: m[3] ? Number(m[3]) : 1 } : { x: 0, y: 0, scale: 1 };
  };
  const world = translate((document.querySelector<HTMLElement>(".world")!).style.transform);
  const item = (el: HTMLElement): SceneItem => {
    const t = translate(el.style.transform);
    return { id: el.dataset.id!, x: t.x, y: t.y, w: num(el.style.width), h: num(el.style.height), selected: el.classList.contains("selected"), held: el.classList.contains("held") };
  };
  const cards = [...document.querySelectorAll<HTMLElement>(".cards > [data-id]")].map((el) => ({
    ...item(el),
    raised: el.classList.contains("lifted"),
    color: Number(el.querySelector(".sheet")!.className.match(/\bc(\d)\b/)?.[1]),
    text: el.querySelector(".front")!.textContent ?? "",
  }));
  const lanes = [...document.querySelectorAll<HTMLElement>(".lanes > [data-id]")].map((el) => ({ ...item(el), title: el.querySelector(".title")!.textContent ?? "" }));
  const m = document.querySelector<HTMLElement>(".marquee")!;
  const mt = translate(m.style.transform);
  return {
    cards,
    lanes,
    turned: document.querySelector<HTMLElement>(".cards > .turned")?.dataset.id ?? null,
    marquee: m.hidden ? null : { x: mt.x, y: mt.y, w: num(m.style.width), h: num(m.style.height) },
    camera: { x: world.x, y: world.y, zoom: world.scale },
  };
}

/**
 * What the editor with the keyboard draws, read off the DOM: its text and caret as `DomField` counts them, a <br> as the
 * newline it draws. Runs in the page.
 */
function readEditor(): Editor | null {
  const el = document.activeElement as HTMLElement | null;
  if (!el?.isContentEditable) return null;
  const box = (r: DOMRect | undefined) => r && { x: r.x, y: r.y, w: r.width, h: r.height };
  const chars: (Box | null)[] = [], weights: number[] = [];
  let all = "";
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n.nodeName === "BR") {
      all += "\n";
      chars.push(null);
      weights.push(Number.parseFloat(getComputedStyle(n.parentElement!).fontWeight));
    }
    if (!(n instanceof Text)) continue;
    const weight = Number.parseFloat(getComputedStyle(n.parentElement!).fontWeight);
    for (let i = 0; i < n.length; i++) {
      const c = n.data[i]!;
      if (c === "\u200b") continue;
      all += c;
      weights.push(weight);
      if (c === "\n") {
        chars.push(null);
        continue;
      }
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + 1);
      chars.push(box(r.getClientRects()[0])!);
    }
  }
  const sel = getSelection()!;
  let at = 0, anchor = 0, caret: Box | null = null;
  if (sel.rangeCount && el.contains(sel.focusNode)) {
    const plain = (n: Node): string => n instanceof Text ? n.data : n.nodeName === "BR" ? "\n" : [...n.childNodes].map(plain).join("");
    const upto = (node: Node, offset: number) => {
      const q = document.createRange();
      q.selectNodeContents(el);
      q.setEnd(node, offset);
      return plain(q.cloneContents()).replace(/\u200b/g, "").length;
    };
    anchor = upto(sel.anchorNode!, sel.anchorOffset);
    const r = document.createRange();
    r.selectNodeContents(el);
    r.setEnd(sel.focusNode!, sel.focusOffset);
    const before = plain(r.cloneContents()).replace(/\u200b/g, "");
    at = before.length;
    r.collapse(false);
    const [f, off] = [sel.focusNode!, sel.focusOffset];
    // Where the browser draws the caret. After a newline Firefox's range is at the end of the line above, where it draws
    // the caret only at the end of a text node (f0b3b89), else at the start of the line below. On an empty line or in an
    // empty element Chromium's range has no rect. A mark put at the caret for a moment says where the line below starts.
    const below = navigator.userAgent.includes("Firefox") && before.endsWith("\n") && !(f instanceof Text && off === f.length);
    let rect = below ? undefined : r.getClientRects()[0];
    if (!rect?.height) {
      const saved = [sel.anchorNode!, sel.anchorOffset, f, off] as const;
      const mark = document.createElement("span");
      mark.textContent = "\u200b";
      if (f instanceof Text) {
        const tail = f.splitText(off);
        f.after(mark);
        rect = mark.getBoundingClientRect();
        mark.remove();
        f.appendData(tail.data);
        tail.remove();
      } else {
        f.insertBefore(mark, f.childNodes[off] ?? null);
        rect = mark.getBoundingClientRect();
        mark.remove();
      }
      sel.setBaseAndExtent(...saved);
    }
    caret = rect ? { x: rect.x, y: rect.y, w: 0, h: rect.height } : null;
  }
  const s = getComputedStyle(el), r = el.getBoundingClientRect();
  const zoom = r.width / el.offsetWidth;
  const v = visualViewport!;
  return {
    // an empty last line is drawn from two newlines, as DomField.text() says
    text: all.endsWith("\n") ? all.slice(0, -1) : all,
    at,
    selected: [Math.min(at, anchor), Math.max(at, anchor)],
    caret,
    chars,
    weights,
    origin: { x: r.x + Number.parseFloat(s.paddingLeft) * zoom, y: r.y + Number.parseFloat(s.paddingTop) * zoom },
    line: Number.parseFloat(s.lineHeight) * zoom,
    view: { x: v.offsetLeft, y: v.offsetTop, w: v.width, h: v.height },
  };
}

/** The weight of each character of card `id`'s front as drawn, but its newlines; null once it is gone. Runs in the page. */
function readWeights(id: string): number[] | null {
  const front = document.querySelector(`.cards > [data-id="${id}"] .front`);
  if (!front) return null;
  const weights: number[] = [];
  const walk = document.createTreeWalker(front, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
    const w = Number.parseFloat(getComputedStyle(n.parentElement!).fontWeight);
    for (const c of n.data) if (c !== "\u200b" && c !== "\n") weights.push(w);
  }
  return weights;
}

/** What a device did with the server and the relay, ms from the world's start: for a failing case to tell where a
 * change stopped. Ids are the records' and the relay's first 8 characters. */
export type SyncLog = [ms: number, what: string][];

/** Notes in `log` each request to sync.php and its answer, each file the page loads, its navigations, each frame on the
 * relay, and the page's errors. */
function logSync(page: Page, log: SyncLog, t0: number) {
  const note = (what: string) => log.push([Math.round(performance.now() - t0), what]);
  const id = (r: { id: string }) => r.id.slice(0, 8);
  const ours = (url: string) => url.includes(`:${SERVER}/`);
  const site = (url: string) => url.includes(`:${WEB}/`);
  page.on("framenavigated", (f) => f === page.mainFrame() && note(`navigates to ${f.url().slice(0, 40)}`));
  page.on("domcontentloaded", () => note("DOM content loaded"));
  page.on("load", () => note("loaded"));
  page.on("requestfinished", async (r) => {
    if (!site(r.url())) return;
    const res = await r.response().catch(() => null);
    note(`  got ${new URL(r.url()).pathname} ${res?.status()}${res?.fromServiceWorker() ? " from the service worker" : ""}`);
  });
  page.on("request", (r) => {
    if (site(r.url())) return note(`get ${new URL(r.url()).pathname}`);
    if (!ours(r.url())) return;
    const body = r.postDataBuffer();
    if (!body) return note(`pull since ${new URL(r.url()).searchParams.get("since")}`);
    try {
      const { writes, since, epoch } = JSON.parse((r.headers()["content-encoding"] === "deflate" ? inflateRawSync(body) : body).toString());
      note(`push since ${since} epoch ${epoch} writes ${writes.map((w: { id: string; base: number }) => `${id(w)}@${w.base}`).join(" ")}`);
    } catch (e) {
      note(`push, its body unread: ${e}`);
    }
  });
  page.on("response", async (res) => {
    if (!ours(res.url())) return;
    const at = Math.round(performance.now() - t0);
    const list = (rs?: { id: string; version: number }[]) => (rs ?? []).map((r) => `${id(r)}@${r.version}`).join(" ");
    try {
      const j = await res.json();
      log.push([at, `  ${res.status()} accepted ${list(j.accepted)} refused ${list(j.refused)} records ${list(j.records)} cursor ${j.cursor} epoch ${j.epoch}`]);
    } catch (e) {
      log.push([at, `  ${res.status()}, its body unread: ${e}`]);
    }
  });
  page.on("requestfailed", (r) => (ours(r.url()) || site(r.url())) && note(`  failed ${new URL(r.url()).pathname}: ${r.failure()?.errorText}`));
  page.on("websocket", (ws) => {
    note(`relay opens ${ws.url()}`);
    ws.on("close", () => note("relay closes"));
    const frame = (dir: string) => ({ payload }: { payload: string | Buffer }) => {
      if (typeof payload !== "string") return note(`relay ${dir} ${payload.length} bytes`);
      let t = "";
      try {
        t = JSON.parse(payload).t ?? "";
      } catch {}
      note(`relay ${dir} ${t} ${payload.length} chars`);
    };
    ws.on("framesent", frame("sends"));
    ws.on("framereceived", frame("gets"));
  });
  page.on("pageerror", (e) => note(`page error: ${e.message}`));
  page.on("console", (m) => ["error", "warning"].includes(m.type()) && note(`console ${m.type()}: ${m.text()}`));
}

/**
 * The emulator's console, kept open: a touch through it arrives a millisecond after it is sent, where `adb emu` starts a
 * process for each and took longer than a hold on a busy runner, so a tap held and a pan dragged.
 */
export class EmulatorConsole {
  private readonly socket: Socket;
  private buffer = "";
  /** Each command's answer, in order: OK, or KO and why. */
  private readonly answers: ((line: string) => void)[] = [];

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (data: string) => {
      this.buffer += data;
      let i;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, i).trim();
        this.buffer = this.buffer.slice(i + 1);
        if (line === "OK" || line.startsWith("KO")) this.answers.shift()?.(line);
      }
    });
  }

  /** The console of emulator `serial`, as adb names it, signed in with the token the emulator keeps in the home folder. */
  static async open(serial: string): Promise<EmulatorConsole> {
    const socket = connect(Number(serial.split("-")[1]), "127.0.0.1");
    await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject));
    const c = new EmulatorConsole(socket);
    // the banner ends in an OK of its own
    await new Promise((resolve) => c.answers.push(resolve));
    await c.command(`auth ${readFileSync(join(homedir(), ".emulator_console_auth_token"), "utf8").trim()}`);
    return c;
  }

  async command(line: string) {
    const answer = new Promise<string>((resolve) => this.answers.push(resolve));
    this.socket.write(`${line}\r\n`);
    const a = await answer;
    if (a !== "OK") throw new Error(`the emulator's console answered ${line.split(" ")[0]} with ${a}`);
  }

  close() {
    this.socket.destroy();
  }
}

/** The emulator's touchscreen, driven through its console: touches pass through Android's input as a finger's do. */
export class Touchscreen {
  private readonly ids = new Map<number, number>();
  private next = 1;
  /** The device's adb serial, for shell commands. */
  private readonly serial: string;
  private readonly console: EmulatorConsole;
  /** The screen's size in pixels. */
  private readonly px: Point;
  /** Pixels a page point. */
  private readonly dpr: number;
  /** Where the page starts, in points below the screen's top. */
  private top = 0;
  /** Each frame sent, on this machine's clock: when it was sent, when the console answered, and its fingers. */
  readonly sent: { at: number; ok: number; what: string }[] = [];

  constructor(serial: string, console: EmulatorConsole, px: Point, dpr: number) {
    this.serial = serial;
    this.console = console;
    this.px = px;
    this.dpr = dpr;
  }

  static async of(serial: string, console: EmulatorConsole, page: Page): Promise<Touchscreen> {
    const size = execFileSync("adb", ["-s", serial, "shell", "wm", "size"], { encoding: "utf8" }).match(/(\d+)x(\d+)\s*$/)!;
    const t = new Touchscreen(serial, console, { x: Number(size[1]), y: Number(size[2]) }, await page.evaluate(() => devicePixelRatio));
    // where the page starts below the status bar and Chrome's toolbar: a tap the page keeps from itself, on a page at
    // the app's scale; the taps before it dismiss what Chrome shows over the page
    await page.setContent('<meta name="viewport" content="width=device-width">');
    await page.evaluate(() => {
      for (const type of ["pointerdown", "pointerup", "touchstart", "touchend", "mousedown", "mouseup", "click"]) {
        addEventListener(type, (e) => {
          e.stopImmediatePropagation();
          if (e instanceof PointerEvent && type === "pointerdown") (window as { tapped?: number }).tapped = e.clientY;
        }, { capture: true });
      }
    });
    const middle = { x: t.px.x / 2 / t.dpr, y: t.px.y / 2 / t.dpr };
    for (let i = 0; i < 5; i++) {
      await t.send([[0, "down", middle]]);
      await t.send([[0, "up", middle]]);
      await sleep(1000);
      const y = await page.evaluate(() => (window as { tapped?: number }).tapped);
      if (y !== undefined) {
        t.top = middle.y - y;
        // on a page of its own
        t.sent.length = 0;
        return t;
      }
    }
    throw new Error(`the page sees no touches: something of Chrome's covers it; ${t.texts()}`);
  }

  /** The screen as a PNG. */
  capture() {
    return execFileSync("adb", ["-s", this.serial, "exec-out", "screencap", "-p"], { timeout: 10_000 });
  }

  /** The emulator's log since `ms`, on Date.now(). */
  logcat(ms: number) {
    return execFileSync("adb", ["-s", this.serial, "logcat", "-d", "-t", (ms / 1000).toFixed(3)], { timeout: 10_000, maxBuffer: 256 * 1024 * 1024 });
  }

  /** The texts on screen, and the screen in build/android-touches.png, for a person to tell what covers the page. */
  texts() {
    try {
      writeFileSync(join(root, "build", "android-touches.png"), this.capture());
      const ui = execFileSync("adb", ["-s", this.serial, "shell", "uiautomator dump /sdcard/ui.xml >/dev/null && cat /sdcard/ui.xml"], { encoding: "utf8" });
      return `the screen shows ${[...ui.matchAll(/text="([^"]+)"/g)].map((m) => m[1]).join(" | ")}`;
    } catch (e) {
      return `nothing uiautomator could read: ${e}`;
    }
  }

  /** Fingers changing in one frame of the touchscreen, at page points. */
  async send(fingers: [number, PointerPhase, Point][]) {
    const axis = (v: number, of: number) => Math.round((v * this.dpr * 32767) / of);
    const events: string[] = [];
    for (const [finger, phase, p] of fingers) {
      events.push(`EV_ABS:ABS_MT_SLOT:${finger}`);
      if (phase === "down") {
        this.ids.set(finger, this.next++);
        events.push(`EV_ABS:ABS_MT_TRACKING_ID:${this.ids.get(finger)}`);
      }
      if (phase === "down" || phase === "move") {
        events.push(`EV_ABS:ABS_MT_POSITION_X:${axis(p.x, this.px.x)}`, `EV_ABS:ABS_MT_POSITION_Y:${axis(p.y + this.top, this.px.y)}`);
      }
      if (phase === "down") events.push("EV_ABS:ABS_MT_PRESSURE:1024", "EV_ABS:ABS_MT_TOUCH_MAJOR:1280", "EV_ABS:ABS_MT_TOUCH_MINOR:1280");
      // a touchscreen cannot cancel: the finger lifts
      if (phase === "up" || phase === "cancel") {
        this.ids.delete(finger);
        events.push("EV_ABS:ABS_MT_PRESSURE:0", "EV_ABS:ABS_MT_TRACKING_ID:-1");
      }
    }
    const at = Date.now();
    await this.console.command(`event send ${[...events, "EV_SYN:0:0"].join(" ")}`);
    this.sent.push({ at, ok: Date.now(), what: fingers.map(([finger, phase, p]) => `${phase}${finger} ${Math.round(p.x)},${Math.round(p.y)}`).join(" ") });
  }
}

type Touches = [string, number, number, number, number][];

/** Whether an editor has the keyboard. Runs in the page. */
function editing() {
  const e = document.activeElement;
  return e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement || (e as HTMLElement | null)?.isContentEditable === true;
}

/** Keeps each touch's pointer event, key and focus change in `touches` as it reaches the page: type, point, and its time
 * and the time handled on the page's wall clock. Runs in the page. */
function logTouches() {
  const touches: Touches = [];
  (window as { touches?: typeof touches }).touches = touches;
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
    addEventListener(type, (e) => {
      const p = e as PointerEvent;
      if (p.pointerType === "mouse" && (type === "pointerdown" || type === "pointerup")) {
        const t = p.target as HTMLElement;
        const on = `${t.tagName?.toLowerCase()}.${t.className}${t.isContentEditable ? " editable" : ""}`;
        return touches.push([`mouse ${type.slice(7)} on ${on}`, Math.round(p.clientX), Math.round(p.clientY), performance.timeOrigin + p.timeStamp, performance.timeOrigin + performance.now()]);
      }
      if (p.pointerType !== "touch") return;
      touches.push([type.slice(7), Math.round(p.clientX), Math.round(p.clientY), performance.timeOrigin + p.timeStamp, performance.timeOrigin + performance.now()]);
    }, { capture: true });
  }
  // the page's size, which the keyboard changes
  const size = () => touches.push([`resize ${innerHeight} ${Math.round(visualViewport!.height)}`, 0, 0, performance.timeOrigin + performance.now(), performance.timeOrigin + performance.now()]);
  addEventListener("resize", size);
  visualViewport!.addEventListener("resize", size);
  // what had the keyboard, for a touch an editor kept from the board
  for (const type of ["keydown", "focusin", "focusout"]) {
    addEventListener(type, (e) => {
      const what = e instanceof KeyboardEvent ? e.key : `${(e.target as Element).tagName?.toLowerCase()}.${(e.target as Element).className}`;
      touches.push([`${type} ${what}`, 0, 0, performance.timeOrigin + e.timeStamp, performance.timeOrigin + performance.now()]);
    }, { capture: true });
  }
}


/**
 * Frames of finger pointer events, each after its wait in ms, as iOS Safari sends them: one at a time, each at the
 * element under its point, all with the frame's time. Timed in the page, as a round trip to it per frame can take longer
 * than a hold on a busy runner. Each frame's time is when it was due, as a touchscreen stamps a touch when the finger
 * moved: a page busy past a frame gets it late but knows when it was, where a time stamped late made a pan a hold.
 * Runs in the page.
 */
async function touchFrames(frames: [number, [string, number, number, number][]][]) {
  let due = performance.now();
  for (const [ms, events] of frames) {
    due += ms;
    const wait = due - performance.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const timeStamp = due;
    for (const [type, x, y, finger] of events) {
      const target = (type === "pointerdown" && document.elementFromPoint(x, y)) || document.body;
      const e = new PointerEvent(type, { pointerId: 10 + finger, pointerType: "touch", isPrimary: finger === 0, clientX: x, clientY: y, bubbles: true, cancelable: true, buttons: type === "pointerup" ? 0 : 1 });
      Object.defineProperty(e, "timeStamp", { value: timeStamp });
      target.dispatchEvent(e);
    }
  }
}

const TOUCH_TYPES = { down: "pointerdown", move: "pointermove", up: "pointerup", cancel: "pointercancel" };

export class BrowserDevice extends Device {
  readonly kind: BrowserKind;
  readonly page: Page;
  /** Chromium's DevTools session, which sends real touches; WebKit's and Firefox's touches are dispatched pointer events. */
  private cdp: CDPSession | null = null;
  /** The fingers down, by id, as a touch event lists them all. */
  private down = new Map<number, Point>();

  /** An emulator's, which touches go through in place of DevTools. */
  private readonly touchscreen?: Touchscreen;
  /** The pointer events of the pages before this one, which launching again cleared. */
  private seenBefore: Touches = [];

  readonly log: SyncLog = [];
  private readonly t0: number;

  constructor(kind: BrowserKind, page: Page, touchscreen?: Touchscreen, t0 = performance.now()) {
    super();
    this.kind = kind;
    this.page = page;
    this.touchscreen = touchscreen;
    this.t0 = t0;
    logSync(page, this.log, t0);
  }

  private note(what: string) {
    this.log.push([Math.round(performance.now() - this.t0), what]);
  }

  override async size() {
    return this.page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  }

  /** The emulator's screen as a PNG, if this is one. */
  capture() {
    return this.touchscreen?.capture();
  }

  logcat(ms: number) {
    return this.touchscreen?.logcat(ms);
  }

  /** Whether its touches go through an emulator's touchscreen. */
  get phone() {
    return !!this.touchscreen;
  }

  /**
   * The touches sent to the emulator and the page's pointer events, keys and focus, in order on this machine's clock, ms from the first;
   * the page's clock set to this one's by a round trip. A pointer event's own time is when Android read the touch.
   */
  async touches(): Promise<string | null> {
    if (!this.touchscreen) {
      // dispatched in the page or sent through DevTools: what the page saw, and how late it handled each
      const seen = [...this.seenBefore, ...await this.page.evaluate(() => (window as { touches?: Touches }).touches ?? [])];
      const start = seen[0]?.[3] ?? 0;
      return [`${seen.length} seen`, ...seen.map(([type, x, y, t, handled]) => `${`${Math.round(t - start)}`.padStart(6)}   page ${type} ${x},${y}${handled - t > 20 ? ` (handled ${Math.round(handled - t)} ms later)` : ""}`)].join("\n");
    }
    const t0 = Date.now();
    const [now, seenNow] = await this.page.evaluate(() => [performance.timeOrigin + performance.now(), (window as { touches?: Touches }).touches ?? []] as const);
    const seen = [...this.seenBefore, ...seenNow];
    const skew = now - (t0 + Date.now()) / 2;
    const sent = this.touchscreen.sent;
    const start = Math.min(sent[0]?.at ?? Infinity, (seen[0]?.[3] ?? Infinity) - skew);
    const ms = (t: number) => `${Math.round(t - start)}`.padStart(6);
    const lines: [number, string][] = [
      ...sent.map(({ at, ok, what }): [number, string] => [at, `${ms(at)} sent ${what}${ok - at > 20 ? ` (console answered in ${ok - at} ms)` : ""}`]),
      ...seen.map(([type, x, y, t, handled]): [number, string] => [t - skew, `${ms(t - skew)}   page ${type} ${x},${y}${handled - t > 20 ? ` (handled ${Math.round(handled - t)} ms later)` : ""}`]),
    ];
    // where its touches stopped being read in step with them: a down or up read later than sent
    const downs = sent.filter((s) => /down|up/.test(s.what)), heard = seen.filter(([type]) => type === "down" || type === "up");
    const lags = downs.map((s, i) => heard[i] ? Math.round(heard[i][3] - skew - s.at) : NaN);
    return [`clock skew ${Math.round(skew)} ms; ${sent.length} sent, ${seen.length} seen; down/up lags ${lags.join(" ")}`, ...lines.sort((a, b) => a[0] - b[0]).map(([, l]) => l)].join("\n");
  }

  /** The touches the page has seen lift since it loaded. */
  private lifts() {
    return this.page.evaluate(() => ((window as { touches?: Touches }).touches ?? []).filter(([type]) => type === "up" || type === "cancel").length);
  }

  /** Until the page has seen `n` touches lift: one that something of Android's or Chrome's took instead fails here, not
   * as whatever the case looks at next. */
  private async lifted(n: number, at: Point[]) {
    for (const end = Date.now() + 3000; (await this.lifts()) < n; await sleep(20)) {
      if (Date.now() > end) throw new Error(`the page did not see a finger lift at ${at.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(" ")} in 3 s; ${this.touchscreen!.texts()}`);
    }
  }

  /**
   * A gesture's frames with their waits and nothing between: on the emulator, its lifts looked for once it ends, not
   * with a round trip to the page between frames; in WebKit and Firefox, timed in the page.
   */
  override async gesture(frames: Frame[]) {
    if (this.touchscreen) {
      const before = await this.lifts();
      // the page's points, where Chrome has panned it under the screen as the keyboard came over an editor
      const pan = await this.page.evaluate(() => ({ x: visualViewport!.offsetLeft, y: visualViewport!.offsetTop }));
      const lifting: Point[] = [];
      for (const [ms, phase, moves] of frames) {
        if (ms) await this.wait(ms);
        await this.touchscreen.send(moves.map(([finger, p]) => [finger, phase, { x: p.x - pan.x, y: p.y - pan.y }]));
        if (phase === "up" || phase === "cancel") lifting.push(...moves.map(([, p]) => p));
      }
      if (lifting.length) await this.lifted(before + lifting.length, lifting);
      return;
    }
    if (this.devtools) return super.gesture(frames);
    await this.page.evaluate(touchFrames, frames.map(([ms, phase, moves]): [number, [string, number, number, number][]] => [ms, moves.map(([finger, p]) => [TOUCH_TYPES[phase], p.x, p.y, finger])]));
  }


  override async fingers(phase: PointerPhase, moves: [number, Point][]) {
    if (this.touchscreen) return this.gesture([[0, phase, moves]]);
    if (!this.devtools) return this.gesture([[0, phase, moves]]);
    if (phase !== "move") return super.fingers(phase, moves);
    for (const [finger, p] of moves) this.down.set(finger, p);
    await this.touch(phase, moves[0]![1], moves[0]![0]);
  }

  private async touch(phase: PointerPhase, p: Point, finger: number) {
    this.cdp ??= await this.page.context().newCDPSession(this.page);
    if (phase === "down" || phase === "move") this.down.set(finger, p);
    else this.down.delete(finger);
    const type = ({ down: "touchStart", move: "touchMove", up: "touchEnd", cancel: "touchCancel" } as const)[phase];
    const touchPoints = [...this.down].map(([id, q]) => ({ x: q.x, y: q.y, id }));
    await this.cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
  }

  private get devtools() {
    return this.kind === "chromium" || this.kind === "android";
  }

  async scene(): Promise<Scene> {
    return this.page.evaluate(readScene);
  }

  override get draws() {
    return true;
  }

  override async busyAfterPress(ms: number) {
    await this.page.evaluate((ms) => addEventListener("pointerdown", () => setTimeout(() => {
      for (const end = performance.now() + ms; performance.now() < end;);
    }), { once: true, capture: true }), ms);
  }

  override async editor() {
    return this.page.evaluate(readEditor);
  }

  override async weights(id: string) {
    return this.page.evaluate(readWeights, id);
  }

  /** Once its service worker keeps this version, as on a phone that launched it before. */
  override async offline(off: boolean) {
    if (off) await until("the service worker's snapshot", () => this.page.evaluate((version) => navigator.serviceWorker.ready.then((reg) => new Promise<boolean>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (e) => resolve(e.data.current === version);
      reg.active!.postMessage({ type: "check" }, [channel.port2]);
    })), VERSION));
    await this.page.context().setOffline(off);
    this.note(off ? "offline" : "online");
  }

  override async unpushed() {
    return this.page.evaluate(() => Number(document.body.dataset.waiting ?? 0));
  }

  override async syncStatus() {
    return this.page.evaluate(() => document.querySelector(".menu.more .status")?.textContent ?? "");
  }

  /** Once the board shows the cards and lanes it showed before, which it reads from storage after it opens. */
  override async relaunch() {
    const ids = (s: Scene) => [...s.cards, ...s.lanes].map((i) => i.id).sort().join(" ");
    const had = ids(await this.scene());
    this.seenBefore.push(...await this.page.evaluate(() => (window as { touches?: Touches }).touches ?? []));
    this.note("launches again");
    await this.page.goto(`http://localhost:${WEB}/`);
    await openBoard(this.page);
    await until(`${this.kind} to show its board again`, async () => ids(await this.scene()) === had);
  }

  async wait(ms: number) {
    await sleep(ms);
  }

  async pointer(phase: PointerPhase, p: Point, extra: PointerExtra = {}) {
    if (extra.kind === "touch" && this.touchscreen) return this.gesture([[0, phase, [[extra.finger ?? 0, p]]]]);
    if (extra.kind === "touch" && this.devtools) return this.touch(phase, p, extra.finger ?? 0);
    if (extra.kind === "touch") return this.fingers(phase, [[extra.finger ?? 0, p]]);
    const keys = [extra.shift && "Shift", extra.option && "Alt"].filter((k): k is string => !!k);
    const m = this.page.mouse;
    if (phase === "down") {
      for (const k of keys) await this.page.keyboard.down(k);
      await m.move(p.x, p.y);
      await m.down({ clickCount: extra.clicks ?? 1 });
    } else if (phase === "move") {
      await m.move(p.x, p.y);
    } else {
      await m.move(p.x, p.y);
      await m.up();
      for (const k of keys) await this.page.keyboard.up(k);
    }
  }

  private async made(before: Scene, kind: "cards" | "lanes") {
    const had = new Set(before[kind].map((x) => x.id));
    return until(`a new item in ${kind}`, async () => (await this.scene())[kind].find((x) => !had.has(x.id))?.id);
  }

  async key(key: string, mods: { meta?: boolean; shift?: boolean } = {}) {
    await this.page.keyboard.press(`${mods.meta ? "Meta+" : ""}${mods.shift ? "Shift+" : ""}${key}`);
  }

  override get edits() {
    return true;
  }

  /** Once an editor has the keyboard: one a double tap opened shows a moment later on a busy phone. */
  override async type(text: string) {
    await this.page.waitForFunction(editing, undefined, { timeout: 5000 });
    // a front may end in a newline that draws nothing, and DomField.text() drops, as after ⌫ on a phone
    const held = () => this.page.evaluate(() => {
      const e = document.activeElement;
      return (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement ? e.value : e?.textContent ?? "").replace(/\u200b/g, "").replace(/\n$/, "");
    });
    const before = this.touchscreen ? await held() : "";
    await this.page.keyboard.type(text);
    // a touchscreen's touches reach the page by another way than DevTools' keys, and could overtake them
    if (this.touchscreen) {
      await until(`${JSON.stringify(text)} typed`, async () => {
        const now = await held();
        return now.length >= before.length + text.length && now.includes(text);
      }, 5000).catch(async (e) => {
        // a keyboard's input method may put in other characters than the keys sent
        const now = await held();
        throw new Error(`${JSON.stringify(text)} typed into ${JSON.stringify(before)}, the editor holds ${[...now].map((c) => c.codePointAt(0)!.toString(16)).join(" ")}`, { cause: e });
      });
      // the board keeps the editor in sight of the keyboard, which opened with it
      await this.still("the keyboard to open and the board to stand still");
    }
  }

  /** The text being composed, which a commit puts in. */
  private composing = "";

  /** Through DevTools, as Chrome's own input method support has it. */
  override async compose(text: string | null) {
    if (!this.devtools) return super.compose(text);
    this.cdp ??= await this.page.context().newCDPSession(this.page);
    if (text === null) await this.cdp.send("Input.insertText", { text: this.composing });
    else await this.cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
    this.composing = text ?? "";
  }

  override async typeInto(id: string, text: string) {
    const r = (await this.scene()).cards.find((c) => c.id === id);
    if (!r) throw new Error(`nothing shows ${id}`);
    const p = await this.screen({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    await this.page.mouse.dblclick(p.x, p.y);
    await this.type(text);
    await this.endEdit();
  }

  /**
   * Esc, and until the editor has let go of the keyboard: a busy phone ends the edit a moment later. On a phone, until
   * its keyboard has gone too and the board stands still, as a person waits to see it: the board moves as the keyboard
   * goes, and a finger aimed before lands elsewhere.
   */
  private async endEdit() {
    await this.page.keyboard.press("Escape");
    await this.page.waitForFunction(() => !(document.activeElement as HTMLElement | null)?.isContentEditable, undefined, { timeout: 5000 });
    await this.still("the keyboard to go and the board to stand still");
  }

  /** On a phone, until the page's size and the board's camera have not changed for 500 ms. */
  override async still(what: string) {
    if (!this.touchscreen) return;
    let last = "", since = Date.now();
    await until(what, async () => {
      const now = JSON.stringify([await this.page.evaluate(() => [innerHeight, visualViewport!.height, visualViewport!.offsetTop]), (await this.scene()).camera]);
      if (now !== last) [last, since] = [now, Date.now()];
      return Date.now() - since >= 500;
    }, 5000);
  }

  /** As a person makes one: a double-click, a title, and Esc. */
  async addCard(x: number, y: number): Promise<string> {
    const before = await this.scene();
    const p = await this.screen({ x, y });
    await this.page.mouse.dblclick(p.x, p.y);
    await this.type("card");
    await this.endEdit();
    return this.made(before, "cards");
  }

  /** As a person makes one: L with the pointer there; it goes in the nearest space clear of the rest. */
  async addLane(x: number, y: number): Promise<string> {
    const before = await this.scene();
    const p = await this.screen({ x, y });
    await this.page.mouse.move(p.x, p.y);
    await this.page.keyboard.press("l");
    return this.made(before, "lanes");
  }
}

/** The web app as it ships, built into `dir`. */
export function buildSite(dir: string) {
  execFileSync(join(root, "scripts/build-site.sh"), [dir, VERSION], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
}

/** Serves `dir` on 127.0.0.1:`port`. */
export function serveStatic(dir: string, port: number) {
  const types: Record<string, string> = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };
  return createServer((req, res) => {
    const path = join(dir, new URL(req.url!, "http://x").pathname.replace(/\/$/, "/index.html"));
    if (!existsSync(path)) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream" }).end(readFileSync(path));
  }).listen(port, "127.0.0.1");
}

/**
 * Chrome on `device`. Its launch stalls now and then, never opening its DevTools socket, which Playwright waits for
 * without end; launching force-stops it first. Why it stalls is not known.
 */
export async function launchAndroidChrome(device: AndroidDevice, options: { hasTouch?: boolean } = {}): Promise<BrowserContext> {
  // a user build's Chrome reads the command line Playwright writes only as the debug app, which Firefox's launch takes
  execFileSync("adb", ["-s", device.serial(), "shell", "am", "set-debug-app", "--persistent", "com.android.chrome"]);
  const launch = () => Promise.race([device.launchBrowser({ reducedMotion: "reduce", ...options }), sleep(30_000).then(() => null)]);
  const again = () => {
    globalThis.console.log("Chrome did not open DevTools in 30 s: launching it again");
    return launch();
  };
  const context = await launch() ?? await again();
  if (!context) throw new Error("Chrome did not launch twice in 30 s");
  return context;
}

export class RealWorld {
  readonly devices: (BrowserDevice | MacDevice)[] = [];
  private readonly browsers: Browser[] = [];
  private readonly androids: [AndroidDevice, BrowserContext?][] = [];
  private readonly contexts: BrowserContext[] = [];
  private readonly children: ChildProcess[] = [];
  private readonly dirs: string[] = [];
  private readonly consoles: EmulatorConsole[] = [];
  private web?: ReturnType<typeof createServer>;
  /** When it started, on performance.now(): the devices' logs count from it. */
  private t0 = 0;
  /** When it started, on Date.now(): the emulator's log counts from it. */
  private started = 0;

  /** Browsers and Macs of `kinds`, in one space with one board that all of them show. Stop it even when this fails
   * or never ends. */
  async start(kinds: RealKind[]) {
    this.t0 = performance.now();
    this.started = Date.now();
    await this.serve();
    const space = randomBytes(16).toString("base64url"), secret = randomBytes(32).toString("base64url");
    const link = inviteLink({ server: `http://127.0.0.1:${SERVER}/sync.php`, space, secret, name: "Scenario" });
    for (const [i, kind] of kinds.entries()) {
      if (kind === "mac") {
        // below every system's ephemeral ports, which a process listening on a random port took once
        const mac = await MacDevice.start(18570 + i, `d${i}`);
        this.devices.push(mac);
        await mac.command({ cmd: "join", link });
        const board = i === 0
          ? await mac.command<string>({ cmd: "createBoard", title: "Board" })
          : await until("the board on the Mac", async () => (await mac.command<string[]>({ cmd: "boards" }))[0]);
        await mac.command({ cmd: "open", board });
        continue;
      }
      const [page, touchscreen] = kind === "android" ? await this.android() : kind === "firefox-android" ? await this.firefoxAndroid() : [await this.browser(kind)];
      const d = new BrowserDevice(kind, page, touchscreen, this.t0);
      this.devices.push(d);
      await joinSpace(page, link.slice(link.indexOf("#join=")), `d${i}`);
      if (i === 0) {
        await press(page, "section.boards-group:has(header .edit) button.new");
        await until("the board name prompt", () => page.evaluate(() => !document.querySelector<HTMLElement>("#sheet")!.hidden));
        await page.fill("#sheet input", "Board");
        await press(page, '#sheet [data-sheet="ok"]');
      }
      await openBoard(page);
    }
  }

  private async browser(kind: Exclude<BrowserKind, "android" | "firefox-android">) {
    const browser = await { chromium, webkit, firefox }[kind].launch();
    this.browsers.push(browser);
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, hasTouch: true, reducedMotion: "reduce" });
    await context.addInitScript(logTouches);
    return context.newPage();
  }

  /** Chrome on the phone or emulator adb sees, at its own size, reaching this Mac's servers at its own localhost. */
  private async android() {
    const devices = await _android.devices();
    // an emulator by TCP, its touchscreen through its console
    const device = devices.find((d) => d.serial() === EMULATOR_TCP) ?? devices[0];
    const emulator = devices.find((d) => d.serial().startsWith("emulator-"))?.serial();
    for (const d of devices) if (d !== device) await d.close();
    if (!device) throw new Error("no Android device: run node scripts/android.ts");
    // closed even when what follows fails, else its connection keeps the run from ending
    const opened: [AndroidDevice, BrowserContext?] = [device];
    this.androids.push(opened);
    for (const port of [WEB, SERVER, RELAY]) execFileSync("adb", ["-s", device.serial(), "reverse", `tcp:${port}`, `tcp:${port}`]);
    const context = opened[1] = await launchAndroidChrome(device);
    // the only tab, so the one on screen: a first launch also restores the tab Chrome's first run left
    await context.addInitScript(logTouches);
    const page = await context.newPage();
    for (const p of context.pages()) if (p !== page) await p.close();
    await page.bringToFront();
    // Chrome keeps its profile from run to run
    const cdp = await context.newCDPSession(page);
    await cdp.send("Storage.clearDataForOrigin", { origin: `http://localhost:${WEB}`, storageTypes: "all" });
    await cdp.detach();
    // an emulator's touchscreen; a phone's touches go through DevTools
    const console = emulator ? await EmulatorConsole.open(emulator) : undefined;
    if (console) this.consoles.push(console);
    const touchscreen = console ? await Touchscreen.of(device.serial(), console, page) : undefined;
    return [page, touchscreen] as const;
  }

  /**
   * Firefox on the emulator, through fenix.ts: in the one profile it keeps, the site's data of the runs before cleared;
   * its touchscreen through the emulator's console.
   */
  private async firefoxAndroid() {
    const serial = execFileSync("adb", ["devices"], { encoding: "utf8" }).match(/^(emulator-\d+)\tdevice$/m)?.[1];
    if (!serial) throw new Error("no Android emulator: run node scripts/android.ts");
    for (const port of [WEB, SERVER, RELAY]) execFileSync("adb", ["-s", EMULATOR_TCP, "reverse", `tcp:${port}`, `tcp:${port}`]);
    const dir = mkdtempSync(join(tmpdir(), "breezy-scenario-fenix-"));
    this.dirs.push(dir);
    const context = await firefox.launchPersistentContext(dir, { channel: "moz-firefox", executablePath: join(root, "scenarios", "fenix.ts"), viewport: null, timeout: 60_000 });
    this.contexts.push(context);
    // the tab Firefox opened with, which is the one on screen
    const page = context.pages()[0] ?? await context.newPage();
    // a page the server does not have, once the service worker that would serve the app there is gone
    const blank = `http://localhost:${WEB}/scenarios-clear`;
    await page.goto(blank);
    await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.unregister()))));
    await page.goto(blank);
    const left = await page.evaluate(async () => {
      for (const name of await caches.keys()) await caches.delete(name);
      for (const { name } of await indexedDB.databases()) {
        await new Promise((resolve, reject) => Object.assign(indexedDB.deleteDatabase(name!), { onsuccess: resolve, onerror: reject, onblocked: reject }));
      }
      localStorage.clear();
      return [...await navigator.serviceWorker.getRegistrations(), ...await caches.keys(), ...await indexedDB.databases()].length;
    });
    if (left) throw new Error(`Firefox kept ${left} of the site's service workers, caches and databases`);
    await context.addInitScript(logTouches);
    const console = await EmulatorConsole.open(serial);
    this.consoles.push(console);
    return [page, await Touchscreen.of(EMULATOR_TCP, console, page)] as const;
  }

  private async serve() {
    const site = join(root, "build", "web-scenarios");
    buildSite(site);
    this.web = serveStatic(site, WEB);
    const relayState = mkdtempSync(join(tmpdir(), "breezy-scenario-relay-"));
    this.dirs.push(relayState);
    const group = (cmd: string, args: string[], cwd?: string) => this.children.push(spawn(cmd, args, { cwd, stdio: "ignore", detached: true }));
    group("npx", ["--prefix", join(root, "relay"), "wrangler", "dev", "--port", String(RELAY), "--persist-to", relayState], join(root, "relay"));
    group(join(root, "server/dev.sh"), []);
    await until("the relay", () => fetch(`http://127.0.0.1:${RELAY}/`).then(() => true, () => false), 60_000);
    await until("the server", () => fetch(`http://127.0.0.1:${SERVER}/sync.php`).then(() => true, () => false));
  }

  /**
   * Until every device shows the same board with nothing waiting to be pushed but a gesture's, and nothing has changed for
   * 500 ms. What a device holds floats where only it draws it, and a card's size is its own font's.
   */
  async settle(ms = 15_000) {
    let last = "", since = Date.now(), boards: string[] = [], waiting: number[] = [];
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
      const scenes = await Promise.all(this.devices.map((d) => d.scene()));
      const held = new Set(scenes.flatMap((s) => [...s.cards, ...s.lanes].filter((i) => i.held).map((i) => i.id)));
      const at = (i: SceneItem) => held.has(i.id) ? {} : { x: Math.round(i.x), y: Math.round(i.y) };
      const byId = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : 1;
      boards = scenes.map((s) => JSON.stringify([
        s.cards.map((c) => ({ id: c.id, ...at(c), color: c.color, text: c.text })).sort(byId),
        s.lanes.map((l) => ({ id: l.id, ...at(l), ...held.has(l.id) ? {} : { w: Math.round(l.w), h: Math.round(l.h) }, title: l.title })).sort(byId),
      ]));
      waiting = await Promise.all(this.devices.map((d) => d.unpushed()));
      const now = JSON.stringify([scenes, waiting]);
      // a gesture's changes wait for its end
      const pushed = waiting.every((n, i) => n === 0 || [...scenes[i]!.cards, ...scenes[i]!.lanes].some((x) => x.held));
      if (now !== last) [last, since] = [now, Date.now()];
      else if (Date.now() - since >= 500 && boards.every((b) => b === boards[0]) && pushed) return;
    }
    throw new Error(`the devices did not settle: ${this.devices.map((d, i) => `${d.kind} shows ${boards[i]}, ${waiting[i]} waiting`).join("; ")}`);
  }

  /** Each touchscreen's touches in build/touches/, named for the case, `verdict` first, for a run to tell why one failed. */
  async record(name: string, verdict: string) {
    if (verdict !== "passed") await this.recordSync(name, verdict);
    for (const d of this.devices) {
      // a phone's for every case, as its touches go through Android; a desktop browser's for a failing one
      if (!(d instanceof BrowserDevice) || !d.phone && verdict === "passed") continue;
      const touches = await Promise.race([d.touches().catch((e: Error) => `no touches: ${e.message}`), sleep(5000).then(() => "no touches: the page did not answer in 5 s")]);
      if (touches === null) continue;
      mkdirSync(join(root, "build", "touches"), { recursive: true });
      const file = join(root, "build", "touches", `${new Date().toISOString().replace(/[:.]/g, "-")} ${name.replace(/[^\w →-]+/g, "").slice(0, 120)}`);
      writeFileSync(`${file}.txt`, `${verdict}\n${touches}\n`);
      if (verdict !== "passed") try { writeFileSync(`${file}.png`, d.capture()!); } catch {}
      // the emulator's for the case alone, as a soak's runs outlast its log
      if (verdict !== "passed") try { writeFileSync(`${file}.logcat.txt`, d.logcat(this.started)!); } catch {}
    }
  }

  /**
   * In build/scenarios, each device's sync log merged in time, then what each says of its sync and shows of the board:
   * whether a change stopped on the device that made it, at the server, or on the one meant to show it.
   */
  private async recordSync(name: string, verdict: string) {
    const answer = <T>(p: Promise<T>) => Promise.race([p.catch((e: Error) => `none: ${e.message}`), sleep(5000).then(() => "none in 5 s")]);
    const lines: [number, string][] = [];
    const ends: string[] = [];
    for (const [i, d] of this.devices.entries()) {
      const who = `d${i} ${d.kind}`;
      if (d instanceof BrowserDevice) lines.push(...d.log.map(([ms, what]): [number, string] => [ms, `${who}: ${what}`]));
      ends.push(`${who} says ${JSON.stringify(await answer(d.syncStatus()))}`);
      const s = await answer(d.scene());
      ends.push(`${who} shows ${typeof s === "string" ? s : JSON.stringify({ cards: s.cards.map(({ id, x, y }) => ({ id, x, y })), lanes: s.lanes.map(({ id, x, y }) => ({ id, x, y })) })}`);
    }
    lines.sort((a, b) => a[0] - b[0]);
    const dir = join(root, "build", "scenarios");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")} ${name.replace(/[^\w →-]+/g, "").slice(0, 120)}.txt`);
    // wall clock, to find the case in the emulator's log and the runner's load
    const when = `started ${new Date(this.started).toISOString()}, recorded ${new Date().toISOString()}`;
    writeFileSync(file, [verdict, when, ...lines.map(([ms, what]) => `${String(ms).padStart(7)} ${what}`), "", ...ends, ""].join("\n"));
  }

  /**
   * Everything it started, each part even when another part fails to stop, as when the phone's adb connection broke,
   * and within 10 s: Firefox's context on a wedged emulator once never closed, and held the web server's port from every
   * case after it.
   */
  async stop() {
    const bounded = async (what: string, p: Promise<unknown>) => {
      if (!await Promise.race([p.then(() => true, () => true), sleep(10_000).then(() => false)])) {
        globalThis.console.log(`stopping the world: ${what} did not end in 10 s`);
      }
    };
    for (const b of this.browsers) await bounded(`${b.browserType().name()}'s close`, b.close());
    for (const c of this.contexts) {
      // Firefox on Android keeps its tabs from run to run, and closes one only as its page closes
      for (const p of c.pages()) await bounded("a Firefox for Android page's close", p.close());
      await bounded("Firefox for Android's close", c.close());
    }
    for (const [d, c] of this.androids) {
      // closing the context leaves Chrome's tabs open on a phone, and it restores every one when it starts again
      for (const p of c?.pages() ?? []) await bounded("a Chrome for Android page's close", p.close());
      if (c) await bounded("Chrome for Android's close", c.close());
      // which once waited 90 s, on a connection adbd had stopped serving, after the case had passed
      await bounded("the Android device's connection", d.close());
    }
    for (const c of this.consoles) c.close();
    for (const d of this.devices) if (d instanceof MacDevice) await bounded("the Mac app's stop", d.stop());
    for (const c of this.children) try { process.kill(-c.pid!, "SIGKILL"); } catch {}
    for (const d of this.dirs) rmSync(d, { recursive: true, force: true });
    this.web?.close();
    this.web?.closeAllConnections();
  }
}

// as direct-e2e.ts does: the list may be laid out out of sight, which a person's click could not reach either
const press = (page: Page, selector: string) => until(selector, () => page.evaluate((sel) => {
  const e = document.querySelector<HTMLElement>(sel);
  e?.click();
  return !!e;
}, selector));

/** Opens the space's board from the board list, once it is drawn: opening draws it on the next frame. */
async function openBoard(page: Page) {
  await press(page, '.boards-group[data-group^="space:"] li[data-board] .open');
  await page.waitForSelector('body[data-screen="board"]');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** Joins the space of invite `hash` as `name`, as a person does from the link. */
async function joinSpace(page: Page, hash: string, name: string) {
  await page.goto(`http://localhost:${WEB}/`);
  await page.waitForSelector(".boards-groups > *");
  // the page's own module, which keeps who this device is
  await page.evaluate(([device, name, idb]) => import(idb!).then((m: typeof import("../web/sync/idb.ts")) => m.saveState("me", { device, name })),
    [randomBytes(16).toString("base64url"), name, "/sync/idb.js"]);
  await page.goto("about:blank");
  await page.goto(`http://localhost:${WEB}/${hash}`);
  await until("the join prompt", () => page.evaluate(() => {
    const sheet = document.querySelector("#sheet:not([hidden])");
    if (!sheet?.querySelector(".sheet-title")?.textContent?.startsWith("Join")) return false;
    sheet.querySelector<HTMLElement>('[data-sheet="ok"]')!.click();
    return true;
  }));
}
