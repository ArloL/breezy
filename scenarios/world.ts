// Devices that share a space, on the fuzz hub's virtual time with a good network, for scenarios: one device acts as a
// person would, through its input, and the test looks at what another one shows.
import { Hub, type Device as HubDevice, type Op } from "../scripts/fuzz/hub.ts";
import { LANE_H, LANE_W } from "../web/rules.ts";
import * as V from "../scripts/fuzz/virtual.ts";
import type { Board, Point } from "../web/types.ts";
import type { Invite } from "../web/sync/crypto.ts";
import { Device, type PointerExtra, type PointerPhase, type Scene } from "./device.ts";

export * from "./device.ts";

export type Kind = "web" | "swift";

export class SimDevice extends Device {
  readonly sim: World;
  readonly hub: Hub;
  readonly d: HubDevice;

  constructor(world: World, d: HubDevice) {
    super();
    this.sim = world;
    this.hub = world.hub;
    this.d = d;
  }

  get kind(): Kind {
    return this.d.kind;
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

  override get keys() {
    return this.kind === "web";
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
  static async start(kinds: Kind[], seed = 1): Promise<World> {
    const web = kinds.filter((k) => k === "web").length;
    const hub = new Hub({ seed, web, swift: kinds.length - web, profile: "lan", faults: false, steps: 0 });
    const w = new World(hub);
    try {
      await hub.start();
      // the hub orders its devices by kind; give them back in the order asked for
      const pool = [...hub.devices];
      for (const k of kinds) {
        const at = pool.findIndex((d) => d.kind === k);
        w.devices.push(new SimDevice(w, pool.splice(at, 1)[0]!));
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
