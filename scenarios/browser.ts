// The web app built as it ships, in headless Chromium and WebKit, against sync.php and the relay under wrangler dev,
// on the wall clock: the same scenarios as on the hub, through the browsers' own input and the DOM.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { chromium, webkit, type Browser, type Page } from "playwright-core";
import { buildWeb } from "../scripts/build-web.ts";
import { inviteLink } from "../web/sync/crypto.ts";
import { Device, type PointerExtra, type PointerPhase, type Scene, type SceneItem } from "./device.ts";
import { MacDevice } from "./mac.ts";
import type { Point } from "../web/types.ts";

export * from "./device.ts";

export type BrowserKind = "chromium" | "webkit";
export type RealKind = BrowserKind | "mac";

const root = new URL("..", import.meta.url).pathname;
const WEB = 58565, SERVER = 58566, RELAY = 58568;
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

/** A finger's pointer event, as iOS Safari sends one: runs in the page, at the element under the point. */
function touchEvent([type, x, y, finger]: [string, number, number, number]) {
  const target = (type === "pointerdown" && document.elementFromPoint(x, y)) || document.body;
  target.dispatchEvent(new PointerEvent(type, { pointerId: 10 + finger, pointerType: "touch", isPrimary: finger === 0, clientX: x, clientY: y, bubbles: true, cancelable: true, buttons: type === "pointerup" ? 0 : 1 }));
}

export class BrowserDevice extends Device {
  readonly kind: BrowserKind;
  readonly page: Page;

  constructor(kind: BrowserKind, page: Page) {
    super();
    this.kind = kind;
    this.page = page;
  }

  async scene(): Promise<Scene> {
    return this.page.evaluate(readScene);
  }

  async wait(ms: number) {
    await sleep(ms);
  }

  async pointer(phase: PointerPhase, p: Point, extra: PointerExtra = {}) {
    if (extra.kind === "touch") {
      const type = { down: "pointerdown", move: "pointermove", up: "pointerup", cancel: "pointercancel" }[phase];
      return this.page.evaluate(touchEvent, [type, p.x, p.y, extra.finger ?? 0] as [string, number, number, number]);
    }
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
  private readonly children: ChildProcess[] = [];
  private readonly dirs: string[] = [];
  private web?: ReturnType<typeof createServer>;

  /** Browsers and Macs of `kinds`, in one space with one board that all of them show. */
  static async start(kinds: RealKind[]): Promise<RealWorld> {
    const w = new RealWorld();
    try {
      await w.serve();
      const space = randomBytes(16).toString("base64url"), secret = randomBytes(32).toString("base64url");
      const link = inviteLink({ server: `http://127.0.0.1:${SERVER}/sync.php`, space, secret, name: "Scenario" });
      for (const [i, kind] of kinds.entries()) {
        if (kind === "mac") {
          const mac = await MacDevice.start(58570 + i, `d${i}`);
          w.devices.push(mac);
          await mac.command({ cmd: "join", link });
          const board = i === 0
            ? await mac.command<string>({ cmd: "createBoard", title: "Board" })
            : await until("the board on the Mac", async () => (await mac.command<string[]>({ cmd: "boards" }))[0]);
          await mac.command({ cmd: "open", board });
          continue;
        }
        const browser = await (kind === "chromium" ? chromium : webkit).launch();
        w.browsers.push(browser);
        const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 }, hasTouch: true, reducedMotion: "reduce" })).newPage();
        const d = new BrowserDevice(kind, page);
        w.devices.push(d);
        await joinSpace(page, link.slice(link.indexOf("#join=")), `d${i}`);
        // as direct-e2e.ts does: the list may be laid out out of sight, which a person's click could not reach either
        const press = (selector: string) => until(selector, () => page.evaluate((sel) => {
          const e = document.querySelector<HTMLElement>(sel);
          e?.click();
          return !!e;
        }, selector));
        if (i === 0) {
          await press("section.boards-group:has(header .edit) button.new");
          await until("the board name prompt", () => page.evaluate(() => !document.querySelector<HTMLElement>("#sheet")!.hidden));
          await page.fill("#sheet input", "Board");
          await press('#sheet [data-sheet="ok"]');
        }
        await press('.boards-group[data-group^="space:"] li[data-board] .open');
        await page.waitForSelector('body[data-screen="board"]');
      }
      return w;
    } catch (e) {
      await w.stop();
      throw e;
    }
  }

  private async serve() {
    const site = join(root, "build", "web-scenarios");
    buildWeb(site);
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

  /** Until what every device shows stays the same for half a second. */
  async settle(ms = 15_000) {
    let last = "", since = Date.now();
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
      const now = JSON.stringify(await Promise.all(this.devices.map((d) => d.scene())));
      if (now !== last) [last, since] = [now, Date.now()];
      else if (Date.now() - since >= 500) return;
    }
    throw new Error("the devices did not settle");
  }

  async stop() {
    for (const b of this.browsers) await b.close().catch(() => {});
    for (const d of this.devices) if (d instanceof MacDevice) d.stop();
    for (const c of this.children) try { process.kill(-c.pid!, "SIGKILL"); } catch {}
    for (const d of this.dirs) rmSync(d, { recursive: true, force: true });
    this.web?.close();
  }
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
