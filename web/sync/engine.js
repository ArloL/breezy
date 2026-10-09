// Pulls what changed after the store's cursor, merges it, and pushes what is pending, one cycle at a time, as
// BreezyKit's SyncEngine; see the sync design.
import { SpaceKeys } from "./crypto.js";
import { encode, decode } from "./base64.js";
import { FORMAT } from "./records.js";

export const PAGE_SIZE = 500;
export const MAX_BLOB = 65536;
const MAX_REQUEST = 900_000;
const DEFLATE_ABOVE = 1024;

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
    const headers = { Authorization: `Bearer ${this.token}` };
    let payload;
    if (body) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
      if (payload.length > DEFLATE_ABOVE) {
        payload = await new Response(new Blob([payload]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer();
        headers["Content-Encoding"] = "deflate";
      }
    }
    let res;
    try {
      res = await fetch(url, {
        method: body ? "POST" : "GET",
        headers,
        body: payload,
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

  push(writes, since, epoch) {
    return this.send({}, { writes, ...(since === undefined ? {} : { since }), ...(epoch === undefined ? {} : { epoch }) });
  }
}

/** A WebSocket over TLS, or plain to this computer for trying the relay out, as validServer has it. */
export function validRelay(s) {
  try {
    const u = new URL(s);
    return u.protocol === "wss:" || (u.protocol === "ws:" && ["localhost", "127.0.0.1"].includes(u.hostname));
  } catch {
    return false;
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
    /** The relay the server last named; null until it names one. */
    this.relay = null;
    this.onRelay = () => {};
    /** After a push the server took: `{version, epoch, records}`, the highest version it gave and the accepted writes as
     * `{id, version, blob}`. */
    this.onPushed = () => {};
    /** After the pulls of a cycle, with the store's cursor. */
    this.onPulled = () => {};
    /** When a cycle last ended synced, in ms. */
    this.lastCycle = 0;
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

  noteRelay(r) {
    const relay = typeof r === "string" && validRelay(r) ? r : null;
    if (relay === this.relay) return;
    this.relay = relay;
    this.onRelay(relay);
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
      this.flushLocal();
      const ready = this.store.state.resync || this.store.state.epoch == null ? null : await this.outgoing(keys);
      const combined = ready?.writes.length > 0;
      let first = combined ? ready : null;
      if (!combined) {
        if (!(await this.pullAll(transport, keys, same))) return;
        this.onPulled(this.store.state.cursor);
      }
      let refusals = 0;
      for (let round = 0; round < 10; round++) {
        this.flushLocal();
        const { writes, sent, blobs } = first ?? (await this.outgoing(keys));
        first = null;
        if (!writes.length) break;
        const request = combined ? this.store.state.cursor : undefined;
        const result = await transport.push(writes, request, combined ? this.store.state.epoch : undefined);
        if (!same()) return;
        if (this.store.noteEpoch(result.epoch)) {
          this.again = true;
          return;
        }
        for (const a of result.accepted) if (sent.has(a.id)) this.store.accepted(a.id, a.version, sent.get(a.id));
        this.noteRelay(result.relay);
        if (result.accepted.length) {
          const records = result.accepted.filter((a) => blobs.has(a.id)).map((a) => ({ id: a.id, version: a.version, blob: blobs.get(a.id) }));
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
          const own = result.accepted.filter((a) => a.version > request && a.version <= result.cursor).length;
          const taken = await this.takePage(result, keys, same, own);
          if (taken === "stop") return;
          if (taken === "again") {
            this.again = true;
            return;
          }
          if (taken === "more" && !(await this.pullAll(transport, keys, same))) return;
        }
      }
      if (combined) this.onPulled(this.store.state.cursor);
      this.failures = 0;
      this.retryAt = 0;
      this.lastCycle = this.now();
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

  /** Applies the records another device just pushed, as the page after the cursor, without a pull; false, changing
   * nothing, when they do not follow on from what this one has. */
  async receivePushed({ epoch, records } = {}) {
    while (this.running) await this.running.catch(() => {});
    const state = this.store.state;
    if (!this.store.syncing || state.resync || state.epoch == null || epoch !== state.epoch) return false;
    if (!Array.isArray(records) || !records.length) return false;
    const page = records.map(({ id, version, blob }) => ({ id, version, blob }));
    if (!page.every((r) => typeof r.id === "string" && typeof r.blob === "string" && Number.isSafeInteger(r.version))) return false;
    page.sort((x, y) => x.version - y.version);
    if (page.some((r, i) => i && r.version !== page[i - 1].version + 1) || state.cursor < page[0].version - 1) return false;
    const last = page.at(-1).version;
    if (state.cursor >= last) return true;
    let ok = false;
    this.running = (async () => {
      try {
        const keys = await this.keysOf(state);
        const same = () => this.store.state.space === state.space && this.store.state.epoch === epoch;
        this.flushLocal();
        const decoded = await this.decodeAll(page, keys);
        this.flushLocal();
        if (same()) {
          this.apply(decoded);
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
  async takePage(page, keys, same, own = 0) {
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
  async pullAll(transport, keys, same) {
    for (;;) {
      const taken = await this.takePage(await transport.pull(this.store.state.cursor), keys, same);
      if (taken === "stop") return false;
      if (taken === "done") {
        this.store.resynced();
        return true;
      }
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
    return { item: { id: p.id, version: p.version, record, stale: p.stale === true } };
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
    const writes = [], sent = new Map(), blobs = new Map();
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

  update(state) {
    this.status = {
      state, at: state === "synced" ? this.now() : this.status.at, waiting: this.store.pending().length,
      unreadable: this.store.state.unreadable, held: Object.keys(this.store.state.held).length, tooLong: this.tooLong,
    };
    this.onStatus(this.status);
  }
}
