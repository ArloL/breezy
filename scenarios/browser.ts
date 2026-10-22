// The web app built as it ships, in headless Chromium, WebKit and Firefox and in Chrome and Firefox on Android, against
// sync.php and the relay under wrangler dev, on the wall clock: the same scenarios as on the hub, through the browsers'
// own input and the DOM.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, totalmem } from "node:os";
import { connect, type Socket } from "node:net";
import { extname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { _android, chromium, firefox, webkit, type AndroidDevice, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import { inviteLink } from "../web/sync/crypto.ts";
import { Device, type Box, type Editor, type Frame, type PointerExtra, type PointerPhase, type Scene, type SceneItem } from "./device.ts";
import { MacDevice } from "./mac.ts";
import { adb, adbBytes, environment, logcatLines, RECORDS, sampleRunner, Steps, timeline, type Line, type Step } from "./record.ts";
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
 * relay, and the page's errors and console. */
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
  // Firefox's through WebDriver BiDi's log.entryAdded
  page.on("console", (m) => note(`console ${m.type()}: ${m.text().slice(0, 500)}`));
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
    const size = execFileSync("adb", ["-s", serial, "shell", "wm", "size"], { encoding: "utf8", timeout: 10_000 }).match(/(\d+)x(\d+)\s*$/)!;
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

  /** The emulator's log since `since`, on Date.now(), its times as such. */
  logcat(since: number) {
    return adb(this.serial, ["logcat", "-d", "-v", "threadtime", "-v", "epoch", "-t", (since / 1000).toFixed(3)]);
  }

  /**
   * The emulator as a case failed, before anything stops: its screen, its windows and its keyboard, as files, each
   * bounded, and why one is missing in its place. Not after each step, as a dump takes system_server a while, and the
   * touches with it.
   */
  async failure(): Promise<[string, Buffer | string][]> {
    const parts: [string, Promise<Buffer | string>][] = [
      ["screen.png", adbBytes(this.serial, ["exec-out", "screencap", "-p"])],
      ["windows.txt", adb(this.serial, ["shell", "dumpsys", "window", "windows"])],
      ["ime.txt", adb(this.serial, ["shell", "dumpsys", "input_method"])],
    ];
    return Promise.all(parts.map(async ([name, p]): Promise<[string, Buffer | string]> => [name, await p.catch((e: Error) => `none: ${e.message}\n`)]));
  }

  /** The texts on screen, and the screen in build/android-touches.png, for a person to tell what covers the page. */
  texts() {
    try {
      writeFileSync(join(root, "build", "android-touches.png"), this.capture());
      const ui = execFileSync("adb", ["-s", this.serial, "shell", "uiautomator dump /sdcard/ui.xml >/dev/null && cat /sdcard/ui.xml"], { encoding: "utf8", timeout: 20_000 });
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

/** What a page saw, as `logPage` keeps it: what, point, its time, and the time handled, on the page's wall clock. */
type PageEvents = [string, number, number, number, number][];

/** Whether an editor has the keyboard. Runs in the page. */
function editing() {
  const e = document.activeElement;
  return e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement || (e as HTMLElement | null)?.isContentEditable === true;
}

/**
 * Keeps in `pageEvents` each touch's pointer event, key and focus change as it reaches the page, the page's size as the
 * keyboard changes it, its long tasks, and each second the frames it drew and how late its timer ran: a page that drew
 * nothing as the keyboard came up once took a day to tell from one that did not hear the touch. Runs in the page.
 */
function logPage() {
  const events: PageEvents = [];
  (window as { pageEvents?: typeof events }).pageEvents = events;
  const now = () => performance.timeOrigin + performance.now();
  const note = (what: string, t = now()) => events.push([what, 0, 0, t, now()]);
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
    addEventListener(type, (e) => {
      const p = e as PointerEvent;
      if (p.pointerType === "mouse" && (type === "pointerdown" || type === "pointerup")) {
        const t = p.target as HTMLElement;
        const cls = t.getAttribute?.("class");
        const on = `${t.tagName?.toLowerCase()}${cls ? `.${cls}` : ""}${t.isContentEditable ? " editable" : ""}`;
        return events.push([`mouse ${type.slice(7)} on ${on}`, Math.round(p.clientX), Math.round(p.clientY), performance.timeOrigin + p.timeStamp, now()]);
      }
      if (p.pointerType !== "touch") return;
      // what a finger came down on, as a tap that missed an editor's text ends the edit
      const t = p.target as HTMLElement, cls = t.getAttribute?.("class");
      const on = type === "pointerdown" ? ` on ${t.tagName?.toLowerCase()}${cls ? `.${cls}` : ""}${t.isContentEditable ? " editable" : ""}` : "";
      events.push([`${type.slice(7)}${on}`, Math.round(p.clientX), Math.round(p.clientY), performance.timeOrigin + p.timeStamp, now()]);
    }, { capture: true });
  }
  // the page's size and where the visual viewport is panned to, which the keyboard changes
  let was = "";
  const size = () => {
    const is = `resize ${innerHeight} ${Math.round(visualViewport!.height)} at ${Math.round(visualViewport!.offsetTop)}`;
    // the window's and the visual viewport's, mostly together
    if (is !== was) note(was = is);
  };
  addEventListener("resize", size);
  visualViewport!.addEventListener("resize", size);
  addEventListener("visibilitychange", () => note(`visibility ${document.visibilityState}`));
  // what had the keyboard, for a touch an editor kept from the board
  for (const type of ["keydown", "focusin", "focusout"]) {
    addEventListener(type, (e) => {
      const t = e.target as Element, cls = t.getAttribute?.("class");
      const what = e instanceof KeyboardEvent ? e.key : `${t.tagName?.toLowerCase()}${cls ? `.${cls}` : ""}`;
      events.push([`${type} ${what}`, 0, 0, performance.timeOrigin + e.timeStamp, now()]);
    }, { capture: true });
  }
  // Chromium's alone
  if (PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
    new PerformanceObserver((l) => l.getEntries().forEach((e) => note(`long task ${Math.round(e.duration)} ms`, performance.timeOrigin + e.startTime))).observe({ type: "longtask" });
  }
  let frames = 0, drawn = performance.now(), due = performance.now() + 1000;
  const frame = (t: number) => {
    frames++;
    drawn = t;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  setInterval(() => {
    const t = performance.now();
    note(`frames ${frames}${t - drawn > 1000 ? `, none for ${Math.round(t - drawn)} ms` : ""}${t - due > 100 ? `, timer ${Math.round(t - due)} ms late` : ""}`);
    frames = 0;
    due = t + 1000;
  }, 1000);
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
  /** The events of the pages before this one, which launching again cleared. */
  private seenBefore: PageEvents = [];

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

  /** On a phone, the emulator as a case failed. */
  failure() {
    return this.touchscreen?.failure();
  }

  /** On a phone, the emulator's log since `since`. */
  logcat(since: number) {
    return this.touchscreen?.logcat(since);
  }

  /** Whether its touches go through an emulator's touchscreen. */
  get phone() {
    return !!this.touchscreen;
  }

  /**
   * The page's events and the touches sent to the emulator on this machine's clock, as `who`'s, and how they kept step;
   * the page's clock set to this one's by a round trip. A pointer event's own time is when the browser read the touch.
   */
  async events(who: string): Promise<{ lines: Line[]; summary: string; skew: number }> {
    const t0 = Date.now();
    const [now, seenNow] = await this.page.evaluate(() => [performance.timeOrigin + performance.now(), (window as { pageEvents?: PageEvents }).pageEvents ?? []] as const);
    const seen = [...this.seenBefore, ...seenNow];
    const skew = now - (t0 + Date.now()) / 2;
    const sent = this.touchscreen?.sent ?? [];
    const lines: Line[] = [
      ...sent.map(({ at, ok, what }): Line => [at, who, `sent ${what}${ok - at > 20 ? ` (console answered in ${ok - at} ms)` : ""}`]),
      ...seen.map(([type, x, y, t, handled]): Line => [t - skew, who, `page ${type}${x || y ? ` ${x},${y}` : ""}${handled - t > 20 ? ` (handled ${Math.round(handled - t)} ms later)` : ""}`]),
    ];
    let summary = `page clock ${Math.round(skew)} ms ahead`;
    if (this.touchscreen) {
      // where its touches stopped being read in step with them: a down or up read later than sent
      // a finger each, as a frame of two fingers is one sent and two seen, and a lift the page saw cancelled
      const downs = sent.flatMap((s) => s.what.split(" ").filter((w) => /^(down|up|cancel)\d+$/.test(w)).map(() => s));
      const heard = seen.filter(([type]) => type.startsWith("down") || type === "up" || type === "cancel");
      const lags = downs.map((s, i) => heard[i] ? Math.round(heard[i][3] - skew - s.at) : NaN);
      summary += `; ${sent.length} sent, ${heard.length} downs and ups seen; down/up lags ${lags.join(" ")}`;
    }
    return { lines, summary, skew };
  }

  /** What it shows, and the page's size, which a phone's keyboard takes from, and focus. */
  override async state() {
    const [scene, page] = await Promise.all([
      super.state(),
      this.page.evaluate(() => {
        const v = visualViewport!, e = document.activeElement as HTMLElement | null;
        const cls = e?.getAttribute("class");
        return `view ${innerHeight} ${Math.round(v.height)} at ${Math.round(v.offsetTop)}, focus ${e?.tagName.toLowerCase()}${cls ? `.${cls}` : ""}${e?.isContentEditable ? " editable" : ""}`;
      }),
    ]);
    return `${scene}; ${page}`;
  }

  /** The touches the page has seen lift since it loaded. */
  private lifts() {
    return this.page.evaluate(() => ((window as { pageEvents?: PageEvents }).pageEvents ?? []).filter(([type]) => type === "up" || type === "cancel").length);
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
    this.seenBefore.push(...await this.page.evaluate(() => (window as { pageEvents?: PageEvents }).pageEvents ?? []));
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

  /** ⌘ as a desktop browser off the Mac has it, as on CI's Android runner: Ctrl, with Ctrl+Home and Ctrl+End for ⌘↑ and
   * ⌘↓, and Home and End for ⌘← and ⌘→. */
  async key(key: string, mods: { meta?: boolean; shift?: boolean } = {}) {
    const shift = mods.shift ? "Shift+" : "";
    if (mods.meta && process.platform !== "darwin" && ["chromium", "webkit", "firefox"].includes(this.kind)) {
      const ends: Record<string, string> = { ArrowUp: "Control+Home", ArrowDown: "Control+End", ArrowLeft: "Home", ArrowRight: "End" };
      return this.page.keyboard.press(`${shift}${ends[key] ?? `Control+${key}`}`);
    }
    await this.page.keyboard.press(`${mods.meta ? "Meta+" : ""}${shift}${key}`);
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

  /** Its four events in one go, as a person's come: sent one round trip each, the second press came 599 ms after the
   * first on a busy runner, past the app's 500 ms for a double-click. */
  override async doubleClick(p: Point) {
    const s = await this.screen(p);
    await this.page.mouse.dblclick(s.x, s.y);
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

/** Firefox for Android with its profile's folder here, and whether it closed. */
interface Fenix {
  context: BrowserContext;
  dir: string;
  closed: boolean;
}

/**
 * The Firefox for Android a world that passed kept for the next: each launch left 200 MB of the emulator's memory behind
 * on a Linux runner, where loading the app again in one Firefox, or in a new tab of it, left none.
 */
let fenix: Fenix | null = null;

/** What the emulator holds of this machine's memory, in MB; 0 when none runs here. */
function emulatorMB(): number {
  try {
    return execFileSync("ps", ["-axo", "rss=,command="], { encoding: "utf8", timeout: 5000 }).split("\n")
      .filter((l) => /qemu-system-\S+ .*-avd /.test(l)).reduce((mb, l) => mb + Number(l.trim().split(/\s+/)[0]) / 1024, 0);
  } catch {
    return 0;
  }
}

/**
 * Boots the emulator again once it holds more than `share` of this machine's memory, and says so; else nothing. Each
 * case in Firefox for Android left 200 MB of it behind on a Linux runner, where the emulator draws without a GPU: one
 * pass of the scenarios took a 16 GB runner to its last gigabyte, and a soak's second took the emulator and the runner.
 */
export async function rebootFullEmulator(share = Number(process.env.EMULATOR_MAX_SHARE ?? 0.6)): Promise<string | null> {
  const mb = emulatorMB();
  hadEmulator ??= mb > 0;
  // one that quit, or that a boot before left down, is booted too, where this process began with one
  if (mb === 0 ? !hadEmulator : mb < share * totalmem() / 2 ** 20) return null;
  if (fenix) {
    fenix.context.close().catch(() => {});
    rmSync(fenix.dir, { recursive: true, force: true });
    fenix = null;
  }
  if (mb > 0) {
    try {
      // listed offline too, as one short of memory may be
      const serial = /^(emulator-\d+)\t/m.exec(execFileSync("adb", ["devices"], { encoding: "utf8", timeout: 30_000 }))?.[1];
      if (serial) execFileSync("adb", ["-s", serial, "emu", "kill"], { timeout: 30_000, stdio: "ignore" });
      await until("the emulator to quit", () => emulatorMB() === 0, 30_000);
    } catch {
      try {
        execFileSync("pkill", ["-KILL", "-f", "qemu-system-.* -avd "], { timeout: 10_000 });
      } catch {}
      await until("the emulator to be killed", () => emulatorMB() === 0, 30_000);
    }
  }
  // scripts/android.ts starts its log afresh, and the old one says what the emulator went through
  const log = join(root, "build", "android-emulator.log");
  if (existsSync(log)) renameSync(log, join(root, "build", `android-emulator-${new Date().toISOString().replace(/[:.]/g, "-")}.log`));
  // adb's server, which kept the old one's connections and never saw the new one boot, again; twice, a boot failing now
  // and then
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync("adb", ["kill-server"], { timeout: 30_000, stdio: "ignore" });
    } catch {}
    try {
      execFileSync(process.execPath, [join(root, "scripts", "android.ts")], { timeout: 600_000, stdio: ["ignore", "ignore", "inherit"] });
      break;
    } catch (e) {
      if (attempt === 2) throw e;
      try {
        execFileSync("pkill", ["-KILL", "-f", "qemu-system-.* -avd "], { timeout: 10_000 });
      } catch {}
    }
  }
  return `the emulator held ${Math.round(mb)} MB of ${Math.round(totalmem() / 2 ** 20)}: booted it again, now ${Math.round(emulatorMB())} MB`;
}

/** Whether an emulator ran as this process began. */
let hadEmulator: boolean | undefined;

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
  execFileSync("adb", ["-s", device.serial(), "shell", "am", "set-debug-app", "--persistent", "com.android.chrome"], { timeout: 30_000 });
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
  /** Firefox for Android, which a world that passed keeps for the next. */
  private fenix: Fenix | null = null;
  private readonly children: ChildProcess[] = [];
  private readonly dirs: string[] = [];
  private readonly consoles: EmulatorConsole[] = [];
  private web?: ReturnType<typeof createServer>;
  /** When it started, on performance.now(): the devices' logs count from it. */
  private t0 = 0;
  /** When it started, on Date.now(): the emulator's log counts from it. */
  private started = 0;
  /** What it and the case did, each with its time and how long it took. */
  readonly steps = new Steps();
  /** The runner's load as it ran, and what the relay and the server said. */
  private readonly host: Line[] = [];
  private stopSampling = () => {};
  /** Worlds started and not yet stopped. A case that never ends never stops its world, which held the ports every
   * world uses from the 39 cases after it: the next world ends it. */
  private static readonly live = new Set<RealWorld>();
  /** Whether it was told to stop: a case out of time stops its world while that may still be starting. */
  private ended = false;

  /** Browsers and Macs of `kinds`, in one space with one board that all of them show. Stop it even when this fails
   * or never ends. */
  async start(kinds: RealKind[]) {
    RealWorld.hook();
    for (const w of RealWorld.live) w.kill();
    RealWorld.live.add(this);
    this.t0 = performance.now();
    this.started = Date.now();
    this.stopSampling = sampleRunner(this.host);
    await this.steps.run("world", "serve", [], () => this.serve());
    this.late();
    const space = randomBytes(16).toString("base64url"), secret = randomBytes(32).toString("base64url");
    const link = inviteLink({ server: `http://127.0.0.1:${SERVER}/sync.php`, space, secret, name: "Scenario" });
    for (const [i, kind] of kinds.entries()) {
      const step = async <T>(action: string, f: () => Promise<T>) => {
        const r = await this.steps.run(`d${i} ${kind}`, action, [], f);
        this.late(r);
        return r;
      };
      if (kind === "mac") {
        // below every system's ephemeral ports, which a process listening on a random port took once
        const mac = await step("launch", () => MacDevice.start(18570 + i, `d${i}`));
        this.devices.push(mac);
        await step("join", () => mac.command({ cmd: "join", link }));
        const board = i === 0
          ? await step("createBoard", () => mac.command<string>({ cmd: "createBoard", title: "Board" }))
          : await step("seeBoard", () => until("the board on the Mac", async () => (await mac.command<string[]>({ cmd: "boards" }))[0]));
        await step("openBoard", () => mac.command({ cmd: "open", board }));
        continue;
      }
      const [page, touchscreen] = await step("launch", async () => kind === "android" ? this.android() : kind === "firefox-android" ? this.firefoxAndroid() : [await this.browser(kind)]);
      const d = new BrowserDevice(kind, page, touchscreen, this.t0);
      this.devices.push(d);
      await step("join", () => joinSpace(page, link.slice(link.indexOf("#join=")), `d${i}`));
      if (i === 0) {
        await step("createBoard", async () => {
          await press(page, "section.boards-group:has(header .edit) button.new");
          await until("the board name prompt", () => page.evaluate(() => !document.querySelector<HTMLElement>("#sheet")!.hidden));
          await page.fill("#sheet input", "Board");
          await press(page, '#sheet [data-sheet="ok"]');
        });
      }
      await step("openBoard", () => openBoard(page));
    }
  }

  /** The devices as a case acts on them: each call it makes a step, with what its device shows after it. */
  stage() {
    return {
      devices: this.devices.map((d, i) => this.steps.wrap(d, `d${i} ${d.kind}`, () => d.state())),
      settle: () => this.steps.run("world", "settle", [], () => this.settle()),
    };
  }

  private async browser(kind: Exclude<BrowserKind, "android" | "firefox-android">) {
    const browser = await { chromium, webkit, firefox }[kind].launch();
    this.browsers.push(browser);
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, hasTouch: true, reducedMotion: "reduce" });
    await context.addInitScript(logPage);
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
    for (const port of [WEB, SERVER, RELAY]) execFileSync("adb", ["-s", device.serial(), "reverse", `tcp:${port}`, `tcp:${port}`], { timeout: 30_000 });
    const context = opened[1] = await launchAndroidChrome(device);
    // the only tab, so the one on screen: a first launch also restores the tab Chrome's first run left
    await context.addInitScript(logPage);
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
    const serial = execFileSync("adb", ["devices"], { encoding: "utf8", timeout: 30_000 }).match(/^(emulator-\d+)\tdevice$/m)?.[1];
    if (!serial) throw new Error("no Android emulator: run node scripts/android.ts");
    for (const port of [WEB, SERVER, RELAY]) execFileSync("adb", ["-s", EMULATOR_TCP, "reverse", `tcp:${port}`, `tcp:${port}`], { timeout: 30_000 });
    // the Firefox the world before kept, if it still answers
    let held = fenix;
    fenix = null;
    const answers = (p?: Page) => p ? Promise.race([p.evaluate(() => true).catch(() => false), sleep(5000).then(() => false)]) : false;
    if (held && (held.closed || !await answers(held.context.pages()[0]))) {
      held.context.close().catch(() => {});
      rmSync(held.dir, { recursive: true, force: true });
      held = null;
    }
    if (!held) {
      const dir = mkdtempSync(join(tmpdir(), "breezy-scenario-fenix-"));
      const context = await firefox.launchPersistentContext(dir, { channel: "moz-firefox", executablePath: join(root, "scenarios", "fenix.ts"), viewport: null, timeout: 60_000 });
      held = { context, dir, closed: false };
      const h = held;
      context.on("close", () => (h.closed = true));
      await context.addInitScript(logPage);
    }
    else {
      // to the front as a tap on its icon brings it, over Chrome, which a case in it may have left there
      execFileSync("adb", ["-s", EMULATOR_TCP, "shell", "am", "start", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER",
        "-f", "0x10200000", "-n", `${FENIX}/.App`], { timeout: 30_000, stdio: "ignore" });
      // none resumed for a moment as it comes
      const top = () => execFileSync("adb", ["-s", EMULATOR_TCP, "shell", "dumpsys activity activities | grep -m1 topResumedActivity; true"], { encoding: "utf8", timeout: 10_000 });
      await until("Firefox for Android in front", () => top().includes(`${FENIX}/`), 15_000);
    }
    this.fenix = held;
    const context = held.context;
    // the tab Firefox opened with, which is the one on screen, without what the world before listened for
    const page = context.pages()[0] ?? await context.newPage();
    page.removeAllListeners();
    await context.setOffline(false);
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
    const console = await EmulatorConsole.open(serial);
    this.consoles.push(console);
    return [page, await Touchscreen.of(EMULATOR_TCP, console, page)] as const;
  }

  private async serve() {
    installed();
    await free(WEB, SERVER, RELAY);
    const site = join(root, "build", "web-scenarios");
    buildSite(site);
    this.web = serveStatic(site, WEB);
    const relayState = mkdtempSync(join(tmpdir(), "breezy-scenario-relay-"));
    this.dirs.push(relayState);
    /** `cmd` in a process group of its own, what it says kept as `name`'s but php's log of each request it answered. */
    const group = (name: string, cmd: string, args: string[], cwd?: string) => {
      const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
      this.children.push(child);
      let rest = "";
      const read = (data: Buffer) => {
        const lines = (rest + data.toString()).split("\n");
        rest = lines.pop()!;
        for (const l of lines.map((l) => l.replace(/\x1b\[[\d;]*m/g, "").trim())) {
          if (l && !/:\d+ (Accepted|Closing)$|\[[23]\d\d\]: \w+ \//.test(l)) this.host.push([Date.now(), name, l.slice(0, 300)]);
        }
      };
      child.stdout!.on("data", read);
      child.stderr!.on("data", read);
      child.on("exit", (code, signal) => this.host.push([Date.now(), name, `exited with ${code ?? signal}`]));
    };
    group("relay", "npx", ["--prefix", join(root, "relay"), "wrangler", "dev", "--port", String(RELAY), "--persist-to", relayState], join(root, "relay"));
    group("server", join(root, "server/dev.sh"), []);
    const said = (name: string) => this.host.filter(([, n]) => n === name).slice(-20).map(([, , l]) => `  ${l}`).join("\n");
    await until("the relay", () => fetch(`http://127.0.0.1:${RELAY}/`).then(() => true, () => false), 60_000)
      .catch((e: Error) => Promise.reject(new Error(`${e.message}; it said:\n${said("relay")}`)));
    await until("the server", () => fetch(`http://127.0.0.1:${SERVER}/sync.php`).then(() => true, () => false))
      .catch((e: Error) => Promise.reject(new Error(`${e.message}; it said:\n${said("server")}`)));
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

  /**
   * Its record in build/scenarios/<when> <test>/, passing or failing: case.json, and timeline.txt, which ends in what each
   * device says of its sync and shows of the board, to tell whether a change stopped on the device that made it, at the
   * server, or on the one meant to show it. On a failing phone, the emulator as the case failed, before anything stops.
   * Each part bounded, as a page or an emulator that stopped answering once cost a failure all of its record.
   */
  async record(test: string, c: { name: string; pair: RealKind[]; run: number }, error: Error | null, timedOut: boolean) {
    const ended = Date.now();
    const verdict = !error ? "passed" : timedOut ? "timed out" : "failed";
    const dir = join(RECORDS, `${new Date(this.started).toISOString().replace(/[:.]/g, "-")} ${c.pair.join("→")} ${c.name.replace(/[^\w -]+/g, "").slice(0, 100)}`);
    mkdirSync(dir, { recursive: true });
    const answer = <T>(p: Promise<T>) => Promise.race([p.catch((e: Error) => `none: ${e.message.split("\n")[0]}`), sleep(5000).then(() => "none in 5 s")]);
    const failing = error ? this.steps.failed() : undefined;
    await this.steps.read();
    const lines: Line[] = [...this.host, ...this.steps.lines()];
    const parts = await Promise.all(this.devices.map(async (d, i) => {
      const who = `d${i} ${d.kind}`, summary: string[] = [];
      if (d instanceof BrowserDevice) {
        lines.push(...d.log.map(([ms, what]): Line => [this.started + ms, who, what]));
        const events = await answer(d.events(who));
        // the emulator's log for a passing case too, for when its keyboard came and went, on its own clock: the page's
        const skew = typeof events === "string" ? 0 : events.skew;
        const [failure, logcat] = await Promise.all([error ? d.failure() : undefined, d.phone ? answer(d.logcat(this.started + skew)!) : undefined]);
        if (typeof events === "string") summary.push(`${who}: no page events: ${events}`);
        else {
          lines.push(...events.lines);
          summary.push(`${who}: ${events.summary}`);
        }
        for (const [name, data] of failure ?? []) writeFileSync(join(dir, `${who} ${name}`), data);
        if (logcat !== undefined) {
          lines.push(...logcatLines(logcat, `${who} logcat`).map(([at, source, what]): Line => [at - skew, source, what]));
          if (error) writeFileSync(join(dir, `${who} logcat.txt`), logcat);
        }
      }
      const [status, s] = await Promise.all([answer(d.syncStatus()), answer(d.scene())]);
      const ends = [`${who} says ${JSON.stringify(status)}`,
        `${who} shows ${typeof s === "string" ? s : JSON.stringify({ cards: s.cards.map(({ id, x, y }) => ({ id, x, y })), lanes: s.lanes.map(({ id, x, y }) => ({ id, x, y })) })}`];
      const version = d instanceof BrowserDevice ? d.page.context().browser()?.version() ?? (d.kind === "firefox-android" ? FENIX_VERSION : undefined) : undefined;
      return { summary, ends, device: { who, kind: d.kind, version } };
    }));
    const environ = await environment();
    const at = (s: Step) => `${s.who} ${s.action}(${s.args})${s.error ? `: ${s.error}` : s.ms === undefined ? ", never ended" : ""}`;
    writeFileSync(join(dir, "timeline.txt"), [
      error ? `${verdict}: ${error.stack ?? error}` : verdict,
      `${test}, run ${c.run}, ${new Date(this.started).toISOString()} to ${new Date(ended).toISOString()}`,
      ...failing ? [`at step ${at(failing)}`] : [],
      ...parts.flatMap((p) => p.summary),
      "",
      timeline(lines, this.started),
      "",
      ...parts.flatMap((p) => p.ends),
      "",
    ].join("\n"));
    writeFileSync(join(dir, "case.json"), `${JSON.stringify({
      test, case: c.name, pair: c.pair, run: c.run, verdict, error: error?.message, stack: error?.stack,
      started: new Date(this.started).toISOString(), ms: ended - this.started,
      step: failing && { who: failing.who, action: failing.action, args: failing.args, error: failing.error ?? "never ended" },
      steps: this.steps.list.map((s) => ({ ...s, at: s.at - this.started })),
      devices: parts.map((p) => p.device),
      environment: environ,
    }, null, 2)}\n`);
  }

  /** Every world not yet stopped, killed, as the process ends. */
  static killAll() {
    for (const w of RealWorld.live) w.kill();
  }

  /** Every world killed as the process ends: the servers run in process groups of their own, which outlive a run ended
   * by --test-force-exit or ⌃C, and held the ports from the next run's every case. Once a world starts, so that what
   * only imports this, as fenix.ts does, keeps its own handlers. */
  private static hook() {
    if (RealWorld.hooked) return;
    RealWorld.hooked = true;
    process.once("exit", () => RealWorld.killAll());
    for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
      process.once(signal, () => {
        RealWorld.killAll();
        process.exit(code);
      });
    }
  }

  private static hooked = false;

  /** Once it was told to stop, what it started since, `made` too, ended, and the start with it. */
  private late(made?: unknown) {
    if (!this.ended) return;
    if (made instanceof MacDevice) made.kill();
    this.kill();
    throw new Error("the world stopped as it started, as its case ran out of time");
  }

  /** What of it holds a port or runs, ended at once, without waiting: a world whose case never ended. Its own stop then
   * does nothing, as it would close the browsers on Android under the world after it. */
  private kill() {
    RealWorld.live.delete(this);
    this.stopSampling();
    for (const c of this.children) try { process.kill(-c.pid!, "SIGKILL"); } catch {}
    this.web?.close();
    this.web?.closeAllConnections();
    for (const c of this.consoles) c.close();
    for (const d of this.devices) if (d instanceof MacDevice) d.kill();
    for (const b of this.browsers) b.close().catch(() => {});
  }

  /**
   * Everything it started, each part even when another part fails to stop, as when the phone's adb connection broke,
   * and within 10 s: Firefox's context on a wedged emulator once never closed, and held the web server's port from every
   * case after it.
   */
  /** Everything it started, and Firefox for Android too unless `keep`. */
  async stop(keep = false) {
    this.ended = true;
    // a world another one killed: closing its browsers on Android would close the next one's
    if (!RealWorld.live.has(this)) return;
    this.stopSampling();
    const bounded = async (what: string, p: Promise<unknown>) => {
      if (!await Promise.race([p.then(() => true, () => true), sleep(10_000).then(() => false)])) {
        globalThis.console.log(`stopping the world: ${what} did not end in 10 s`);
      }
    };
    for (const b of this.browsers) await bounded(`${b.browserType().name()}'s close`, b.close());
    if (this.fenix && keep && !this.fenix.closed) {
      // off the app, whose connections and timers would run on into the next world
      await bounded("Firefox for Android's blank page", this.fenix.context.pages()[0]?.goto("about:blank") ?? Promise.resolve());
      fenix = this.fenix;
    } else if (this.fenix) {
      const c = this.fenix.context;
      // Firefox on Android keeps its tabs from run to run, and closes one only as its page closes
      for (const p of c.pages()) await bounded("a Firefox for Android page's close", p.close());
      await bounded("Firefox for Android's close", c.close());
      rmSync(this.fenix.dir, { recursive: true, force: true });
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
    // only now, so that a process ended meanwhile kills its servers
    RealWorld.live.delete(this);
  }
}

/** That npm installed what package.json names: a run on a stale install, as of wrangler, differs from CI's unseen. */
function installed() {
  for (const [dir, pkg] of [[".", "playwright-core"], ["relay", "wrangler"]] as const) {
    const want = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")).devDependencies[pkg];
    const have = JSON.parse(readFileSync(join(root, dir, "node_modules", pkg, "package.json"), "utf8")).version;
    if (have !== want) throw new Error(`${dir}/node_modules has ${pkg} ${have} where package.json names ${want}: npm ci${dir === "." ? "" : ` --prefix ${dir}`}`);
  }
}

/** Until nothing listens on `ports` on this machine, for at most 10 s, else what does. */
async function free(...ports: number[]) {
  const end = Date.now() + 10_000;
  for (const port of ports) {
    // the relay's workerd listens on localhost, which may be IPv6's alone
    const open = (host: string) => new Promise<boolean>((resolve) => {
      const probe = createServer().once("error", (e: NodeJS.ErrnoException) => resolve(e.code !== "EADDRINUSE")).listen(port, host, () => probe.close(() => resolve(true)));
    });
    while (!await open("127.0.0.1") || !await open("::1")) {
      if (Date.now() > end) {
        // a connection whose own port it is takes it as surely as a server
        const who = [["lsof", "-nP", `-iTCP:${port}`], ["ss", "-tanp", `sport = :${port}`]].map(([cmd, ...args]) => {
          try {
            return execFileSync(cmd!, args, { encoding: "utf8", timeout: 5000 });
          } catch {
            return "";
          }
        }).find((out) => out.trim().split("\n").length > 1);
        throw new Error(`port ${port} is taken${who ? `: ${who}` : ""}`);
      }
      await sleep(250);
    }
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
  })).catch(async (e: Error) => {
    // where the page was instead, as Safari on iOS once showed no prompt
    // and whether the app could have started: it waits for the boards' lock and for IndexedDB before it reads the link
    const was = await page.evaluate(async () => {
      const within = <T>(p: Promise<T>) => Promise.race([p, new Promise<string>((r) => setTimeout(() => r("no answer in 2 s"), 2000))]);
      const locks = await within(navigator.locks?.query().then((q) => ({ held: q.held?.map((l) => l.name), pending: q.pending?.map((l) => l.name) })) ?? Promise.resolve("none"));
      const idb = await within(new Promise<string>((r) => Object.assign(indexedDB.open("breezy"), { onsuccess: (e: Event) => { (e.target as IDBOpenDBRequest).result.close(); r("opens"); }, onerror: () => r("fails"), onblocked: () => r("blocked") })));
      return JSON.stringify({
        url: location.href.replace(/#join=.*/, "#join=…"), screen: document.body.dataset.screen, ready: document.readyState,
        sheet: document.querySelector("#sheet:not([hidden]) .sheet-title")?.textContent ?? null, locks, idb,
      });
    }).catch((f: Error) => `unread: ${f.message}`);
    throw new Error(`${e.message}; the page: ${was}`);
  });
}
