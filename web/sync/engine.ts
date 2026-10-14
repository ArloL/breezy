// Pulls what changed after the store's cursor, merges it, and pushes what is pending, one cycle at a time, as
// BreezyKit's SyncEngine; see the sync design.
import { SpaceKeys } from "./crypto.ts";
import { encode, decode } from "./base64.ts";
import { FORMAT } from "./records.ts";
import type { SyncRecord } from "./records.ts";
import type { Held, Item, Store, StoreState } from "./store.ts";
import { steadyClock } from "./steady.ts";
import { planted } from "./plant.ts";

export const PAGE_SIZE = 500;
export const MAX_BLOB = 65536;
const MAX_REQUEST = 900_000;
const DEFLATE_ABOVE = 1024;
const STALE_MS = 1000;
/** A request whose answer has not begun this long after it went, plus a ms for every 20 bytes it sends, is given up on
 * and sent again at once: it is likely on a connection that a network change left dead, as the server answers in a
 * fraction of a second. */
const STALL_MS = 5000;
const STALLS = 2;

/** A sealed record as the server sends it, base64 id and blob. */
export interface Sealed {
  id: string;
  version: number;
  blob: string;
  stale?: boolean;
}

/** A pull's answer. */
export interface Page {
  records: Sealed[];
  cursor: number;
  epoch: string | null;
  relay?: unknown;
}

/** A push's answer, with a page when it pulled too. */
export interface PushResult {
  accepted: { id: string; version: number }[];
  refused: Sealed[];
  epoch: string | null;
  relay?: unknown;
  records?: Sealed[];
  cursor?: number;
}

export interface Write {
  id: string;
  base: number;
  blob: string;
}

export interface Transport {
  signal?: AbortSignal;
  pull(since: number): Promise<Page>;
  push(writes: Write[], since?: number, epoch?: string | null): Promise<PushResult>;
}

/** What the server took of a push, as another device may take it without a pull. */
export interface Pushed {
  version: number;
  epoch: string | null;
  records: Sealed[];
}

export type SyncState = "local" | "synced" | "offline" | "unreachable" | "notInSpace";

export interface Status {
  state: SyncState;
  at: number | null;
  waiting: number;
  unreadable: number;
  held: number;
  tooLong: number;
}

interface Decoded {
  items: Item[];
  held: (Held & { id: string })[];
  unreadable: number;
  failed: string[];
}

export class TransportError extends Error {
  kind: string;

  constructor(kind: string) {
    super(kind);
    this.kind = kind;
  }
}

/** `text` as raw DEFLATE, or null where the browser cannot make it. */
function deflateRaw(text: string): Promise<ArrayBuffer> | null {
  let stream;
  try {
    stream = new CompressionStream("deflate-raw");
  } catch {
    return null;
  }
  return new Response(new Blob([text]).stream().pipeThrough(stream)).arrayBuffer();
}

/** The server's two calls; see server/sync.php. */
export class HttpTransport implements Transport {
  server: string;
  space: string;
  token: string;
  signal?: AbortSignal;

  constructor(server: string, space: string, token: string) {
    this.server = server;
    this.space = space;
    this.token = token;
  }

  async send(query: { [k: string]: string | number }, body?: unknown) {
    const url = new URL(this.server);
    for (const [k, v] of Object.entries({ space: this.space, ...query })) url.searchParams.set(k, String(v));
    const headers: { [k: string]: string } = { Authorization: `Bearer ${this.token}` };
    let payload: string | ArrayBuffer | undefined;
    if (body) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
      // a browser that fails to deflate sends it plain, rather than failing every push from then on
      const deflated = payload.length > DEFLATE_ABOVE && (await deflateRaw(payload)?.catch(() => null));
      if (deflated) {
        payload = deflated;
        headers["Content-Encoding"] = "deflate";
      }
    }
    let res, stalled = false;
    // one controller for all three, as Safari before 17.4 lacks AbortSignal.any
    const abort = new AbortController();
    const stall = setTimeout(() => ((stalled = true), abort.abort()), STALL_MS + ((payload as ArrayBuffer | undefined)?.byteLength ?? (payload as string | undefined)?.length ?? 0) / 20);
    const timeout = setTimeout(() => abort.abort(), 20_000);
    const cancel = () => abort.abort();
    if (this.signal?.aborted) cancel();
    this.signal?.addEventListener("abort", cancel);
    try {
      res = await fetch(url, { method: body ? "POST" : "GET", headers, body: payload, signal: abort.signal });
    } catch {
      clearTimeout(timeout);
      throw new TransportError(globalThis.navigator?.onLine === false ? "offline" : stalled ? "stalled" : "unreachable");
    } finally {
      clearTimeout(stall);
      this.signal?.removeEventListener("abort", cancel);
    }
    try {
      if (res.status === 401) throw new TransportError("unauthorized");
      if (res.status === 413) throw new TransportError("tooLarge");
      if (!res.ok) throw new TransportError("unreachable");
      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  pull(since: number): Promise<Page> {
    return this.send({ since });
  }

  push(writes: Write[], since?: number, epoch?: string | null): Promise<PushResult> {
    return this.send({}, { writes, ...(since === undefined ? {} : { since }), ...(epoch === undefined ? {} : { epoch }) });
  }
}

/** A WebSocket over TLS, or plain to this computer for trying the relay out, as validServer has it. */
export function validRelay(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "wss:" || (u.protocol === "ws:" && ["localhost", "127.0.0.1"].includes(u.hostname));
  } catch {
    return false;
  }
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The status as the menus show it, a line each. */
export function statusLines(s: Status, now = Date.now()): string[] {
  const minutes = Math.floor((now - (s.at ?? now)) / 60_000);
  const out = [{
    local: "Not syncing",
    synced: minutes < 1 ? "Synced just now" : `Synced ${minutes} min ago`,
    offline: s.waiting ? `Offline — ${count(s.waiting, "change", "changes")} waiting` : "Offline",
    unreachable: "Can’t reach server",
    notInSpace: "Not in this space any more",
  }[s.state]];
  if (s.unreadable) out.push(count(s.unreadable, "unreadable change", "unreadable changes"));
  if (s.held) out.push("Update Breezy to see all changes");
  if (s.tooLong) out.push("Card too long to sync");
  return out;
}

export class SyncEngine {
  store: Store;
  makeTransport: (state: StoreState, keys: SpaceKeys) => Transport;
  now: () => number;
  clock: () => number;
  status: Status;
  onStatus: (status: Status) => void;
  /** Called before merging, so that edits not yet in the store get there first. */
  flushLocal: () => void;
  /** Whether a gesture others follow live is under way: what it changed so far waits for its end. */
  holdBack: () => boolean;
  /** Just before a push goes. */
  onPushing: () => void;
  /** Keeps the store as it is, so that a device ended before the push's answer knows what it sent. */
  persist: () => Promise<void>;
  /** The relay the server last named; null until it names one. */
  relay: string | null;
  onRelay: (relay: string | null) => void;
  /** After a push the server took: `{version, epoch, records}`, the highest version it gave and the accepted writes as
   * `{id, version, blob}`. */
  onPushed: (pushed: Pushed) => void;
  /** With the store's cursor once the records up to it are in: after each page taken, and after pushed records. */
  onPulled: (cursor: number) => void;
  /** When a cycle last ended synced, on `clock`. */
  lastCycle: number;
  running: Promise<void> | null;
  again: boolean;
  stopped: boolean;
  heldTried: boolean;
  failures: number;
  retryAt: number;
  tooLong: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  keys: SpaceKeys | null;
  keysFor: string | null;
  blocked: Set<string>;
  /** Aborts the requests of the cycle running, and when it began. */
  abort: AbortController | null;
  cycleAt: number;
  restarting: boolean;
  stalls: number;

  /** `now` is the wall clock, for when the status says it last synced; `clock` times back-offs and polling, and goes
   * neither back nor still: a wall clock set back would hold them back as long. Given `now` alone, it times both. */
  constructor(store: Store, { transport = (state: StoreState, keys: SpaceKeys): Transport => new HttpTransport(state.server!, state.space!, encode(keys.token)), now, clock }: { transport?: (state: StoreState, keys: SpaceKeys) => Transport; now?: () => number; clock?: () => number } = {}) {
    this.store = store;
    this.makeTransport = transport;
    this.now = now ?? (() => Date.now());
    this.clock = clock ?? now ?? steadyClock();
    this.status = { state: "local", at: null, waiting: 0, unreadable: 0, held: 0, tooLong: 0 };
    this.onStatus = () => {};
    this.flushLocal = () => {};
    this.holdBack = () => false;
    this.onPushing = () => {};
    this.persist = async () => {};
    this.relay = null;
    this.onRelay = () => {};
    this.onPushed = () => {};
    this.onPulled = () => {};
    this.lastCycle = -Infinity;
    this.running = null;
    this.again = false;
    this.stopped = false;
    this.heldTried = false;
    this.failures = 0;
    this.retryAt = 0;
    this.tooLong = 0;
    this.timer = undefined;
    this.keys = null;
    this.keysFor = null;
    this.blocked = new Set();
    this.abort = null;
    this.cycleAt = 0;
    this.restarting = false;
    this.stalls = 0;
  }

  /** One cycle; a call during a cycle runs another after it. */
  async sync(): Promise<void> {
    // this cycle, or the one after the one running, takes what changed so far
    clearTimeout(this.timer);
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.cycle();
      } while (this.again);
    })();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }

  /** A cycle a second from now, once however many changes come meanwhile. */
  changed() {
    // the gesture's end syncs
    if (this.holdBack()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sync(), 1000);
  }

  /** The network is back, or may have changed: a cycle now, without waiting out a back-off. When it `changed`, a
   * request of the cycle running that has taken over STALE_MS is given up on, as it may be on a connection the change
   * left dead. */
  retryNow(changed = true): Promise<void> | undefined {
    if (this.stopped) return;
    this.failures = 0;
    this.retryAt = 0;
    if (changed && this.running && this.clock() - this.cycleAt >= STALE_MS) {
      this.restarting = true;
      this.abort?.abort();
    }
    return this.sync();
  }

  /** Whether a change made now goes to the server at once, rather than after a back-off or a gesture's end. */
  pushesNow(): boolean {
    return this.store.syncing && !this.stopped && this.retryAt <= this.clock() && !this.holdBack();
  }

  /** Forgets a back-off and a refused token, as after joining a space. */
  reset() {
    this.failures = 0;
    this.retryAt = 0;
    this.stopped = false;
    this.heldTried = false;
    this.blocked.clear();
  }

  noteRelay(r: unknown): void {
    const relay = typeof r === "string" && validRelay(r) ? r : null;
    if (relay === this.relay) return;
    this.relay = relay;
    this.store.noteRelay(relay);
    this.onRelay(relay);
  }

  async keysOf({ space, secret }: StoreState): Promise<SpaceKeys> {
    const k = `${space}|${secret}`;
    if (this.keysFor !== k) {
      this.keys = await SpaceKeys.create(decode(space)!, decode(secret)!);
      this.keysFor = k;
    }
    return this.keys!;
  }

  async cycle(): Promise<void> {
    const state = this.store.state;
    if (!this.store.syncing) return this.update("local");
    if (this.stopped || this.retryAt > this.clock()) return;
    const space = state.space;
    const same = () => this.store.state.space === space;
    try {
      const keys = await this.keysOf(state);
      const transport = this.makeTransport(state, keys);
      this.abort = new AbortController();
      this.cycleAt = this.clock();
      transport.signal = this.abort.signal;
      this.restarting = false;
      this.flushLocal();
      if (!this.heldTried) {
        this.heldTried = true;
        if (!(await this.retryHeld(keys, same))) return;
      }
      this.flushLocal();
      const ready = this.store.state.resync || this.store.state.epoch == null || this.holdBack() ? null : await this.outgoing(keys);
      const combined = (ready?.writes.length ?? 0) > 0;
      let first = combined ? ready : null;
      if (!combined && !(await this.pullAll(transport, keys, same))) return;
      let refusals = 0;
      for (let round = 0; round < 10 && !this.holdBack(); round++) {
        this.flushLocal();
        const { writes, sent, blobs } = first ?? (await this.outgoing(keys));
        first = null;
        if (!writes.length) break;
        const request = combined ? this.store.state.cursor : undefined;
        this.store.sending(sent);
        await this.persist();
        if (!same()) return;
        const result = await transport.push(writes, request, combined ? this.store.state.epoch : undefined);
        if (!same()) return;
        if (this.store.noteEpoch(result.epoch)) {
          this.again = true;
          return;
        }
        for (const a of result.accepted) if (sent.has(a.id)) this.store.accepted(a.id, a.version, sent.get(a.id)!);
        this.noteRelay(result.relay);
        if (result.accepted.length) {
          const records = result.accepted.filter((a) => blobs.has(a.id)).map((a) => ({ id: a.id, version: a.version, blob: blobs.get(a.id)! }));
          this.onPushed({ version: Math.max(...result.accepted.map((a) => a.version)), epoch: result.epoch, records });
        }
        if (result.refused.length) {
          const decoded = await this.decodeAll(result.refused, keys);
          this.flushLocal();
          if (!same()) return;
          this.apply(decoded);
          for (const id of decoded.failed) this.blocked.add(id);
          if (decoded.items.length && ++refusals === 3) throw new TransportError("unreachable");
        }
        if (combined && result.records) {
          const own = result.accepted.filter((a) => a.version > request! && a.version <= result.cursor!).length;
          const taken = await this.takePage(result as Page, keys, same, own);
          if (taken === "stop") return;
          if (taken === "again") {
            this.again = true;
            return;
          }
          this.onPulled(this.store.state.cursor);
          if (taken === "more" && !(await this.pullAll(transport, keys, same))) return;
        }
      }
      this.failures = 0;
      this.retryAt = 0;
      this.stalls = 0;
      this.lastCycle = this.clock();
      this.update("synced");
    } catch (e) {
      const error = e as { kind?: unknown } | null | undefined;
      if (!same()) return;
      if (error?.kind === "unauthorized") {
        this.stopped = true;
        return this.update("notInSpace");
      }
      if (this.restarting || (error?.kind === "stalled" && this.stalls++ < STALLS)) {
        this.restarting = false;
        this.again = true;
        return;
      }
      if (!(error instanceof TransportError)) console.warn("sync failed", error);
      this.failures++;
      this.retryAt = this.clock() + Math.min(60, 5 * 2 ** (this.failures - 1)) * 1000;
      this.update(error?.kind === "offline" ? "offline" : "unreachable");
    }
  }

  /** Applies the records another device just pushed, as the page after the cursor, without a pull; false, changing
   * nothing, when they do not follow on from what this one has. */
  async receivePushed({ epoch, records }: { epoch?: unknown; records?: unknown } = {}): Promise<boolean> {
    while (this.running) await this.running.catch(() => {});
    const state = this.store.state;
    if (!this.store.syncing || state.resync || state.epoch == null || epoch !== state.epoch) return false;
    if (!Array.isArray(records) || !records.length) return false;
    const page: Sealed[] = records.map(({ id, version, blob }) => ({ id, version, blob }));
    if (!page.every((r) => typeof r.id === "string" && typeof r.blob === "string" && Number.isSafeInteger(r.version))) return false;
    page.sort((x, y) => x.version - y.version);
    if (page.some((r, i) => i && r.version !== page[i - 1].version + 1) || state.cursor < page[0].version - 1) return false;
    const last = page.at(-1)!.version;
    if (state.cursor >= last) {
      this.onPulled(state.cursor);
      return true;
    }
    let ok = false;
    this.running = (async () => {
      try {
        const keys = await this.keysOf(state);
        const same = () => this.store.state.space === state.space && this.store.state.epoch === epoch;
        this.flushLocal();
        const decoded = await this.decodeAll(page, keys);
        this.flushLocal();
        if (same()) {
          if (!planted("pushed-skip")) this.apply(decoded);
          this.store.advance(last);
          this.onPulled(this.store.state.cursor);
          ok = true;
        }
      } catch (error) {
        console.warn("pushed records failed", error);
      }
      while (this.again) {
        this.again = false;
        await this.cycle();
      }
    })();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
    return ok;
  }

  /** Takes a page of records: "stop" if the space changed, "again" if the epoch did, "more" if the page was full, counting `own` writes left out of it. */
  async takePage(page: Page, keys: SpaceKeys, same: () => boolean, own = 0): Promise<"stop" | "again" | "done" | "more"> {
    if (!same()) return "stop";
    this.noteRelay(page.relay);
    if (this.store.noteEpoch(page.epoch)) return "again";
    const decoded = await this.decodeAll(page.records, keys);
    this.flushLocal();
    if (!same()) return "stop";
    this.apply(decoded);
    this.store.advance(page.cursor);
    return page.records.length + own < PAGE_SIZE ? "done" : "more";
  }

  /** Pulls to the end; false if the space changed meanwhile. */
  async pullAll(transport: Transport, keys: SpaceKeys, same: () => boolean): Promise<boolean> {
    for (;;) {
      const taken = await this.takePage(await transport.pull(this.store.state.cursor), keys, same);
      if (taken === "stop") return false;
      if (taken !== "again") this.onPulled(this.store.state.cursor);
      if (taken === "done") {
        this.store.resynced();
        return true;
      }
    }
  }

  /** Opens one record without touching the store: an item, a hold or an unreadable. */
  async decodeOne(p: Sealed, keys: SpaceKeys): Promise<{ item?: Item; held?: Held & { id: string }; unreadable?: true }> {
    let record;
    try {
      record = JSON.parse(new TextDecoder().decode(await keys.open(decode(p.blob)!, decode(p.id)!))) as SyncRecord | null;
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("not a record");
    } catch {
      return { unreadable: true };
    }
    if ((record.format ?? 0) > FORMAT) return { held: { id: p.id, version: p.version, blob: p.blob } };
    return { item: { id: p.id, version: p.version, record, stale: p.stale === true } };
  }

  async decodeAll(records: Sealed[], keys: SpaceKeys): Promise<Decoded> {
    const out: Decoded = { items: [], held: [], unreadable: 0, failed: [] };
    for (const p of records) {
      const r = await this.decodeOne(p, keys);
      if (r.item) out.items.push(r.item);
      else {
        out.failed.push(p.id);
        if (r.held) out.held.push(r.held);
        else out.unreadable++;
      }
    }
    return out;
  }

  apply({ items, held, unreadable }: Decoded): void {
    for (const h of held) this.store.hold(h.id, h.version, h.blob);
    for (let i = 0; i < unreadable; i++) this.store.noteUnreadable();
    this.store.merge(items);
  }

  /** Records held for a newer Breezy, which this one may now read; false if the space changed meanwhile. */
  async retryHeld(keys: SpaceKeys, same: () => boolean): Promise<boolean> {
    const ids = Object.keys(this.store.state.held);
    const decoded = await this.decodeAll(ids.map((id) => ({ id, ...this.store.state.held[id] })), keys);
    if (!same()) return false;
    for (const id of ids) this.store.release(id);
    this.apply(decoded);
    return true;
  }

  async outgoing(keys: SpaceKeys): Promise<{ writes: Write[]; sent: Map<string, SyncRecord>; blobs: Map<string, string> }> {
    // before reading what is pending, so that a push holds every edit sent before it began
    this.onPushing();
    const writes: Write[] = [], sent = new Map<string, SyncRecord>(), blobs = new Map<string, string>();
    let size = 0;
    this.tooLong = 0;
    for (const p of this.store.pending()) {
      if (this.blocked.has(p.id)) continue;
      const id = decode(p.id);
      if (id?.length !== 16) continue;
      const blob = await keys.seal(new TextEncoder().encode(JSON.stringify(p.record)), id);
      if (blob.length > MAX_BLOB) {
        this.tooLong++;
        continue;
      }
      const w = { id: p.id, base: p.base, blob: encode(blob) };
      size += w.blob.length + 64;
      if (size > MAX_REQUEST) break;
      writes.push(w);
      sent.set(p.id, p.record);
      blobs.set(p.id, w.blob);
    }
    return { writes, sent, blobs };
  }

  update(state: SyncState): void {
    this.status = {
      state, at: state === "synced" ? this.now() : this.status.at, waiting: this.store.pending().length,
      unreadable: this.store.state.unreadable, held: Object.keys(this.store.state.held).length, tooLong: this.tooLong,
    };
    this.onStatus(this.status);
  }
}
