// A device's groups of boards: its own, which never sync, and one per space it joined, each a store with its saver
// and engine, as BreezyKit's Spaces; see the spaces design.
import { Store, withFreshIDs } from "./store.js";
import { Saver } from "./saver.js";
import { SyncEngine } from "./engine.js";

export const LOCAL_NAME = "On this device";
export const UNNAMED = "Shared Space";

class Group {
  constructor(key, store, engine, saver) {
    Object.assign(this, { key, store, engine, saver });
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
      await storage.save(key, all.space);
      await storage.remove("space");
      all[key] = all.space;
      delete all.space;
    }
    const spaces = new Spaces(storage, all, options);
    spaces.fresh = fresh;
    return spaces;
  }

  constructor(storage, states = {}, { transport, readOnly = false } = {}) {
    this.storage = storage;
    this.transport = transport;
    this.readOnly = readOnly;
    this.fresh = false;
    this.lastServer = typeof states.server === "string" ? states.server : null;
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
    const engine = new SyncEngine(store, this.transport ? { transport: this.transport } : {});
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
    return g;
  }

  /** On this device first, then the spaces by name. */
  groups() {
    const cmp = (a, b) => a.name.localeCompare(b.name) || (a.space < b.space ? -1 : a.space > b.space ? 1 : 0);
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

  /** A cycle for every space, each on its own. */
  syncAll() {
    for (const g of this.spaces) g.engine.sync();
  }

  flushAll() {
    return Promise.all(this.groups().map((g) => g.saver.flush()));
  }
}
