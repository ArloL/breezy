// The web app built as it ships, in headless Chromium, WebKit and Firefox and in Chrome on Android, against sync.php and
// the relay under wrangler dev, on the wall clock: the same scenarios as on the hub, through the browsers' own input and
// the DOM.
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { _android, chromium, firefox, webkit, type AndroidDevice, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import { inviteLink } from "../web/sync/crypto.ts";
import { Device, type PointerExtra, type PointerPhase, type Scene, type SceneItem } from "./device.ts";
import { MacDevice } from "./mac.ts";
import type { Point } from "../web/types.ts";

export * from "./device.ts";

export type BrowserKind = "chromium" | "webkit" | "firefox" | "android";
export type RealKind = BrowserKind | "mac";

const root = new URL("..", import.meta.url).pathname;
// inside Android's ephemeral port range: scripts/android.ts reserves them on the emulator as it boots
export const WEB = 58565, SERVER = 58566, RELAY = 58568;
/** The emulator's adbd over TCP, through its port redirect: its own adb pipe drops every connection on it under load, a
 * few times an hour on some runners, and the page with them. scripts/android.ts connects it. */
export const EMULATOR_TCP = "127.0.0.1:5600";
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

/** The emulator's touchscreen, driven through its console: touches pass through Android's input as a finger's do. */
export class Touchscreen {
  private readonly ids = new Map<number, number>();
  private next = 1;
  private readonly serial: string;
  /** The screen's size in pixels. */
  private readonly px: Point;
  /** Pixels a page point. */
  private readonly dpr: number;
  /** Where the page starts, in points below the screen's top. */
  private top = 0;

  constructor(serial: string, px: Point, dpr: number) {
    this.serial = serial;
    this.px = px;
    this.dpr = dpr;
  }

  static async of(serial: string, page: Page): Promise<Touchscreen> {
    const size = execFileSync("adb", ["-s", serial, "shell", "wm", "size"], { encoding: "utf8" }).match(/(\d+)x(\d+)\s*$/)!;
    const t = new Touchscreen(serial, { x: Number(size[1]), y: Number(size[2]) }, await page.evaluate(() => devicePixelRatio));
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
        return t;
      }
    }
    throw new Error(`the page sees no touches: something of Chrome's covers it, showing ${t.texts()}`);
  }

  /** The texts on screen, and the screen in build/android-touches.png, for a person to tell what covers the page. */
  private texts() {
    try {
      writeFileSync(join(root, "build", "android-touches.png"), execFileSync("adb", ["-s", this.serial, "exec-out", "screencap", "-p"]));
      const ui = execFileSync("adb", ["-s", this.serial, "shell", "uiautomator dump /sdcard/ui.xml >/dev/null && cat /sdcard/ui.xml"], { encoding: "utf8" });
      return [...ui.matchAll(/text="([^"]+)"/g)].map((m) => m[1]).join(" | ");
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
    await run("adb", ["-s", this.serial, "emu", "event", "send", ...events, "EV_SYN:0:0"]);
  }
}

const run = promisify(execFile);

/**
 * A frame's finger pointer events, as iOS Safari sends them: one at a time, each at the element under its point, all with
 * the frame's time. Runs in the page.
 */
function touchEvents(events: [string, number, number, number][]) {
  const timeStamp = performance.now();
  for (const [type, x, y, finger] of events) {
    const target = (type === "pointerdown" && document.elementFromPoint(x, y)) || document.body;
    const e = new PointerEvent(type, { pointerId: 10 + finger, pointerType: "touch", isPrimary: finger === 0, clientX: x, clientY: y, bubbles: true, cancelable: true, buttons: type === "pointerup" ? 0 : 1 });
    Object.defineProperty(e, "timeStamp", { value: timeStamp });
    target.dispatchEvent(e);
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

  constructor(kind: BrowserKind, page: Page, touchscreen?: Touchscreen) {
    super();
    this.kind = kind;
    this.page = page;
    this.touchscreen = touchscreen;
  }

  override async size() {
    return this.page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  }

  override async fingers(phase: PointerPhase, moves: [number, Point][]) {
    if (this.touchscreen) return this.touchscreen.send(moves.map(([finger, p]) => [finger, phase, p]));
    if (!this.devtools) return this.page.evaluate(touchEvents, moves.map(([finger, p]): [string, number, number, number] => [TOUCH_TYPES[phase], p.x, p.y, finger]));
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

  /** Once its service worker keeps this version, as on a phone that launched it before. */
  override async offline(off: boolean) {
    if (off) await until("the service worker's snapshot", () => this.page.evaluate((version) => navigator.serviceWorker.ready.then((reg) => new Promise<boolean>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (e) => resolve(e.data.current === version);
      reg.active!.postMessage({ type: "check" }, [channel.port2]);
    })), VERSION));
    await this.page.context().setOffline(off);
  }

  override async syncStatus() {
    return this.page.evaluate(() => document.querySelector(".menu.more .status")?.textContent ?? "");
  }

  /** Once the board shows the cards and lanes it showed before, which it reads from storage after it opens. */
  override async relaunch() {
    const ids = (s: Scene) => [...s.cards, ...s.lanes].map((i) => i.id).sort().join(" ");
    const had = ids(await this.scene());
    await this.page.goto(`http://localhost:${WEB}/`);
    await openBoard(this.page);
    await until(`${this.kind} to show its board again`, async () => ids(await this.scene()) === had);
  }

  async wait(ms: number) {
    await sleep(ms);
  }

  async pointer(phase: PointerPhase, p: Point, extra: PointerExtra = {}) {
    if (extra.kind === "touch" && this.touchscreen) return this.touchscreen.send([[extra.finger ?? 0, phase, p]]);
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

  override async type(text: string) {
    await this.page.keyboard.type(text);
    // a touchscreen's touches reach the page by another way than DevTools' keys, and could overtake them
    if (this.touchscreen) {
      await this.page.waitForFunction((t) => {
        const e = document.activeElement;
        return (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement ? e.value : e?.textContent ?? "").endsWith(t);
      }, text, { timeout: 5000 });
    }
  }

  override async typeInto(id: string, text: string) {
    const r = (await this.scene()).cards.find((c) => c.id === id);
    if (!r) throw new Error(`nothing shows ${id}`);
    const p = await this.screen({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    await this.page.mouse.dblclick(p.x, p.y);
    await this.page.keyboard.type(text);
    await this.page.keyboard.press("Escape");
  }

  /** As a person makes one: a double-click, a title, and Esc. */
  async addCard(x: number, y: number): Promise<string> {
    const before = await this.scene();
    const p = await this.screen({ x, y });
    await this.page.mouse.dblclick(p.x, p.y);
    await this.page.keyboard.type("card");
    await this.page.keyboard.press("Escape");
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

export class RealWorld {
  readonly devices: (BrowserDevice | MacDevice)[] = [];
  private readonly browsers: Browser[] = [];
  private readonly androids: [AndroidDevice, BrowserContext?][] = [];
  private readonly children: ChildProcess[] = [];
  private readonly dirs: string[] = [];
  private web?: ReturnType<typeof createServer>;

  /** Browsers and Macs of `kinds`, in one space with one board that all of them show. Stop it even when this fails
   * or never ends. */
  async start(kinds: RealKind[]) {
    await this.serve();
    const space = randomBytes(16).toString("base64url"), secret = randomBytes(32).toString("base64url");
    const link = inviteLink({ server: `http://127.0.0.1:${SERVER}/sync.php`, space, secret, name: "Scenario" });
    for (const [i, kind] of kinds.entries()) {
      if (kind === "mac") {
        const mac = await MacDevice.start(58570 + i, `d${i}`);
        this.devices.push(mac);
        await mac.command({ cmd: "join", link });
        const board = i === 0
          ? await mac.command<string>({ cmd: "createBoard", title: "Board" })
          : await until("the board on the Mac", async () => (await mac.command<string[]>({ cmd: "boards" }))[0]);
        await mac.command({ cmd: "open", board });
        continue;
      }
      const [page, touchscreen] = kind === "android" ? await this.android() : [await this.browser(kind)];
      const d = new BrowserDevice(kind, page, touchscreen);
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

  private async browser(kind: Exclude<BrowserKind, "android">) {
    const browser = await { chromium, webkit, firefox }[kind].launch();
    this.browsers.push(browser);
    return (await browser.newContext({ viewport: { width: 1200, height: 800 }, hasTouch: true, reducedMotion: "reduce" })).newPage();
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
    // Chrome's launch stalls now and then, never opening its DevTools socket, which Playwright waits for without end;
    // launching force-stops it first. Why it stalls is not known.
    const launch = () => Promise.race([device.launchBrowser({ reducedMotion: "reduce" }), sleep(30_000).then(() => null)]);
    const context = opened[1] = await launch() ?? await launch() ?? undefined;
    if (!context) throw new Error("Chrome did not launch twice in 30 s");
    // the only tab, so the one on screen: a first launch also restores the tab Chrome's first run left
    const page = await context.newPage();
    for (const p of context.pages()) if (p !== page) await p.close();
    await page.bringToFront();
    // Chrome keeps its profile from run to run
    const cdp = await context.newCDPSession(page);
    await cdp.send("Storage.clearDataForOrigin", { origin: `http://localhost:${WEB}`, storageTypes: "all" });
    await cdp.detach();
    // an emulator's touchscreen; a phone's touches go through DevTools
    const touchscreen = emulator ? await Touchscreen.of(emulator, page) : undefined;
    return [page, touchscreen] as const;
  }

  private async serve() {
    const site = join(root, "build", "web-scenarios");
    execFileSync(join(root, "scripts/build-site.sh"), [site, VERSION], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
    const types: Record<string, string> = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };
    this.web = createServer((req, res) => {
      const path = join(site, new URL(req.url!, "http://x").pathname.replace(/\/$/, "/index.html"));
      if (!existsSync(path)) return res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream" }).end(readFileSync(path));
    }).listen(WEB, "127.0.0.1");
    const relayState = mkdtempSync(join(tmpdir(), "breezy-scenario-relay-"));
    this.dirs.push(relayState);
    const group = (cmd: string, args: string[], cwd?: string) => this.children.push(spawn(cmd, args, { cwd, stdio: "ignore", detached: true }));
    group("npx", ["--prefix", join(root, "relay"), "wrangler", "dev", "--port", String(RELAY), "--persist-to", relayState], join(root, "relay"));
    group(join(root, "server/dev.sh"), []);
    await until("the relay", () => fetch(`http://127.0.0.1:${RELAY}/`).then(() => true, () => false), 60_000);
    await until("the server", () => fetch(`http://127.0.0.1:${SERVER}/sync.php`).then(() => true, () => false));
  }

  /**
   * Until every device shows the same board, and nothing has changed for 500 ms. What a device holds floats where only
   * it draws it, and a card's size is its own font's.
   */
  async settle(ms = 15_000) {
    let last = "", since = Date.now(), boards: string[] = [];
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
      const scenes = await Promise.all(this.devices.map((d) => d.scene()));
      const held = new Set(scenes.flatMap((s) => [...s.cards, ...s.lanes].filter((i) => i.held).map((i) => i.id)));
      const at = (i: SceneItem) => held.has(i.id) ? {} : { x: Math.round(i.x), y: Math.round(i.y) };
      const byId = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : 1;
      boards = scenes.map((s) => JSON.stringify([
        s.cards.map((c) => ({ id: c.id, ...at(c), color: c.color, text: c.text })).sort(byId),
        s.lanes.map((l) => ({ id: l.id, ...at(l), ...held.has(l.id) ? {} : { w: Math.round(l.w), h: Math.round(l.h) }, title: l.title })).sort(byId),
      ]));
      const now = JSON.stringify(scenes);
      if (now !== last) [last, since] = [now, Date.now()];
      else if (Date.now() - since >= 500 && boards.every((b) => b === boards[0])) return;
    }
    throw new Error(`the devices did not settle: ${this.devices.map((d, i) => `${d.kind} shows ${boards[i]}`).join("; ")}`);
  }

  /** Everything it started, each part even when another part fails to stop, as when the phone's adb connection broke. */
  async stop() {
    for (const b of this.browsers) await b.close().catch(() => {});
    for (const [d, c] of this.androids) {
      // closing the context leaves Chrome's tabs open on a phone, and it restores every one when it starts again
      for (const p of c?.pages() ?? []) await p.close().catch(() => {});
      await c?.close().catch(() => {});
      await d.close().catch(() => {});
    }
    for (const d of this.devices) if (d instanceof MacDevice) d.stop();
    for (const c of this.children) try { process.kill(-c.pid!, "SIGKILL"); } catch {}
    for (const d of this.dirs) rmSync(d, { recursive: true, force: true });
    this.web?.close();
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
