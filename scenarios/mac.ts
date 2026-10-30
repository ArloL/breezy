// The Debug Mac app as a scenario device: started with -BreezyControl in a store of its own, its input sent to the
// board window as events and its scene read off the canvas. See Breezy/Support/Control.swift.
import { spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { randomBytes } from "node:crypto";
import { Device, type Editor, type PointerExtra, type PointerPhase, type Scene } from "./device.ts";
import type { Point } from "../web/types.ts";
import type { Recording } from "../web/flight.ts";

const root = new URL("..", import.meta.url).pathname;
export const MAC_APP = join(root, "build/Build/Products/Debug/Breezy.app/Contents/MacOS/Breezy");

/** Why the Debug Mac app cannot stand for this checkout, if it cannot: not built, or older than one of its sources, as
 * a build from a week before once ran the cases unnoticed. */
export function macUnfit(): string | false {
  if (!existsSync(MAC_APP)) return "the Debug Mac app is not built";
  const built = statSync(MAC_APP).mtimeMs;
  // its Swift sources alone: a Finder's .DS_Store is none, and the app links BreezyKit, not the fuzzer's targets
  const newer = (dir: string): string | undefined => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      const found = e.isDirectory() ? newer(path) : e.name.endsWith(".swift") && statSync(path).mtimeMs > built ? path : undefined;
      if (found) return found;
    }
  };
  const source = newer(join(root, "Breezy")) ?? newer(join(root, "BreezyKit", "Sources", "BreezyKit"));
  return source ? `the Debug Mac app is older than ${relative(root, source)}: build it again` : false;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MacDevice extends Device {
  readonly kind = "mac";
  private readonly app: ChildProcess;
  private readonly store: string;
  private socket!: Socket;
  private buffer = "";
  private waiting: ((line: string) => void)[] = [];

  private constructor(app: ChildProcess, store: string) {
    super();
    this.app = app;
    this.store = store;
  }

  /** The app on control port `port`, as device `name`. */
  static async start(port: number, name: string): Promise<MacDevice> {
    const store = mkdtempSync(join(tmpdir(), "breezy-scenario-mac-"));
    const app = spawn(MAC_APP, [
      "-ApplePersistenceIgnoreState", "YES", "-BreezyStore", store, "-BreezyControl", String(port),
      "-BreezyDevice", randomBytes(16).toString("base64url"), "-BreezyName", name,
    ], { stdio: "ignore" });
    const d = new MacDevice(app, store);
    for (let i = 0; ; i++) {
      try {
        d.socket = await new Promise<Socket>((resolve, reject) => {
          const s = connect(port, "127.0.0.1", () => resolve(s));
          s.once("error", reject);
        });
        break;
      } catch (e) {
        if (i > 100 || app.exitCode !== null) {
          // no world holds it yet to stop it
          app.kill("SIGKILL");
          rmSync(store, { recursive: true, force: true });
          throw new Error(`the Mac app did not take commands: ${e}`);
        }
        await sleep(100);
      }
    }
    d.socket.setEncoding("utf8");
    d.socket.on("data", (chunk: string) => {
      d.buffer += chunk;
      for (let nl; (nl = d.buffer.indexOf("\n")) >= 0; ) {
        const line = d.buffer.slice(0, nl);
        d.buffer = d.buffer.slice(nl + 1);
        d.waiting.shift()?.(line);
      }
    });
    return d;
  }

  async command<T = unknown>(c: Record<string, unknown>): Promise<T> {
    const line = new Promise<string>((r) => this.waiting.push(r));
    this.socket.write(`${JSON.stringify(c)}\n`);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`mac: no answer to ${c.cmd} in 10 s`)), 10_000)));
    const answer = JSON.parse(await Promise.race([line, late]).finally(() => clearTimeout(timer))) as { reply?: T; error?: string };
    if (answer.error) throw new Error(`mac: ${answer.error}`);
    return answer.reply as T;
  }

  async scene(): Promise<Scene> {
    const s = await this.command<Scene | null>({ cmd: "scene" });
    if (!s) throw new Error("the Mac shows no board");
    return s;
  }

  async wait(ms: number) {
    await sleep(ms);
  }

  async pointer(phase: PointerPhase, p: Point, extra: PointerExtra = {}) {
    await this.command({ cmd: "pointer", phase, x: p.x, y: p.y, ...extra });
  }

  private async made(before: Scene, kind: "cards" | "lanes") {
    const had = new Set(before[kind].map((x) => x.id));
    for (const end = Date.now() + 5000; Date.now() < end; await sleep(50)) {
      const id = (await this.scene())[kind].find((x) => !had.has(x.id))?.id;
      if (id) return id;
    }
    throw new Error(`no new item in ${kind}`);
  }

  /** By key code, as AppKit has them on a US layout. */
  static readonly codes: Record<string, [string, number]> = {
    "1": ["1", 18], "2": ["2", 19], "3": ["3", 20], "4": ["4", 21], "5": ["5", 23], " ": [" ", 49], Backspace: ["\u007f", 51],
    Escape: ["\u001b", 53], Enter: ["\r", 36], z: ["z", 6], a: ["a", 0], l: ["l", 37], c: ["c", 8], x: ["x", 7], v: ["v", 9],
    f: ["f", 3], Delete: ["\uf728", 117],
    ArrowLeft: ["\uf702", 123], ArrowRight: ["\uf703", 124], ArrowDown: ["\uf701", 125], ArrowUp: ["\uf700", 126],
  };

  async key(key: string, mods: { meta?: boolean; shift?: boolean } = {}): Promise<void | "disabled"> {
    const k = MacDevice.codes[key];
    if (!k) throw new Error(`no key code for ${key}`);
    const r = await this.command<{ disabled?: boolean } | null>({ cmd: "key", chars: k[0], code: k[1], command: !!mods.meta, shift: !!mods.shift });
    if (r?.disabled) return "disabled";
  }

  override get edits() {
    return true;
  }

  /** What its menus say of the sync, a line for each space. */
  override async syncStatus() {
    return (await this.command<string[]>({ cmd: "status" })).join("\n");
  }

  override async unpushed() {
    const lines = await this.command<string[]>({ cmd: "status" });
    return lines.reduce((n, l) => n + Number(/pending (\d+)/.exec(l)?.[1] ?? 0), 0);
  }

  override get draws() {
    return true;
  }

  override async editor() {
    return this.command<Editor | null>({ cmd: "editor" });
  }

  /** NSPasteboard.general, which every app shares, read and written in the app: pbpaste reads no HTML. */
  override async clipboard() {
    return (await this.command<{ text: string }>({ cmd: "pasteboard" })).text;
  }

  override async clipboardHTML() {
    return (await this.command<{ html: string }>({ cmd: "pasteboard" })).html;
  }

  override async putOnClipboard(html: string, text: string) {
    await this.command({ cmd: "pasteboard", html, text });
  }

  /** What the open board's canvas recorded, in the web app's format (BreezyKit's Flight). */
  override async flight() {
    return this.command<Recording | null>({ cmd: "flight" });
  }

  /** A card at rest is drawn from `Typo.front(text)` alone. */
  override async weights() {
    return null;
  }

  override async type(text: string) {
    await this.command({ cmd: "type", text });
  }

  override async typeInto(id: string, text: string) {
    const r = (await this.scene()).cards.find((c) => c.id === id);
    if (!r) throw new Error(`nothing shows ${id}`);
    const p = await this.screen({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    await this.pointer("down", p);
    await this.pointer("up", p);
    await this.pointer("down", p, { clicks: 2 });
    await this.pointer("up", p, { clicks: 2 });
    await this.command({ cmd: "type", text, atEnd: true });
    await this.command({ cmd: "key", chars: "\u001b", code: 53 });
  }

  /** As a person makes one: a double-click, a title, and Esc. */
  async addCard(x: number, y: number): Promise<string> {
    const before = await this.scene();
    const p = await this.screen({ x, y });
    await this.pointer("down", p);
    await this.pointer("up", p);
    await this.pointer("down", p, { clicks: 2 });
    await this.pointer("up", p, { clicks: 2 });
    await this.command({ cmd: "type", text: "card" });
    await this.command({ cmd: "key", chars: "\u001b", code: 53 });
    return this.made(before, "cards");
  }

  /** The toolbar's New Lane, which puts it in the open spot nearest the middle of the view, wherever (x, y) is. */
  async addLane(): Promise<string> {
    const before = await this.scene();
    await this.command({ cmd: "newLane" });
    return this.made(before, "lanes");
  }

  /** The app ended at once, for a world that never stopped. */
  kill() {
    this.socket?.destroy();
    this.app.kill("SIGKILL");
  }

  /** Once the app has quit, so that the next one can take its control port; it is killed if it has not in 5 s. */
  async stop() {
    this.socket?.destroy();
    if (this.app.exitCode === null && this.app.signalCode === null) {
      const exited = new Promise((r) => this.app.once("exit", r));
      this.app.kill();
      if (!(await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]))) {
        this.app.kill("SIGKILL");
        await exited;
      }
    }
    rmSync(this.store, { recursive: true, force: true });
  }
}
