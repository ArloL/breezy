// A space's live layer over its relay: who is here and where, what they hold, and their edits as they happen, as
// BreezyKit's Live; see the multiplayer and lean sync designs. Bodies are sealed with the space key, so the relay reads
// none of them; a version 2 channel carries compact bodies unsealed.
import { encode, decode } from "./base64.js";
import { LIVE_FIELDS } from "./overlay.js";
import { Track } from "./track.js";
import { Direct } from "./direct.js";
import { RTCTransport } from "./rtc.js";
import { CursorEncoder, LiveEncoder, LiveDecoder, isCompact } from "./compact.js";
import { relayFrame, parseRelayFrame } from "./frames.js";

export const PALETTE = ["#e5484d", "#f76b15", "#12a594", "#8e4ec6", "#3e63dd", "#e93d82", "#ad7f58", "#00a2c7"];
export const SEND_MS = 50;
export const DIRECT_SEND_MS = 8;
export const HEARTBEAT_MS = 5_000;
export const CURSOR_REPEAT_MS = 100;
export const PRESENCE_MS = 15_000;
export const GONE_MS = 30_000;
export const HOLD_GRACE_MS = 1_000;
export const IDLE_CURSOR_MS = 60_000;
export const MAX_BACKOFF_MS = 30_000;
export const PING_MS = 20_000;
export const PONG_TIMEOUT_MS = 10_000;
const MAX_FRAME = 65_536;
const MAX_PUSHED = 60_000;
const enc = new TextEncoder(), dec = new TextDecoder();

/** The live fields that move, played back through a track. */
const MOVING = ["pos", "size", "w"];
/** Coordinates kept this close to 0, so that playing back between two stays finite. */
const LIMIT = 1e7;
const clamp = (v) => Math.min(LIMIT, Math.max(-LIMIT, v));
const round = (v, by) => Math.round(v * by) / by;
/** `items` with their moving fields clamped, and rounded to `by` when given. */
const trimmed = (items, by) => Object.fromEntries(Object.entries(items).map(([id, f]) => {
  const out = { ...f };
  for (const k of MOVING) {
    const fit = (v) => (Number.isFinite(v) ? (by ? round(clamp(v), by) : clamp(v)) : v);
    if (k in f) out[k] = Array.isArray(f[k]) ? f[k].map(fit) : fit(f[k]);
  }
  return [id, out];
}));
/** Whether peer `p`'s presence shows `board`. */
const shows = (p, board) => (p.boards ? p.boards.includes(board) : p.board === board);
/** The relay's number for connection `id`; null for one it does not name with digits. */
const connNumber = (id) => (/^\d{1,10}$/.test(id) ? Number(id) : null);
/** How long `bytes` are as base64url. */
const b64Length = (bytes) => Math.ceil((bytes.length * 4) / 3);
const numbers = (v) => (Number.isFinite(v) ? [clamp(v)] : Array.isArray(v) && v.length && v.every(Number.isFinite) ? v.map(clamp) : null);
/** Whether `v` is a whole number that BreezyKit reads exactly, within ±2^53. */
const integral = (v) => Number.isInteger(v) && Math.abs(v) <= 2 ** 53;

export const colourOf = (device) => PALETTE[(decode(device)?.[0] ?? 0) % PALETTE.length];

/** One or two letters for avatars. */
export function initials(name) {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0].toUpperCase()).join("") || "?";
}

const personOf = (device, name) => ({ device, name, colour: colourOf(device) });
const pointOf = (c) => (c && typeof c.board === "string" && Number.isFinite(c.x) && Number.isFinite(c.y) ? { board: c.board, x: clamp(c.x), y: clamp(c.y) } : null);
const caretOf = (c) =>
  c && typeof c.id === "string" && typeof c.back === "boolean" && integral(c.at) && c.at >= 0 ? { id: c.id, back: c.back, at: c.at } : null;
const pick = (f) => Object.fromEntries(Object.entries(f).filter(([k]) => k === "kind" || LIVE_FIELDS.includes(k)));
const holdsFrom = (h) => new Map(Object.entries(h ?? {}).filter(([, ids]) => Array.isArray(ids)).map(([k, ids]) => [k, new Set(ids)]));

/** Runs `go` at most every `ms`: once the calls made meanwhile are done when it may, else once when it may again. */
class Gate {
  constructor(live, ms, go) {
    Object.assign(this, { live, ms, go });
    this.sent = -Infinity;
    this.queued = false;
  }

  run() {
    if (this.queued) return;
    this.queued = true;
    const fire = () => {
      this.queued = false;
      this.sent = this.live.now();
      this.go();
    };
    const wait = this.ms - (this.live.now() - this.sent);
    // a cursor and a live edit from one event go as one body
    if (wait <= 0) queueMicrotask(fire);
    else this.live.schedule(wait, fire);
  }
}

/** One way out, the open channels or the relay: its gate, its compact encoders, and what waits to go. */
class Pipe {
  constructor(live, direct, ms) {
    Object.assign(this, { direct, encoders: { cursor: new CursorEncoder(), live: new LiveEncoder() } });
    this.gate = new Gate(live, ms, () => live.flush(this));
    /** Who each encoder last sent to; another set starts from a keyframe. */
    this.to = { cursor: null, live: null };
    this.cursor = false;
    /** The cursor waiting is the channels' resend of the last one. */
    this.repeat = false;
    this.live = false;
    /** The next cursor goes to everyone: this device's cursor moved to another board. */
    this.everyone = false;
  }

  /** `body` as compact bytes for `ids`, null when it cannot be put so. */
  compact(kind, ids, body, stamp) {
    const key = ids.join(" ");
    if (key !== this.to[kind]) this.encoders[kind].reset();
    this.to[kind] = key;
    try {
      return this.encoders[kind].encode(body, stamp);
    } catch (e) {
      if (e instanceof RangeError) return null;
      throw e;
    }
  }

  /** The next live body starts a gesture. */
  restart() {
    this.encoders.live.reset();
    this.to.live = null;
  }
}

export class Live {
  constructor({ relay, space, keys, me, socket = (url) => new WebSocket(url), now = () => Date.now(), clock = () => performance.now(), schedule = (ms, fn) => setTimeout(fn, ms), peerTransport = typeof RTCPeerConnection === "function" ? () => new RTCTransport() : null }) {
    Object.assign(this, { relay, space, keys, me, makeSocket: socket, now, clock, schedule });
    /** What `at` in this device's bodies counts from. */
    this.started = clock();
    this.seq = 0;
    this.ws = null;
    this.id = null;
    this.wanted = false;
    this.failures = 0;
    this.retrying = false;
    /** After the relay refused the token: this layer stays closed. A new one comes when the server names another relay,
     * or at the next launch. */
    this.stopped = false;
    this.pingSent = -Infinity;
    /** When a ping went out that nothing has answered yet. */
    this.pingWaiting = null;
    /** Connection id → { person, v, board, boards, selection, cursor, cursorAt, heard, overlay: Map, overlayBoard, caret,
     * awaiting, unheld: Map of overlay id → when its live body last came while its sender did not hold it }. */
    this.peers = new Map();
    /** Connection id → its compact bodies' decoders, one per pipe. */
    this.decoders = new Map();
    /** Connection id → the ids it holds. */
    this.holds = new Map();
    /** What this connection holds, or has asked to. */
    this.mine = new Set();
    this.presence = { board: null, boards: [], selection: [] };
    this.cursor = null;
    this.cursorBoard = "";
    this.presenceSent = -Infinity;
    /** Cursors the channels have sent, which a later one keeps from being sent again. */
    this.cursorSends = 0;
    this.lastLive = null;
    this.channels = new Pipe(this, true, DIRECT_SEND_MS);
    this.relayPipe = new Pipe(this, false, SEND_MS);
    /** When a frame last reached the relay, which keeps this connection's holds there while it hears from it. */
    this.relaySent = -Infinity;
    this.storeCursor = 0;
    this.out = Promise.resolve();
    this.in = Promise.resolve();
    this.onChange = () => {};
    this.onPushed = () => {};
    this.onRefused = () => {};
    this.onUnauthorized = () => {};
    /** The other connections in the space, as the relay names them → when each joined or was last heard. */
    this.roster = new Map();
    this.direct = peerTransport && new Direct(peerTransport(), {
      now,
      relay: (to, body) => this.send(body, to),
      message: (from, data) => (this.in = this.in.then(() => (typeof data === "string" ? this.opened(from, decode(data), "direct") : this.take(from, data, "direct", true))).catch(() => {})),
      change: () => {
        // a channel opened or closed: a peer moved between pipes, so each pipe's next body is a keyframe
        for (const p of this.pipes) p.to = { cursor: null, live: null };
        this.onChange();
      },
    });
  }

  get connected() {
    return this.id !== null;
  }

  /** Opens unless open already, waiting to retry, or refused for good. */
  connect() {
    this.wanted = true;
    if (!this.ws && !this.retrying && !this.stopped) this.open();
  }

  /** Closes, holding nothing: the relay drops a closed connection's holds. */
  close() {
    this.wanted = false;
    this.mine.clear();
    this.lastLive = null;
    for (const p of this.pipes) p.restart();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.reset();
  }

  open() {
    const url = new URL(this.relay);
    url.searchParams.set("space", this.space);
    const ws = this.makeSocket(url.href);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => ws === this.ws && this.frame({ t: "auth", token: encode(this.keys.relayToken), v: 2 });
    ws.onmessage = ({ data }) => {
      if (ws !== this.ws) return;
      // anything from the relay shows the socket is alive
      this.pingWaiting = null;
      this.in = this.in.then(() => (typeof data === "string" ? this.received(data) : this.receivedFrame(new Uint8Array(data)))).catch(() => {});
    };
    ws.onclose = (e) => ws === this.ws && this.dropped(e.code);
  }

  /** The socket closed with `code`, or was given up on: reconnects after a back-off, unless the token was refused. */
  dropped(code) {
    this.ws = null;
    this.reset();
    if (code === 4001) {
      this.stopped = true;
      return this.onUnauthorized();
    }
    if (!this.wanted) return;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.failures++);
    this.retrying = true;
    this.schedule(delay, () => {
      this.retrying = false;
      if (this.wanted && !this.ws && !this.stopped) this.open();
    });
  }

  reset() {
    const had = this.connected || this.peers.size || this.holds.size;
    this.id = null;
    this.pingWaiting = null;
    this.peers.clear();
    this.decoders.clear();
    this.holds.clear();
    this.roster.clear();
    this.direct?.reset();
    if (had) this.onChange();
  }

  /** A frame to the relay, after everything sent before it. */
  frame(f) {
    const ws = this.ws;
    this.out = this.out.then(() => {
      if (ws !== this.ws || ws.readyState !== 1) return;
      ws.send(JSON.stringify(f));
      this.relaySent = this.now();
    });
  }

  get pipes() {
    return [this.channels, this.relayPipe];
  }

  /** `plain` sealed; null when too big to send. */
  async seal(plain) {
    const sealed = await this.keys.sealLive(plain);
    return b64Length(sealed) > MAX_FRAME - 100 ? null : sealed;
  }

  /** Sealed `plain` through the relay to connection `to`, or to everyone else when null, after everything sent before it;
   * resolves to whether it went out. A relay that names connections without digits predates binary frames, so it gets
   * `{to?, body}` as JSON. */
  post(plain, to, fallback) {
    if (!this.connected) return Promise.resolve(false);
    const ws = this.ws;
    const binary = connNumber(this.id) !== null;
    const conn = to === null ? null : connNumber(to);
    if (binary && to !== null && conn === null) return Promise.resolve(false);
    const sent = this.out.then(async () => {
      let sealed = await this.seal(plain);
      if (fallback && (!sealed || b64Length(sealed) > MAX_PUSHED)) sealed = await this.seal(fallback);
      if (!sealed || ws !== this.ws || ws.readyState !== 1) return false;
      ws.send(binary ? relayFrame(conn, sealed) : JSON.stringify(to === null ? { body: encode(sealed) } : { to, body: encode(sealed) }));
      this.relaySent = this.now();
      return true;
    }).catch(() => false);
    this.out = sent;
    return sent;
  }

  /** A JSON body to everyone else, or to connection `to`, or `fallback` instead if that is over MAX_PUSHED. */
  send(body, to, fallback) {
    const json = (b) => enc.encode(JSON.stringify(b));
    return this.post(json(body), to ?? null, fallback && json(fallback));
  }

  /** Roster connections that see `board`, or all of them for null: by their `boards`, else their `board`, and any not
   * heard from yet. */
  recipients(board) {
    return [...this.roster.keys()].filter((id) => {
      const p = this.peers.get(id);
      return board === null || !p?.person || shows(p, board);
    });
  }

  /** Whether peer `p` sees this device's cursor board, and the board of its gesture under way. */
  watches(p) {
    return {
      cursor: Boolean(p.person && this.cursorBoard && shows(p, this.cursorBoard)),
      live: Boolean(p.person && this.mine.size && this.lastLive && shows(p, this.lastLive.board)),
    };
  }

  /** Peer `p` came to see this device's cursor or gesture, which `was` says it did not: they go again as they are now.
   * A keyframe when it was not among its pipe's last recipients; a peer without presence was, so it gets a delta on
   * what it was sent before. */
  caughtUp(p, was) {
    const now = this.watches(p);
    for (const pipe of this.pipes) {
      if (now.cursor && !was.cursor) pipe.cursor = true;
      if (now.live && !was.live) pipe.live = true;
      if (pipe.cursor || pipe.live) pipe.gate.run();
    }
  }

  stamp() {
    return { seq: ++this.seq, at: this.clock() - this.started, now: this.now() };
  }

  /** What waits on `pipe`: the latest live body for its board, with the cursor inside for compact recipients during a
   * gesture, then the latest cursor for whom that did not reach. */
  flush(pipe) {
    if (!this.connected) return;
    const live = pipe.live ? this.lastLive : null, cursor = pipe.cursor, everyone = cursor && pipe.everyone;
    const repeat = pipe.repeat;
    pipe.live = pipe.cursor = pipe.repeat = false;
    if (cursor) pipe.everyone = false;
    // the channels never resend, so the last cursor, maybe a hide, goes once more when the pointer is still
    if (cursor && pipe.direct && !repeat) {
      const n = ++this.cursorSends;
      this.schedule(CURSOR_REPEAT_MS, () => {
        if (n !== this.cursorSends || pipe.cursor) return;
        [pipe.cursor, pipe.repeat] = [true, true];
        pipe.gate.run();
      });
    }
    const c = this.cursor;
    const fold = cursor && !everyone && live && this.mine.size && c?.board === live.board ? [c.x, c.y] : null;
    let folded = [];
    if (live) {
      const json = { t: "live", board: live.board, items: trimmed(live.items, 100), caret: live.caret };
      folded = this.emit(pipe, "live", this.recipients(live.board), { ...live, cursor: fold }, json);
    }
    if (!cursor) return;
    const ids = this.recipients(everyone ? null : this.cursorBoard);
    const json = { t: "cursor", board: this.cursorBoard, x: c ? round(c.x, 100) : null, y: c ? round(c.y, 100) : null };
    this.emit(pipe, "cursor", ids, { board: this.cursorBoard, x: c?.x ?? null, y: c?.y ?? null }, json, fold ? folded : []);
  }

  /** A cursor or live body to those of `ids` on `pipe`, but `folded`, which had it inside the live body: compact where
   * they read it, else JSON; → who got it compact. */
  emit(pipe, kind, ids, body, json, folded = []) {
    ids = ids.filter((id) => (this.direct?.isOpen(id) ?? false) === pipe.direct && !folded.includes(id));
    // whoever this pipe's encoder last sent to missed this body, unless it came inside the live body
    if (!ids.length && !folded.length) pipe.to[kind] = null;
    if (!ids.length) return [];
    const stamp = this.stamp();
    const plain = () => enc.encode(JSON.stringify({ ...json, at: round(stamp.at, 10), seq: stamp.seq }));
    if (pipe.direct) {
      const v2 = ids.filter((id) => this.direct.version(id) === 2), v1 = ids.filter((id) => !v2.includes(id));
      if (!v2.length && !folded.length) pipe.to[kind] = null;
      const bytes = v2.length ? pipe.compact(kind, v2, body, stamp) : null;
      if (bytes) for (const id of v2) this.direct.sendBytes(id, bytes);
      if (v1.length) {
        const text = plain();
        this.out = this.out.then(async () => {
          const sealed = await this.seal(text);
          if (sealed) for (const id of v1) this.direct.send(id, encode(sealed));
        }).catch(() => {});
      }
      return bytes ? v2 : [];
    }
    const to = ids.length === 1 ? ids[0] : null;
    if (ids.every((id) => this.peers.get(id)?.v === 2)) {
      const bytes = pipe.compact(kind, ids, body, stamp);
      if (bytes) this.post(bytes, to);
      return bytes ? ids : [];
    }
    // its compact encoder's last body did not reach these
    pipe.to[kind] = null;
    this.post(plain(), to);
    return [];
  }

  async received(text) {
    if (text === "pong") return;
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    switch (m?.t) {
      case "welcome":
        this.id = m.id;
        this.failures = 0;
        this.pingSent = this.now();
        this.holds = holdsFrom(m.holds);
        this.roster = new Map((Array.isArray(m.peers) ? m.peers.filter((p) => typeof p === "string") : []).map((p) => [p, this.now()]));
        this.direct?.welcome([...this.roster.keys()]);
        this.sendPresence();
        if (this.mine.size) this.frame({ t: "hold", ids: [...this.mine].sort() });
        return this.onChange();
      case "join":
        this.roster.set(m.id, this.now());
        return this.sendPresence(m.id);
      case "leave":
        this.peers.delete(m.id);
        this.decoders.delete(m.id);
        this.holds.delete(m.id);
        this.roster.delete(m.id);
        this.direct?.leave(m.id);
        return this.onChange();
      case "holds":
        this.holds = holdsFrom(m.holds);
        this.dropReleased();
        return this.onChange();
      case "refused":
        if (Array.isArray(m.ids) && m.ids.length) this.onRefused(new Set(m.ids));
        return;
    }
    if (typeof m?.from === "string" && typeof m.body === "string") await this.opened(m.from, decode(m.body), "relay");
  }

  /** A binary frame from the relay: the sender's number, then the sealed body. */
  async receivedFrame(bytes) {
    const f = parseRelayFrame(bytes);
    if (f) await this.opened(String(f.from), f.body, "relay");
  }

  /** A sealed body from connection `from`, through `pipe`. */
  async opened(from, sealed, pipe) {
    let plain;
    try {
      plain = await this.keys.openLive(sealed);
    } catch {
      return;
    }
    this.take(from, plain, pipe);
  }

  /** A body from connection `from`, compact or JSON; a channel carries only cursors and live edits, and a version 2
   * channel only compact ones. */
  take(from, plain, pipe, compactOnly = false) {
    if (!this.connected) return;
    let b = null;
    if (isCompact(plain)) {
      if (!this.decoders.has(from)) this.decoders.set(from, { direct: new LiveDecoder(), relay: new LiveDecoder() });
      b = this.decoders.get(from)[pipe].decode(plain, this.peers.get(from)?.overlay);
    } else if (!compactOnly) {
      try {
        b = JSON.parse(dec.decode(plain));
      } catch {}
    }
    if (!b) return;
    this.roster.set(from, this.now());
    if (["offer", "answer", "ice"].includes(b.t)) return pipe === "direct" || this.direct?.heard(from, b);
    if (pipe === "direct" && b.t !== "cursor" && b.t !== "live") return;
    this.heard(from, b);
  }

  heard(from, b) {
    const now = this.now();
    const p = this.peers.get(from) ?? { person: null, board: null, selection: [], cursor: null, cursorAt: 0, overlay: new Map(), overlayBoard: null, caret: null, awaiting: 0, cursorTrack: null, motion: new Map(), seqs: {}, unheld: new Map() };
    p.heard = now;
    const arrival = this.clock();
    const at = Number.isFinite(b?.at) ? b.at : arrival;
    // a body older than one already taken from this connection, over either pipe, is dropped
    if ((b?.t === "cursor" || b?.t === "live") && integral(b.seq)) {
      if (b.seq <= (p.seqs[b.t] ?? 0)) return;
      p.seqs[b.t] = b.seq;
    }
    switch (b?.t) {
      case "presence": {
        if (decode(b.device)?.length !== 16) return;
        const was = this.watches(p);
        p.person = personOf(b.device, String(b.name ?? "").slice(0, 100));
        p.v = typeof b.v === "number" && b.v >= 2 ? 2 : 1;
        p.board = typeof b.board === "string" ? b.board : null;
        p.boards = Array.isArray(b.boards) ? b.boards.filter((x) => typeof x === "string") : null;
        p.selection = Array.isArray(b.selection) ? b.selection.filter((x) => typeof x === "string") : [];
        // a cursor not heard yet, as a newcomer gets it; later ones come as cursor messages, so a faded one stays faded
        if ("cursor" in b && !p.cursorAt) [p.cursor, p.cursorAt] = [pointOf(b.cursor), now];
        this.caughtUp(p, was);
        break;
      }
      case "cursor":
        this.moved(p, pointOf(b), at, arrival);
        break;
      case "live": {
        const board = typeof b.board === "string" ? b.board : null;
        if (board !== p.overlayBoard) p.motion.clear();
        p.overlayBoard = board;
        for (const [id, f] of Object.entries(b.items ?? {})) {
          if (!f || typeof f !== "object") continue;
          p.overlay.set(id, { ...p.overlay.get(id), ...pick(f) });
          if (this.holds.get(from)?.has(id)) p.unheld.delete(id);
          else p.unheld.set(id, now);
          for (const k of MOVING) {
            const v = numbers(f[k]);
            if (!v) continue;
            const key = `${id} ${k}`;
            if (!p.motion.has(key)) p.motion.set(key, new Track());
            const t = p.motion.get(key);
            // a value of another length than the track's cannot be played back with it
            if (t.samples.length && t.samples.at(-1).value.length !== v.length) continue;
            t.push(at, arrival, v);
          }
        }
        p.caret = caretOf(b.caret);
        // a cursor inside a live body counts as a cursor body with its seq
        const c = Array.isArray(b.cursor) && pointOf({ board, x: b.cursor[0], y: b.cursor[1] });
        if (c && integral(b.seq) && b.seq > (p.seqs.cursor ?? 0)) {
          p.seqs.cursor = b.seq;
          this.moved(p, c, at, arrival);
        }
        break;
      }
      case "pushed":
        if (!integral(b.version) || b.version < 0) return;
        p.awaiting = Math.max(p.awaiting, b.version);
        break;
      default:
        return;
    }
    this.peers.set(from, p);
    if (b.t === "pushed") {
      const ok = Array.isArray(b.records) && b.records.every((r) => r && typeof r.id === "string" && typeof r.blob === "string" && integral(r.version));
      this.onPushed(b.version, ok ? { epoch: b.epoch, records: b.records } : null);
    }
    this.dropReleased();
    this.onChange();
  }

  /** Peer `p`'s cursor is at `c`, or hidden for null, as of its sender's `at`. */
  moved(p, c, at, arrival) {
    if (!c || c.board !== p.cursor?.board) p.cursorTrack = null;
    if (c) (p.cursorTrack ??= new Track()).push(at, arrival, [c.x, c.y]);
    [p.cursor, p.cursorAt] = [c, this.now()];
  }

  /** Overlays of items no longer held go, unless their holder pushed a version not pulled yet. One not held yet stays
   * HOLD_GRACE_MS after its last live body, as that may come direct before the relay says it is held. */
  dropReleased() {
    const now = this.now();
    for (const [conn, p] of this.peers) {
      if (p.awaiting > this.storeCursor) continue;
      p.awaiting = 0;
      const held = this.holds.get(conn) ?? new Set();
      for (const id of [...p.overlay.keys()]) {
        const since = p.unheld.get(id);
        if (held.has(id)) p.unheld.delete(id);
        else if (since === undefined || now - since >= HOLD_GRACE_MS) {
          p.overlay.delete(id);
          p.unheld.delete(id);
        }
      }
      for (const key of [...p.motion.keys()]) if (!p.overlay.has(key.slice(0, key.indexOf(" ")))) p.motion.delete(key);
      if (!held.size && !p.unheld.size) p.caret = null;
    }
  }

  /** The store pulled up to `cursor`: overlays waiting for it can go. */
  noteCursor(cursor) {
    this.storeCursor = Math.max(this.storeCursor, cursor);
    this.dropReleased();
    this.onChange();
  }

  /** About once a second: forgets the silent, fades still cursors, repeats presence, tells the relay a holder is still
   * here, and checks that the relay still answers. */
  tick() {
    const now = this.now();
    if (this.connected && this.pingWaiting !== null && now - this.pingWaiting >= PONG_TIMEOUT_MS) {
      const ws = this.ws;
      this.dropped(1006);
      return ws?.close();
    }
    if (this.connected && this.pingWaiting === null && now - this.pingSent >= PING_MS) {
      this.pingSent = this.pingWaiting = now;
      if (this.ws.readyState === 1) this.ws.send("ping");
    }
    this.direct?.tick();
    let changed = false;
    // a connection that never speaks, such as one in another space with this one's token, would keep every cursor on
    // the relay
    for (const [id, heard] of this.roster) {
      if (now - heard < GONE_MS) continue;
      this.roster.delete(id);
      this.direct?.leave(id);
      changed = true;
    }
    for (const [conn, p] of this.peers) {
      if (now - p.heard > GONE_MS) {
        this.peers.delete(conn);
        this.decoders.delete(conn);
        changed = true;
      } else if (p.cursor && now - p.cursorAt > IDLE_CURSOR_MS) {
        p.cursor = null;
        changed = true;
      }
    }
    // a holder the relay has not heard from lately, as live edits may go only direct, keeps its holds there
    if (this.connected && this.mine.size && now - this.relaySent >= HEARTBEAT_MS) {
      this.relaySent = now;
      this.frame({ t: "alive" });
    }
    if ([...this.peers.values()].some((p) => p.unheld.size)) {
      this.dropReleased();
      changed = true;
    }
    if (this.connected && now - this.presenceSent >= PRESENCE_MS) this.sendPresence();
    if (changed) this.onChange();
  }

  setMe(me) {
    if (me.device === this.me.device && me.name === this.me.name) return;
    this.me = me;
    this.sendPresence();
  }

  /** Where this device is: `board`, every board it shows (`boards`, `board` alone by default), and what it selected. */
  setPresence({ board, boards = board ? [board] : [], selection }) {
    const next = { board, boards, selection };
    if (JSON.stringify(next) === JSON.stringify(this.presence)) return;
    this.presence = next;
    this.sendPresence();
  }

  sendPresence(to) {
    if (!this.connected) return;
    if (!to) this.presenceSent = this.now();
    const { device, name } = this.me;
    const c = this.cursor && { board: this.cursor.board, x: round(this.cursor.x, 100), y: round(this.cursor.y, 100) };
    this.send({ t: "presence", v: 2, device, name, ...this.presence, cursor: c }, to);
  }

  /** This device's pointer on `board`; null x and y hide it. Each pipe sends the latest when its gate lets it; none while
   * nobody else is here, as a newcomer gets it with the presence sent when it joins. */
  sendCursor(board, x, y) {
    this.cursor = Number.isFinite(x) && Number.isFinite(y) ? { board, x: clamp(x), y: clamp(y) } : null;
    if (board !== this.cursorBoard) for (const p of this.pipes) p.everyone = true;
    this.cursorBoard = board;
    if (!this.roster.size) return;
    for (const p of this.pipes) {
      [p.cursor, p.repeat] = [true, false];
      p.gate.run();
    }
  }

  /** Asks the relay for `ids`; `onRefused` tells if someone else has any. Asked again after a reconnect. Starts a
   * gesture, whose first live body is a keyframe. */
  hold(ids) {
    for (const p of this.pipes) p.restart();
    const fresh = [...ids].filter((id) => !this.mine.has(id));
    if (!fresh.length) return;
    for (const id of fresh) this.mine.add(id);
    if (this.connected) this.frame({ t: "hold", ids: fresh.sort() });
  }

  release() {
    if (!this.mine.size) return;
    this.mine.clear();
    this.lastLive = null;
    for (const p of this.pipes) p.restart();
    if (this.connected) this.frame({ t: "release" });
  }

  /** What the gesture under way changed of what it holds, and where the held items were when it began (`starts`, as
   * `{id: [x, y]}`); each pipe sends the latest when its gate lets it. */
  sendLive(board, items, caret = null, starts = {}) {
    this.lastLive = { board, items: trimmed(items), caret, starts };
    if (!this.roster.size) return;
    for (const p of this.pipes) {
      p.live = true;
      p.gate.run();
    }
  }

  /** "Direct with 1 of 2 people", for the status lines, while anyone else is here. */
  directStatus() {
    const people = [...this.roster.keys()];
    if (!people.length) return null;
    const open = people.filter((id) => this.direct?.isOpen(id)).length;
    return `Direct with ${open} of ${people.length} ${people.length === 1 ? "person" : "people"}`;
  }

  /** Announces a push with its records, or without them when they would not fit a frame. */
  sendPushed({ version, epoch, records }) {
    return this.send({ t: "pushed", version, epoch, records }, undefined, { t: "pushed", version });
  }

  /** Ids another connection holds. */
  taken() {
    const out = new Set();
    for (const [conn, ids] of this.holds) if (conn !== this.id) for (const id of ids) out.add(id);
    return out;
  }

  /** Who holds `id`, if another connection does. */
  holderOf(id) {
    for (const [conn, ids] of this.holds) if (conn !== this.id && ids.has(id)) return this.peers.get(conn)?.person ?? personOf("", "");
    return null;
  }

  /** Others' live fields on `board` as they play back now, leaving out what this device holds: its own gesture draws
   * from its model. */
  overlay(board) {
    const now = this.clock();
    const out = new Map();
    for (const p of this.peers.values()) {
      if (p.overlayBoard !== board) continue;
      for (const [id, f] of p.overlay) {
        if (this.mine.has(id)) continue;
        const shown = { ...f };
        for (const k of MOVING) {
          const t = p.motion.get(`${id} ${k}`);
          if (t && k in f) shown[k] = k === "w" ? t.sample(now)[0] : t.sample(now);
        }
        out.set(id, shown);
      }
    }
    return out;
  }

  cursors(board) {
    const now = this.clock();
    return [...this.peers].filter(([, p]) => p.person && p.cursor?.board === board).map(([key, p]) => {
      const [x, y] = p.cursorTrack?.sample(now) ?? [p.cursor.x, p.cursor.y];
      return { key, person: p.person, x, y };
    });
  }

  /** Whether any cursor or live edit on `board` is still playing back, so that it draws again next frame. */
  animating(board) {
    const now = this.clock();
    for (const p of this.peers.values()) {
      if (p.cursor?.board === board && p.cursorTrack?.playing(now)) return true;
      if (p.overlayBoard === board) for (const t of p.motion.values()) if (t.playing(now)) return true;
    }
    return false;
  }

  carets(board) {
    return [...this.peers].filter(([, p]) => p.person && p.caret && p.overlayBoard === board).map(([key, p]) => ({ key, person: p.person, ...p.caret }));
  }

  /** The people on `board`, once each and not this device's, by name. */
  people(board) {
    const byDevice = new Map();
    for (const p of this.peers.values()) if (p.person && p.board === board && p.person.device !== this.me.device) byDevice.set(p.person.device, p.person);
    return [...byDevice.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** What the people on `board` have selected, and who. */
  selections(board) {
    const out = new Map();
    for (const p of this.peers.values()) if (p.person && p.board === board) for (const id of p.selection) out.set(id, p.person);
    return out;
  }
}
