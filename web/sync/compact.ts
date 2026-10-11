// Compact cursor and live bodies for v2 links: MessagePack arrays with deltas, splices and groups; see the lean sync
// design. Order on the wire: items and group ids by their id's bytes, fields by key ascending.
import { pack, unpack, Float32 } from "./msgpack.js";
import { encode, decode } from "./base64.js";

export const KEYFRAME_MS = 1000;
export const FIELDS = ["pos", "size", "w", "text", "notes", "color", "title", "kind", "gone"];
const KINDS = ["card", "lane"];
const TEXTS = new Set(["text", "notes", "title"]);
/** Group members' offsets count as equal this close. */
const EPSILON = 1e-6;

export const isCompact = (bytes) => bytes.length > 0 && ((bytes[0] & 0xf0) === 0x90 || bytes[0] === 0xdc);

/** FNV-1a 32 over UTF-16 code units, unsigned. */
export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const high = (c) => c >= 0xd800 && c <= 0xdbff;
const low = (c) => c >= 0xdc00 && c <= 0xdfff;

/** `[at, del, ins]` turning `before` into `after`, in UTF-16 units, never splitting a surrogate pair. */
export function splice(before, after) {
  const n = Math.min(before.length, after.length);
  let p = 0;
  while (p < n && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  if (p > 0 && high(before.charCodeAt(p - 1))) p--;
  let s = 0;
  while (s < n - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++;
  if (s > 0 && low(before.charCodeAt(before.length - s))) s--;
  return [p, before.length - p - s, after.slice(p, after.length - s)];
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isId = (v) => v instanceof Uint8Array && v.length === 16;
const num = (v) => typeof v === "number";
const uint = (v) => Number.isSafeInteger(v) && v >= 0;
const pair = (v) => Array.isArray(v) && v.length === 2 && v.every(num);
const f32 = ([x, y]) => [new Float32(x), new Float32(y)];
const tenths = (at) => Math.round(at * 10);

function bin(id) {
  const b = decode(id);
  if (b?.length !== 16) throw new RangeError(`compact: not an id: ${id}`);
  return b;
}

function byBytes(a, b) {
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** Keyframes at the first body, after `reset()`, and KEYFRAME_MS after the last. */
class Encoder {
  keyframeAt = null;
  forced = false;

  /** Forces the next body to be a keyframe. */
  reset() {
    this.forced = true;
  }

  keyframe(now) {
    const key = this.forced || this.keyframeAt === null || now - this.keyframeAt >= KEYFRAME_MS;
    if (key) [this.forced, this.keyframeAt] = [false, now];
    return key;
  }
}

/** One pipe's cursor encoder. */
export class CursorEncoder extends Encoder {
  board = null;

  /** `x` or `y` null hides. */
  encode({ x, y, board }, { seq, at, now }) {
    const b = bin(board);
    const key = this.keyframe(now);
    const shown = x != null && y != null;
    const out = [1, seq, tenths(at), shown ? new Float32(x) : null, shown ? new Float32(y) : null];
    if (key || board !== this.board) out.push(b);
    this.board = board;
    return pack(out);
  }
}

/** Items whose `pos` moved from their start by one offset, as `{ ids, starts, offset }`; null when there are none. */
function groupOf(ids, items, starts) {
  const members = ids.filter(([id]) => items[id].pos && starts[id]);
  if (!members.length) return null;
  const off = ([id]) => [items[id].pos[0] - starts[id][0], items[id].pos[1] - starts[id][1]];
  const o = off(members[0]);
  const near = (m) => off(m).every((d, i) => Math.abs(d - o[i]) <= EPSILON);
  if (!members.every(near)) return null;
  return { ids: members, starts: members.map(([id]) => starts[id]), offset: o.map(Math.fround) };
}

/** One pipe's live encoder: remembers what it last sent. */
export class LiveEncoder extends Encoder {
  board = null;
  caretId = null;
  /** Id → its fields as last sent. */
  sent = new Map();
  /** The group's ids and starts as last sent. */
  groupSet = null;
  /** The group's offset as last sent, null when the last body had no group. */
  offset = null;

  /** `{ board, items: {id: fields since start}, starts: {id: [x, y]}, caret, cursor: [x, y] | null }` → bytes. */
  encode({ board, items, starts = {}, caret = null, cursor = null }, { seq, at, now }) {
    const boardBin = bin(board), caretBin = caret && bin(caret.id);
    const ids = Object.keys(items).map((id) => [id, bin(id)]).sort(([, a], [, b]) => byBytes(a, b));
    for (const f of Object.values(items)) if ("kind" in f && !KINDS.includes(f.kind)) throw new RangeError(`compact: unknown kind ${f.kind}`);
    const key = this.keyframe(now);
    if (key) [this.sent, this.groupSet] = [new Map(), null];
    const group = groupOf(ids, items, starts);
    const grouped = new Set(group?.ids.map(([id]) => id));
    const out = new Map();
    for (const [id, b] of ids) {
      const last = this.sent.get(id) ?? {};
      const f = new Map();
      FIELDS.forEach((name, k) => {
        if (!(name in items[id])) return;
        const v = items[id][name], was = last[name];
        last[name] = v;
        if ((name === "pos" && grouped.has(id)) || same(was, v)) return;
        f.set(k, field(name, v, was));
      });
      this.sent.set(id, last);
      if (f.size) out.set(b, f);
    }
    let g = null;
    if (group) {
      const set = { ids: group.ids.map(([id]) => id), starts: group.starts };
      const fresh = !same(set, this.groupSet);
      if (fresh || !same(group.offset, this.offset)) g = fresh ? [f32(group.offset), group.ids.map(([, b]) => b), group.starts.map(f32)] : [f32(group.offset)];
      this.groupSet = set;
    }
    this.offset = group?.offset ?? null;
    const b = key || board !== this.board ? boardBin : null;
    this.board = board;
    const c = caret ? [key || caret.id !== this.caretId ? caretBin : null, caret.back, caret.at] : null;
    this.caretId = caret?.id ?? null;
    return pack([2, seq, tenths(at), b, c, out, g, cursor ? f32(cursor) : null]);
  }
}

/** `v` on the wire; a text that was `was` goes as a splice when that is shorter. */
function field(name, v, was) {
  if (name === "pos" || name === "size") return f32(v);
  if (name === "w") return new Float32(v);
  if (name === "kind") return KINDS.indexOf(v);
  if (TEXTS.has(name) && typeof was === "string") {
    const s = [fnv1a(was), ...splice(was, v)];
    if (pack(s).length < pack(v).length) return s;
  }
  return v;
}

const BAD = Symbol("bad");

/** A wire field back to its JSON value; undefined for a splice that does not apply to `current`. */
function unfield(name, v, current) {
  switch (name) {
    case "pos":
    case "size":
      return pair(v) ? [v[0], v[1]] : BAD;
    case "w":
      return num(v) ? v : BAD;
    case "color":
      return Number.isSafeInteger(v) ? v : BAD;
    case "kind":
      return Number.isInteger(v) ? KINDS[v] ?? BAD : BAD;
    case "gone":
      return v === true ? true : BAD;
  }
  if (typeof v === "string") return v;
  if (!Array.isArray(v) || v.length !== 4 || !v.slice(0, 3).every(uint) || typeof v[3] !== "string") return BAD;
  const [hash, at, del, ins] = v;
  if (typeof current !== "string" || fnv1a(current) !== hash || at + del > current.length) return undefined;
  return current.slice(0, at) + ins + current.slice(at + del);
}

/** Turns compact bytes into the JSON-shaped bodies Live handles, keeping one sender's state. */
export class LiveDecoder {
  boards = { cursor: null, live: null };
  seqs = { cursor: 0, live: 0 };
  caretId = null;
  groupIds = null;
  groupStarts = null;

  /** → `{t: "cursor", seq, at, board, x, y}`, `{t: "live", seq, at, board, items, caret, cursor}`, or null when malformed
   * or not after the last body of its kind; `overlay`: id → the fields this receiver shows for this sender. */
  decode(bytes, overlay = new Map()) {
    let v;
    try {
      v = unpack(bytes);
    } catch {
      return null;
    }
    if (!Array.isArray(v)) return null;
    if (v[0] === 1) return this.cursor(v);
    if (v[0] === 2) return this.live(v, overlay);
    return null;
  }

  cursor(v) {
    if (v.length !== 5 && v.length !== 6) return null;
    const [, seq, at, x, y, board] = v;
    if (!uint(seq) || !Number.isSafeInteger(at)) return null;
    if (!((x === null && y === null) || (num(x) && num(y)))) return null;
    if (v.length === 6 && !isId(board)) return null;
    const b = v.length === 6 ? encode(board) : this.boards.cursor;
    if (b === null || seq <= this.seqs.cursor) return null;
    [this.boards.cursor, this.seqs.cursor] = [b, seq];
    return { t: "cursor", seq, at: at / 10, board: b, x, y };
  }

  live(v, overlay) {
    if (v.length !== 8) return null;
    const [, seq, at, board, caret, items, group, cursor] = v;
    if (!uint(seq) || !Number.isSafeInteger(at)) return null;
    if (board !== null && !isId(board)) return null;
    const b = board ? encode(board) : this.boards.live;
    if (b === null) return null;
    if (caret !== null && !(Array.isArray(caret) && caret.length === 3 && (caret[0] === null || isId(caret[0])) && typeof caret[1] === "boolean" && uint(caret[2]))) return null;
    if (cursor !== null && !pair(cursor)) return null;
    if (!(items instanceof Map)) return null;
    const out = {};
    for (const [id, fields] of items) {
      if (!isId(id) || !(fields instanceof Map)) return null;
      const key = encode(id), f = {};
      for (const [k, x] of fields) {
        if (!Number.isInteger(k)) return null;
        // a field from a newer sender
        if (!FIELDS[k]) continue;
        const value = unfield(FIELDS[k], x, overlay.get(key)?.[FIELDS[k]]);
        if (value === BAD) return null;
        if (value !== undefined) f[FIELDS[k]] = value;
      }
      if (Object.keys(f).length) out[key] = f;
    }
    let [ids, starts] = [this.groupIds, this.groupStarts];
    if (group !== null) {
      if (!Array.isArray(group) || (group.length !== 1 && group.length !== 3) || !pair(group[0])) return null;
      if (group.length === 3) {
        [ids, starts] = group.slice(1);
        if (!Array.isArray(ids) || !Array.isArray(starts) || ids.length !== starts.length || !ids.every(isId) || !starts.every(pair)) return null;
        ids = ids.map(encode);
      }
    }
    if (seq <= this.seqs.live) return null;
    [this.boards.live, this.seqs.live, this.groupIds, this.groupStarts] = [b, seq, ids, starts];
    if (group && ids) {
      const [dx, dy] = group[0];
      ids.forEach((id, i) => (out[id] = { ...out[id], pos: [starts[i][0] + dx, starts[i][1] + dy] }));
    }
    const caretId = caret ? (caret[0] ? encode(caret[0]) : this.caretId) : null;
    this.caretId = caretId;
    return { t: "live", seq, at: at / 10, board: b, items: out, caret: caretId ? { id: caretId, back: caret[1], at: caret[2] } : null, cursor: cursor && [cursor[0], cursor[1]] };
  }
}
