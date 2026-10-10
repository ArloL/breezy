// A device's groups of boards: its own, which never sync, and one per space it joined, each a store with its saver
// and engine, as BreezyKit's Spaces; see the spaces design.
import { Store, withFreshIDs } from "./store.js";
import { Saver } from "./saver.js";
import { SyncEngine } from "./engine.js";
import { Live } from "./live.js";
import { encode, decode } from "./base64.js";
import { randomBytes } from "./crypto.js";

export const LOCAL_NAME = "On this device";
export const UNNAMED = "Shared Space";

class Group {
  constructor(key, store, engine, saver) {
    Object.assign(this, { key, store, engine, saver });
    /** The space's live layer, once its server names a relay. */
    this.live = null;
  }

  /** Null for On this device. */
  get space() {
    return this.store.state.space;
  }

  get name() {
    return this.space ? this.store.name ?? UNNAMED : LOCAL_NAME;
  }
}

const keyOf = (state) => (state?.space ? `space:${state.space}` : "local");

export class Spaces {
  /** The groups in `storage`, after moving a store from before spaces among them; `fresh` when it held nothing. */
  static async open(storage, options = {}) {
    const all = await storage.loadAll();
    const fresh = !Object.keys(all).length;
    if (all.space) {
      const key = keyOf(all.space);
      if (!all[key]) {
        await storage.save(key, all.space);
        all[key] = all.space;
      }
      await storage.remove("space");
      delete all.space;
    }
    const spaces = new Spaces(storage, all, options);
    spaces.fresh = fresh;
    return spaces;
  }

  constructor(storage, states = {}, { transport, readOnly = false, socket, now, peerTransport } = {}) {
    this.storage = storage;
    this.transport = transport;
    this.socket = socket;
    this.peerTransport = peerTransport;
    this.now = now;
    this.readOnly = readOnly;
    this.fresh = false;
    this.lastServer = typeof states.server === "string" ? states.server : null;
    const me = states.me;
    /** This device as others in its spaces see it. */
    this.me = decode(me?.device)?.length === 16 && typeof me.name === "string" ? { device: me.device, name: me.name } : { device: encode(randomBytes(16)), name: "" };
    if (!me && !readOnly) storage.save("me", this.me).catch(() => {});
    /** After a group's live layer appears, goes, or hears something. */
    this.onLive = () => {};
    /** The relay refused holds a group's live layer asked for. */
    this.onRefused = () => {};
    /** After a change to what a group's boards show, with the boards concerned and whether it came from the server. */
    this.onChange = () => {};
    this.onStatus = () => {};
    /** After a save fails. */
    this.onSaveError = () => {};
    /** Called before merging, so that edits not yet in a store get there first. */
    this.flushLocal = () => {};
    this.local = this.make("local", new Store(states.local ?? undefined));
    this.spaces = Object.entries(states)
      .filter(([k, s]) => k.startsWith("space:") && s?.space)
      .map(([k, s]) => this.make(k, new Store(s)));
  }

  make(key, store) {
    const engine = new SyncEngine(store, { ...(this.transport ? { transport: this.transport } : {}), ...(this.now ? { now: this.now } : {}) });
    const saver = new Saver(() => this.storage.save(key, store.state));
    saver.enabled = !this.readOnly;
    const g = new Group(key, store, engine, saver);
    saver.onError = (error) => this.onSaveError(error);
    store.onDirty = () => saver.schedule();
    store.onChange = (boards, remote) => {
      if (!remote) engine.changed();
      this.onChange(g, boards, remote);
    };
    engine.onStatus = () => this.onStatus(g);
    engine.flushLocal = () => this.flushLocal();
    engine.onRelay = (relay) => this.setRelay(g, relay);
    engine.onPushed = (pushed) => g.live?.sendPushed(pushed);
    engine.onPulled = (cursor) => g.live?.noteCursor(cursor);
    // the live layer connects at once rather than after the first sync names the relay
    if (store.state.relay) engine.noteRelay(store.state.relay);
    return g;
  }

  /** Replaces the group's live layer with one on `relay`, or none; the keys take a moment. */
  async setRelay(g, relay) {
    if (relay === (g.live?.relay ?? null)) return;
    g.live?.close();
    g.live = null;
    if (relay && g.space) {
      const keys = await g.engine.keysOf(g.store.state);
      if (g.engine.relay !== relay || g.live || !this.spaces.includes(g)) return;
      const live = new Live({ relay, space: g.space, keys, me: this.me, ...(this.socket ? { socket: this.socket } : {}), ...(this.peerTransport !== undefined ? { peerTransport: this.peerTransport } : {}) });
      live.onPushed = async (version, extra) => {
        // a repeat of what this device has already
        if (!extra && version <= g.store.state.cursor) return;
        if (!(extra && (await g.engine.receivePushed(extra)))) g.engine.sync();
      };
      live.onWelcome = () => g.engine.retryNow();
      live.onChange = () => this.onLive(g);
      live.onRefused = (ids) => this.onRefused(g, ids);
      // a refused token is the server's to report: its 401 shows "Not in this space any more"
      live.onUnauthorized = () => g.engine.sync();
      g.live = live;
    }
    this.onLive(g);
  }

  /** This device's name, kept and shown to the others in every space. */
  async setName(name) {
    this.me = { ...this.me, name };
    for (const g of this.spaces) g.live?.setMe(this.me);
    if (!this.readOnly) await this.storage.save("me", this.me).catch(() => {});
  }

  /** On this device first, then the spaces by name, with names alike but for case tied, then by space id. */
  groups() {
    const cmp = (a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "accent" }) || (a.space < b.space ? -1 : a.space > b.space ? 1 : 0);
    return [this.local, ...[...this.spaces].sort(cmp)];
  }

  groupOf(board) {
    return this.groups().find((g) => g.store.title(board) !== null) ?? null;
  }

  groupFor(space) {
    return this.spaces.find((g) => g.space === space) ?? null;
  }

  get saveFailed() {
    return this.groups().some((g) => g.saver.failed);
  }

  /** A new empty space on `server` named `name`; the server is remembered for the next one. */
  newSpace(server, name) {
    const store = new Store();
    store.startSyncing(server);
    store.rename(name);
    this.lastServer = server;
    if (!this.readOnly) this.storage.save("server", server).catch(() => {});
    return this.adopt(store);
  }

  /** `invite`'s space: the group already joined, or a new one. */
  join(invite) {
    const known = this.groupFor(invite.space);
    if (known) return known;
    const store = new Store();
    store.join(invite);
    return this.adopt(store);
  }

  adopt(store) {
    const g = this.make(keyOf(store.state), store);
    this.spaces.push(g);
    g.saver.schedule();
    return g;
  }

  /** Forgets `group`'s space on this device: its key goes and its store stops saving. The server keeps it. */
  async leave(group) {
    if (group === this.local) return;
    this.spaces = this.spaces.filter((g) => g !== group);
    group.store.onDirty = group.store.onChange = group.engine.onStatus = () => {};
    group.live?.close();
    group.live = null;
    group.saver.enabled = false;
    await group.saver.writing;
    if (!this.readOnly) await this.storage.remove(group.key);
  }

  /**
   * Board `id` copied into `target` with new ids, then deleted where it was once the copy is saved. Null when the copy
   * can't be saved, as when read-only: the board stays where it was, and the copy too.
   */
  async move(id, target) {
    const source = this.groupOf(id);
    const title = source?.store.title(id);
    if (this.readOnly || !source || source === target || title == null) return null;
    const created = target.store.createBoard(title, withFreshIDs(source.store.board(id)));
    await target.saver.flush();
    if (target.saver.failed) return null;
    source.store.deleteBoard(id);
    return created;
  }

  /** A cycle for every space, each on its own. When `polling`, a space whose live layer is connected waits 30 s between
   * cycles: its relay announces what others push. */
  syncAll({ polling = false } = {}) {
    const now = (this.now ?? Date.now)();
    for (const g of this.spaces) {
      if (polling && g.live?.connected && now - g.engine.lastCycle < 30_000) continue;
      g.engine.sync();
    }
  }

  /** The network may have changed, as when the app shows again, or did (`changed`), as when it comes back: every space
   * syncs now and checks its relay. */
  retryAll(changed = false) {
    for (const g of this.spaces) {
      g.engine.retryNow();
      g.live?.check(changed);
    }
  }

  flushAll() {
    return Promise.all(this.groups().map((g) => g.saver.flush()));
  }
}
