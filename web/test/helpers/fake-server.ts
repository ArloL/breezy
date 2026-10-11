import { Store } from "../../sync/store.ts";
import { SyncEngine, PAGE_SIZE, TransportError } from "../../sync/engine.ts";
import { changes, boardRecord } from "../../sync/records.ts";
import { encode } from "../../sync/base64.ts";
import { newID } from "../../rules.ts";
import type { Board } from "../../types.ts";
import type { Page, PushResult, Sealed as ServerRecord, Transport, Write } from "../../sync/engine.ts";

type Pulled = Page;
type Pushed = PushResult;
type Snapshot = { records: Map<string, ServerRecord>; written: Map<string, string>; version: number };

/** The server's rules, in memory. */
export class FakeServer {
  records: Map<string, ServerRecord>;
  written: Map<string, string>;
  version: number;
  epoch: string | null;
  relay: string | null;
  afterWrites: () => void;

  constructor() {
    this.records = new Map();
    /** The epoch each record was written in. */
    this.written = new Map();
    this.version = 0;
    /** Null until the space's first write, and again after `wipe`. */
    this.epoch = null;
    /** The relay the server names, if any. */
    this.relay = null;
    /** Runs after a push's writes and before it reads, as another device's write might land. */
    this.afterWrites = () => {};
  }

  marked(r: ServerRecord): ServerRecord {
    return this.written.get(r.id) === this.epoch ? r : { ...r, stale: true };
  }

  pull(since: number): Pulled {
    const records = [...this.records.values()].filter((r) => r.version > since).sort((a, b) => a.version - b.version).slice(0, PAGE_SIZE);
    return { records: records.map((r) => this.marked(r)), cursor: records.at(-1)?.version ?? since, epoch: this.epoch, ...(this.relay ? { relay: this.relay } : {}) };
  }

  push(writes: Write[], since?: number, epoch?: string | null): Pushed {
    if (epoch !== undefined && epoch !== this.epoch) return { accepted: [], refused: [], epoch: this.epoch, ...(this.relay ? { relay: this.relay } : {}) };
    const accepted: Pushed["accepted"] = [], refused: ServerRecord[] = [];
    this.epoch ??= newID();
    for (const w of writes) {
      const stored = this.records.get(w.id);
      if (stored && stored.version !== w.base) {
        refused.push(this.marked(stored));
        continue;
      }
      this.put(w.id, w.blob);
      accepted.push({ id: w.id, version: this.version });
    }
    const out = { accepted, refused, epoch: this.epoch, ...(this.relay ? { relay: this.relay } : {}) };
    this.afterWrites();
    if (since === undefined) return out;
    const own = new Set(accepted.map((a) => a.version));
    const rows = [...this.records.values()].filter((r) => r.version > since).sort((a, b) => a.version - b.version).slice(0, PAGE_SIZE);
    const last = rows.at(-1)?.version ?? 0;
    return { ...out, cursor: rows.length === PAGE_SIZE ? last : Math.max(this.version, last, since), records: rows.filter((r) => !own.has(r.version)).map((r) => this.marked(r)) };
  }

  /** The database as a backup holds it. */
  snapshot(): Snapshot {
    return { records: new Map(this.records), written: new Map(this.written), version: this.version };
  }

  /** The backup put back, with a new epoch as the README says to give it. */
  restore({ records, written, version }: Snapshot) {
    Object.assign(this, { records: new Map(records), written: new Map(written), version, epoch: newID() });
  }

  /** The space lost. */
  wipe() {
    Object.assign(this, { records: new Map(), written: new Map(), version: 0, epoch: null });
  }

  /** Adds a record as another device would. */
  put(id: string, blob: string) {
    this.epoch ??= newID();
    this.records.set(id, { id, version: ++this.version, blob });
    this.written.set(id, this.epoch);
  }
}

export class FakeTransport implements Transport {
  server: FakeServer;
  online: boolean;
  failure: string | null;
  calls: number;
  log: string[];
  beforePush: () => Promise<unknown>;

  constructor(server: FakeServer) {
    this.server = server;
    this.online = true;
    this.failure = null;
    this.calls = 0;
    /** The calls made, by name. */
    this.log = [];
    /** Runs before each push, as another device might sync meanwhile. */
    this.beforePush = async () => {};
  }

  check(name: string) {
    this.calls++;
    this.log.push(name);
    if (this.failure) throw new TransportError(this.failure);
    if (!this.online) throw new TransportError("offline");
  }

  async pull(since: number) {
    this.check("pull");
    return structuredClone(this.server.pull(since));
  }

  async push(writes: Write[], since?: number, epoch?: string | null) {
    await this.beforePush();
    this.check("push");
    return structuredClone(this.server.push(writes, since, epoch));
  }
}

export const SERVER = "https://example.com/breezy/sync.php";

export function device(server: FakeServer, invite?: Parameters<Store["join"]>[0] | null) {
  const store = new Store();
  const transport = new FakeTransport(server);
  const engine = new SyncEngine(store, { transport: () => transport });
  if (invite) store.join(invite);
  const edit = (id: string, change: (board: Board) => void) => {
    const old = store.board(id);
    const now = structuredClone(old);
    change(now);
    store.apply(changes(old, now, id, store.orders(id)));
  };
  return { store, transport, engine, edit };
}

/** Two devices in one space with a board holding one card, both synced; `ids` names the board and the card. */
export async function pair(ids: () => string) {
  const server = new FakeServer();
  const a = device(server);
  const invite = a.store.startSyncing(SERVER);
  const id = ids();
  const contents: Board = { cards: [{ id: ids(), x: 0, y: 0, w: 240, text: "x", color: 1 }], lanes: [] };
  a.store.apply({ ...changes({ cards: [], lanes: [] }, contents, id, {}), [id]: { fields: boardRecord("Plans") } });
  await a.engine.sync();
  const b = device(server, invite);
  await b.engine.sync();
  return { server, a, b, id };
}

export function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ids from a seeded generator, so that a run replays. */
export function seededIDs(seed: number) {
  const rnd = mulberry(seed);
  return () => encode(Uint8Array.from({ length: 16 }, () => Math.floor(rnd() * 256)));
}
