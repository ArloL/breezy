// Pulls what changed after the store's cursor, merges it, and pushes what is pending, one cycle at a time, as
// BreezyKit's SyncEngine; see the sync design.
import { SpaceKeys } from "./crypto.js";
import { encode, decode } from "./base64.js";
import { FORMAT } from "./records.js";

export const PAGE_SIZE = 500;
export const MAX_BLOB = 65536;
const MAX_REQUEST = 900_000;

export class TransportError extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind;
  }
}

/** The server's two calls; see server/sync.php. */
export class HttpTransport {
  constructor(server, space, token) {
    this.server = server;
    this.space = space;
    this.token = token;
  }

  async send(query, body) {
    const url = new URL(this.server);
    for (const [k, v] of Object.entries({ space: this.space, ...query })) url.searchParams.set(k, v);
    let res;
    try {
      res = await fetch(url, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${this.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new TransportError(globalThis.navigator?.onLine === false ? "offline" : "unreachable");
    }
    if (res.status === 401) throw new TransportError("unauthorized");
    if (res.status === 413) throw new TransportError("tooLarge");
    if (!res.ok) throw new TransportError("unreachable");
    return res.json();
  }

  pull(since) {
    return this.send({ since });
  }

  push(writes) {
    return this.send({}, { writes });
  }
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The status as the menus show it, a line each. */
export function statusLines(s, now = Date.now()) {
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
  constructor(store, { transport = (state, keys) => new HttpTransport(state.server, state.space, encode(keys.token)), now = () => Date.now() } = {}) {
    this.store = store;
    this.makeTransport = transport;
    this.now = now;
    this.status = { state: "local", at: null, waiting: 0, unreadable: 0, held: 0, tooLong: 0 };
    this.onStatus = () => {};
    /** Called before merging, so that edits not yet in the store get there first. */
    this.flushLocal = () => {};
    this.running = null;
    this.again = false;
    this.stopped = false;
    this.heldTried = false;
    this.failures = 0;
    this.retryAt = 0;
    this.tooLong = 0;
    this.timer = null;
    this.keys = null;
    this.keysFor = null;
    this.blocked = new Set();
  }

  /** One cycle; a call during a cycle runs another after it. */
  async sync() {
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
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sync(), 1000);
  }

  /** Forgets a back-off and a refused token, as after joining a space. */
  reset() {
    this.failures = 0;
    this.retryAt = 0;
    this.stopped = false;
    this.heldTried = false;
    this.blocked.clear();
  }

  async keysOf({ space, secret }) {
    const k = `${space}|${secret}`;
    if (this.keysFor !== k) {
      this.keys = await SpaceKeys.create(decode(space), decode(secret));
      this.keysFor = k;
    }
    return this.keys;
  }

  async cycle() {
    const state = this.store.state;
    if (!this.store.syncing) return this.update("local");
    if (this.stopped || this.retryAt > this.now()) return;
    const space = state.space;
    const same = () => this.store.state.space === space;
    try {
      const keys = await this.keysOf(state);
      const transport = this.makeTransport(state, keys);
      this.flushLocal();
      if (!this.heldTried) {
        this.heldTried = true;
        if (!(await this.retryHeld(keys, same))) return;
      }
      for (;;) {
        const page = await transport.pull(this.store.state.cursor);
        if (!same()) return;
        if (this.store.noteEpoch(page.epoch)) continue;
        const decoded = await this.decodeAll(page.records, keys);
        this.flushLocal();
        if (!same()) return;
        this.apply(decoded);
        this.store.advance(page.cursor);
        if (page.records.length < PAGE_SIZE) {
          this.store.resynced();
          break;
        }
      }
      let refusals = 0;
      for (let round = 0; round < 10; round++) {
        this.flushLocal();
        const { writes, sent } = await this.outgoing(keys);
        if (!writes.length) break;
        const result = await transport.push(writes);
        if (!same()) return;
        if (this.store.noteEpoch(result.epoch)) {
          this.again = true;
          return;
        }
        for (const a of result.accepted) if (sent.has(a.id)) this.store.accepted(a.id, a.version, sent.get(a.id));
        if (!result.refused.length) continue;
        const decoded = await this.decodeAll(result.refused, keys);
        this.flushLocal();
        if (!same()) return;
        this.apply(decoded);
        for (const id of decoded.failed) this.blocked.add(id);
        if (decoded.items.length && ++refusals === 3) throw new TransportError("unreachable");
      }
      this.failures = 0;
      this.retryAt = 0;
      this.update("synced");
    } catch (error) {
      if (!same()) return;
      if (error?.kind === "unauthorized") {
        this.stopped = true;
        return this.update("notInSpace");
      }
      if (!(error instanceof TransportError)) console.warn("sync failed", error);
      this.failures++;
      this.retryAt = this.now() + Math.min(60, 5 * 2 ** (this.failures - 1)) * 1000;
      this.update(error?.kind === "offline" ? "offline" : "unreachable");
    }
  }

  /** Opens one record without touching the store: an item, a hold or an unreadable. */
  async decodeOne(p, keys) {
    let record;
    try {
      record = JSON.parse(new TextDecoder().decode(await keys.open(decode(p.blob), decode(p.id))));
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("not a record");
    } catch {
      return { unreadable: true };
    }
    if ((record.format ?? 0) > FORMAT) return { held: { id: p.id, version: p.version, blob: p.blob } };
    return { item: { id: p.id, version: p.version, record } };
  }

  async decodeAll(records, keys) {
    const out = { items: [], held: [], unreadable: 0, failed: [] };
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

  apply({ items, held, unreadable }) {
    for (const h of held) this.store.hold(h.id, h.version, h.blob);
    for (let i = 0; i < unreadable; i++) this.store.noteUnreadable();
    this.store.merge(items);
  }

  /** Records held for a newer Breezy, which this one may now read; false if the space changed meanwhile. */
  async retryHeld(keys, same) {
    const ids = Object.keys(this.store.state.held);
    const decoded = await this.decodeAll(ids.map((id) => ({ id, ...this.store.state.held[id] })), keys);
    if (!same()) return false;
    for (const id of ids) this.store.release(id);
    this.apply(decoded);
    return true;
  }

  async outgoing(keys) {
    const writes = [], sent = new Map();
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
    }
    return { writes, sent };
  }

  update(state) {
    this.status = {
      state, at: state === "synced" ? this.now() : this.status.at, waiting: this.store.pending().length,
      unreadable: this.store.state.unreadable, held: Object.keys(this.store.state.held).length, tooLong: this.tooLong,
    };
    this.onStatus(this.status);
  }
}
