// Devices that share a space, on the fuzz hub's virtual time with a good network, for scenarios: one device acts as a
// person would, through its input, and the test looks at what another one shows.
import { Hub, type Device as HubDevice, type Op } from "../scripts/fuzz/hub.ts";
import { LANE_H, LANE_W } from "../web/rules.ts";
import * as V from "../scripts/fuzz/virtual.ts";
import type { Board, Point } from "../web/types.ts";
import type { Invite } from "../web/sync/crypto.ts";
import { ANDROID, PHONE, type Screen } from "../web/test/fakes.ts";
import { Device, type PointerExtra, type PointerPhase, type Scene, type Sight } from "./device.ts";

export * from "./device.ts";

/** The plant a run was started with: read once, as a hub started with a plant sets BREEZY_PLANT for its Swift devices. */
const PLANT = process.env.BREEZY_PLANT ?? null;

/** A phone is a web device with an iPhone's screen and keyboard, an android one with the partner's Android's. */
export type Kind = "web" | "swift" | "phone" | "android";
/** The screen of each kind of phone. */
export const PHONES: Partial<Record<Kind, Screen>> = { phone: PHONE, android: ANDROID };

export class SimDevice extends Device {
  readonly sim: World;
  readonly hub: Hub;
  readonly d: HubDevice;
  readonly kind: Kind;

  constructor(world: World, d: HubDevice, kind: Kind) {
    super();
    this.sim = world;
    this.hub = world.hub;
    this.d = d;
    this.kind = kind;
  }

  override async size() {
    const screen = PHONES[this.kind];
    return screen ? { w: screen.w, h: screen.h } : super.size();
  }

  /** Until the camera has stopped and no keyboard is on its way. */
  override async still(what: string) {
    if (this.d.kind === "web") await this.until(what, async () => (await this.hub.command(this.d, { cmd: "still" })) === true);
  }

  override async sight(): Promise<Sight | null> {
    return this.d.kind === "web" ? (await this.hub.command(this.d, { cmd: "sight" })) as Sight | null : null;
  }

  async wait(ms: number) {
    await this.sim.wait(ms);
  }

  async op<T = unknown>(o: Op): Promise<T> {
    return (await this.hub.op(this.d, o)) as T;
  }

  async addCard(x: number, y: number): Promise<string> {
    return (await this.op<{ id: string }>({ op: "addCard", x, y })).id;
  }

  async addLane(x: number, y: number): Promise<string> {
    // the op takes the top left
    return (await this.op<{ id: string }>({ op: "addLane", x: x - LANE_W / 2, y: y - LANE_H / 2 })).id;
  }

  async scene(): Promise<Scene> {
    const s = (await this.hub.command(this.d, { cmd: "scene" })) as Scene | null;
    if (!s) throw new Error(`device ${this.d.i} (${this.kind}) shows no board`);
    return s;
  }

  async board(): Promise<Board> {
    const snap = await this.hub.command(this.d, { cmd: "state" });
    return snap.boards[this.sim.boardID] as Board;
  }

  override get edits() {
    return this.d.kind === "web";
  }

  override async type(text: string) {
    await this.op({ op: "text", text });
    // the board keeps the editor in sight of the keyboard, which opened with it; a tap while it moves only stops it
    if (PHONES[this.kind]) await this.still("the keyboard to open and the board to stand still");
  }

  /** As a person edits one with a mouse: a double-click, the keys, and Esc. */
  override async typeInto(id: string, text: string) {
    const r = (await this.scene()).cards.find((c) => c.id === id);
    if (!r) throw new Error(`nothing shows ${id}`);
    const p = await this.screen({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    await this.pointer("down", p);
    await this.pointer("up", p);
    await this.pointer("down", p, { clicks: 2 });
    await this.pointer("up", p, { clicks: 2 });
    await this.type(text);
    await this.key("Escape");
  }

  async key(key: string, mods: { meta?: boolean; shift?: boolean } = {}) {
    await this.op({ op: "key", key, ...mods });
  }

  async pointer(phase: PointerPhase, p: Point, extra: PointerExtra = {}) {
    await this.op({ op: "pointer", phase, x: p.x, y: p.y, ...extra });
  }
}

export class World {
  readonly hub: Hub;
  readonly devices: SimDevice[] = [];
  boardID = "";

  private constructor(hub: Hub) {
    this.hub = hub;
  }

  /** Devices of `kinds`, in that order, in one space with one board that all of them show. */
  static async start(kinds: Kind[], seed = 1, plant: string | null = PLANT): Promise<World> {
    const swift = kinds.filter((k) => k === "swift").length;
    const hub = new Hub({ seed, web: kinds.length - swift, swift, profile: "lan", faults: false, steps: 0, plant });
    const w = new World(hub);
    try {
      await hub.start();
      // the hub orders its devices by kind; give them back in the order asked for
      const pool = [...hub.devices];
      for (const k of kinds) {
        const at = pool.findIndex((d) => d.kind === (k === "swift" ? "swift" : "web"));
        const d = new SimDevice(w, pool.splice(at, 1)[0]!, k);
        const screen = PHONES[k];
        if (screen) await hub.command(d.d, { cmd: "screen", screen });
        w.devices.push(d);
      }
      const [first, ...others] = w.devices;
      const { invite } = await first!.op<{ invite: Invite }>({ op: "newSpace", server: hub.server.url, name: "Scenario" });
      w.boardID = (await first!.op<{ board: string }>({ op: "createBoard", title: "Board" })).board;
      for (const d of others) await d.op({ op: "join", invite });
      await w.wait(3000);
      for (const d of w.devices) await d.op({ op: "open", board: w.boardID });
      await w.wait(3000);
      return w;
    } catch (e) {
      hub.stop();
      throw e;
    }
  }

  /** Lets `ms` of virtual time pass. */
  async wait(ms: number) {
    await this.hub.runUntil(V.now + ms);
  }

  /** Long enough for what one device did to reach and show on the others. */
  async settle() {
    await this.wait(5000);
  }

  stop() {
    this.hub.stop();
  }
}
