// Safari on the iOS Simulator as a scenario device, through safaridriver's WebDriver: it loads the app from this Mac's
// localhost, keeps a service worker and IndexedDB as an iPhone does, and shows the board. It watches only: its touches
// come through WebDriver a quarter second apart, as a hold or a double tap never would. scripts/ios.ts boots the
// simulator and starts safaridriver.
import { Device, type Editor, type PointerPhase, type Scene } from "./device.ts";
import type { Point } from "../web/types.ts";

export const SAFARIDRIVER = "http://127.0.0.1:4723";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Why Safari on the iOS Simulator cannot run cases here, if it cannot. */
export async function iosUnfit(): Promise<string | false> {
  const ok = await fetch(`${SAFARIDRIVER}/status`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json(), () => null) as { value?: { ready?: boolean } } | null;
  return ok?.value?.ready ? false : "no safaridriver: run node scripts/ios.ts";
}

/** One WebDriver session's page, with what the scenarios ask of a Playwright Page. */
export class IosPage {
  private readonly id: string;
  /** Safari's and iOS's versions. */
  readonly version: string;

  private constructor(id: string, version: string) {
    this.id = id;
    this.version = version;
  }

  /** A session in Safari on the simulator scripts/ios.ts booted. */
  static async open(): Promise<IosPage> {
    const s = await IosPage.call("POST", "/session", { capabilities: { alwaysMatch: { browserName: "safari", platformName: "iOS", "safari:useSimulator": true } } }, 120_000);
    const c = s.capabilities ?? {};
    return new IosPage(s.sessionId, `Safari ${c.browserVersion} on ${c["safari:deviceName"]}, iOS ${c["safari:platformVersion"]}`);
  }

  private static async call(method: string, path: string, body?: unknown, ms = 60_000) {
    const res = await fetch(`${SAFARIDRIVER}${path}`, {
      method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(ms),
    });
    const { value } = await res.json() as { value: { error?: string; message?: string } & Record<string, unknown> };
    if (!res.ok) throw new Error(`safaridriver ${method} ${path}: ${value?.error} ${value?.message ?? ""}`.trim());
    return value as any;
  }

  private call(method: string, path: string, body?: unknown, ms?: number) {
    return IosPage.call(method, `/session/${this.id}${path}`, body, ms);
  }

  async goto(url: string) {
    await this.call("POST", "/url", { url });
  }

  /** `f` run in the page with `arg`, its promise awaited, as Playwright's evaluate. */
  async evaluate<R, A>(f: (arg: A) => R | Promise<R>, arg?: A): Promise<R> {
    return this.call("POST", "/execute/sync", { script: `return (${f.toString()}).apply(null, arguments)`, args: arg === undefined ? [] : [arg] });
  }

  async waitForSelector(selector: string, { timeout = 30_000 }: { timeout?: number } = {}) {
    for (const end = Date.now() + timeout; ; await sleep(100)) {
      if (await this.evaluate((s) => !!document.querySelector(s), selector)) return;
      if (Date.now() > end) throw new Error(`timed out waiting for ${selector}`);
    }
  }

  async waitForFunction(f: () => unknown, _arg?: unknown, { timeout = 30_000 }: { timeout?: number } = {}) {
    for (const end = Date.now() + timeout; ; await sleep(100)) {
      if (await this.evaluate(f)) return;
      if (Date.now() > end) throw new Error("timed out waiting for a function");
    }
  }

  async fill(selector: string, value: string) {
    await this.evaluate(([s, v]) => {
      const e = document.querySelector<HTMLInputElement>(s)!;
      e.value = v;
      e.dispatchEvent(new Event("input", { bubbles: true }));
    }, [selector, value] as const);
  }

  /** The simulator's screen as a PNG. */
  async screenshot(): Promise<Buffer> {
    return Buffer.from(await this.call("GET", "/screenshot") as string, "base64");
  }

  async close() {
    await this.call("DELETE", "", undefined, 20_000);
  }
}

export class IosDevice extends Device {
  readonly kind = "ios-safari";
  readonly page: IosPage;
  private readonly fns: { scene: () => Scene; editor: () => Editor | null; weights: (id: string) => number[] | null };

  constructor(page: IosPage, fns: IosDevice["fns"]) {
    super();
    this.page = page;
    this.fns = fns;
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

  private watches(): never {
    throw new Error("Safari on the iOS Simulator only watches: its touches come too slowly through WebDriver");
  }

  async pointer(_phase: PointerPhase, _p: Point) {
    this.watches();
  }

  async key() {
    this.watches();
  }

  async addCard(): Promise<string> {
    this.watches();
  }

  async addLane(): Promise<string> {
    this.watches();
  }
}
