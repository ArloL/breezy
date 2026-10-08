// The boards of one space as this device has them, as BreezyKit's Store. Records are never changed in place: a
// change makes a new object, so a record sent to the server can serve as the base afterwards.
import { newID } from "../rules.js";
import { boardFrom, boardRecord, changes, deletedRecord } from "./records.js";
import { mergeRecord, equalRecords } from "./merge.js";
import { encode } from "./base64.js";
import { randomBytes } from "./crypto.js";

export const emptyState = () => ({
  server: null, space: null, secret: null, cursor: 0, records: {}, held: {}, unreadable: 0, epoch: null, resync: false,
});

export const withFreshIDs = (board) => ({
  cards: board.cards.map((c) => ({ ...c, id: newID() })),
  lanes: board.lanes.map((l) => ({ ...l, id: newID() })),
});

const empty = () => ({ cards: [], lanes: [] });

export class Store {
  constructor(state = emptyState()) {
    this.state = state;
    /** After a change to what boards show, with the boards concerned and whether it came from the server. */
    this.onChange = () => {};
    /** After any change, for saving. */
    this.onDirty = () => {};
  }

  get syncing() {
    const s = this.state;
    return !!(s.server && s.space && s.secret);
  }

  get invite() {
    const { server, space, secret } = this.state;
    return this.syncing ? { server, space, secret } : null;
  }

  current() {
    return Object.fromEntries(Object.entries(this.state.records).map(([id, s]) => [id, s.current]));
  }

  boards() {
    return Object.entries(this.state.records)
      .filter(([, s]) => s.current.kind === "board" && s.current.deleted !== true)
      .map(([id, s]) => ({ id, title: typeof s.current.title === "string" ? s.current.title : "" }))
      .sort((a, b) => a.title.localeCompare(b.title) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  title(id) {
    const r = this.state.records[id]?.current;
    if (!r || r.kind !== "board" || r.deleted === true) return null;
    return typeof r.title === "string" ? r.title : "";
  }

  board(id) {
    return boardFrom(this.current(), id);
  }

  createBoard(title, contents = empty()) {
    const id = newID();
    this.apply({ ...changes(empty(), contents, id, {}), [id]: { fields: boardRecord(title) } });
    return id;
  }

  renameBoard(id, title) {
    this.apply({ [id]: { fields: { title } } });
  }

  deleteBoard(id) {
    const out = { [id]: { deleted: "board" } };
    for (const [rid, s] of Object.entries(this.state.records)) {
      if (s.current.board === id && s.current.deleted !== true) out[rid] = { deleted: s.current.kind };
    }
    this.apply(out);
  }

  /** Local edits. A deleted record stays deleted; partial fields for an unknown record, and new records on a deleted board, are dropped. */
  apply(edits) {
    const boards = new Set();
    for (const [id, change] of Object.entries(edits)) {
      const s = this.state.records[id];
      if (change.deleted) {
        if (!s || s.current.deleted === true) continue;
        boards.add(s.current.board ?? id);
        this.state.records[id] = { ...s, current: deletedRecord(change.deleted) };
      } else if (s) {
        if (s.current.deleted === true) continue;
        const current = { ...s.current, ...change.fields };
        this.state.records[id] = { ...s, current };
        boards.add(current.board ?? id);
      } else {
        if (!change.fields.kind || this.state.records[change.fields.board]?.current.deleted === true) continue;
        this.state.records[id] = { base: null, version: 0, current: change.fields };
        boards.add(change.fields.board ?? id);
      }
    }
    if (!boards.size) return;
    this.onDirty();
    this.onChange(boards, false);
  }

  orders(board) {
    const out = {};
    for (const [id, s] of Object.entries(this.state.records)) {
      const r = s.current;
      if (r.kind === "card" && r.deleted !== true && r.board === board && typeof r.order === "string") out[id] = r.order;
    }
    return out;
  }

  pending() {
    return Object.entries(this.state.records)
      .filter(([, s]) => !equalRecords(s.current, s.base))
      .map(([id, s]) => ({ id, base: s.version, record: s.current }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** The server took `record` as `version`; edits made since it was sent stay pending. */
  accepted(id, version, record) {
    const s = this.state.records[id];
    if (!s) return;
    this.state.records[id] = { ...s, base: record, version };
    this.onDirty();
  }

  /**
   * Records from the server, merged three ways into those with local changes. While resyncing, a stale record this device
   * has becomes its base, so that what the device has since is pushed.
   */
  merge(items) {
    if (!items.length) return;
    const boards = new Set();
    for (const { id, version, record, stale } of items) {
      const old = this.state.records[id];
      if (old && this.state.resync && stale) {
        this.state.records[id] = { base: record, version, current: old.current };
        continue;
      }
      if (old && version <= old.version) continue;
      let current = record;
      if (old && !equalRecords(old.current, old.base)) {
        const m = mergeRecord(old.base, old.current, record);
        current = m.record;
        if (m.copy) this.state.records[newID()] = { base: null, version: 0, current: m.copy };
      }
      for (const b of [old?.current.board, current.board, record.board]) if (b) boards.add(b);
      if (record.kind === "board") boards.add(id);
      this.state.records[id] = { base: record, version, current };
    }
    this.onDirty();
    if (boards.size) this.onChange(boards, true);
  }

  advance(cursor) {
    this.state.cursor = Math.max(this.state.cursor, cursor);
    this.onDirty();
  }

  /**
   * Takes the server's epoch when none is stored; when it differs from the stored one, as after a restore from a backup or
   * the loss of the space, starts pulling everything again, as `merge` and `resynced` describe, and returns true.
   */
  noteEpoch(epoch = null) {
    const s = this.state;
    if (epoch === (s.epoch ?? null)) return false;
    const resync = s.epoch != null;
    s.epoch = epoch;
    if (resync) {
      Object.assign(s, { cursor: 0, resync: true, unreadable: 0 });
      for (const [id, r] of Object.entries(s.records)) s.records[id] = { ...r, version: 0 };
    }
    this.onDirty();
    return resync;
  }

  /** The resync's pull is done; records the server lacks wait to be pushed as new. */
  resynced() {
    const s = this.state;
    if (!s.resync) return;
    s.resync = false;
    for (const [id, r] of Object.entries(s.records)) if (r.version === 0) s.records[id] = { ...r, base: null };
    this.onDirty();
  }

  hold(id, version, blob) {
    this.state.held[id] = { version, blob };
    this.onDirty();
  }

  release(id) {
    delete this.state.held[id];
    this.onDirty();
  }

  noteUnreadable() {
    this.state.unreadable++;
    this.onDirty();
  }

  /** This device's boards give way to the space `invite` names. */
  join({ server, space, secret }) {
    const boards = new Set(this.boards().map((b) => b.id));
    this.state = { ...emptyState(), server, space, secret };
    this.onDirty();
    this.onChange(boards, true);
  }

  /** A new space on `server` for the boards here; every record waits to be pushed. */
  startSyncing(server) {
    const s = this.state;
    Object.assign(s, { server, space: encode(randomBytes(16)), secret: encode(randomBytes(32)), cursor: 0, epoch: null, resync: false, held: {}, unreadable: 0 });
    for (const [id, r] of Object.entries(s.records)) s.records[id] = { ...r, base: null, version: 0 };
    this.onDirty();
    return this.invite;
  }
}
