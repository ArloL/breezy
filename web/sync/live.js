// A space's live layer over its relay: who is here and where, what they hold, and their edits as they happen, as
// BreezyKit's Live; see the multiplayer design. Bodies are sealed with the space key, so the relay reads none of them.
import { encode, decode } from "./base64.js";
import { LIVE_FIELDS } from "./overlay.js";
import { Track } from "./track.js";
import { Direct } from "./direct.js";
import { RTCTransport } from "./rtc.js";

export const PALETTE = ["#e5484d", "#f76b15", "#12a594", "#8e4ec6", "#3e63dd", "#e93d82", "#ad7f58", "#00a2c7"];
export const SEND_MS = 50;
export const DIRECT_SEND_MS = 8;
export const HEARTBEAT_MS = 5_000;
export const PRESENCE_MS = 15_000;
export const GONE_MS = 30_000;
export const IDLE_CURSOR_MS = 60_000;
export const MAX_BACKOFF_MS = 30_000;
export const PING_MS = 20_000;
export const PONG_TIMEOUT_MS = 10_000;
const MAX_FRAME = 65_536;
const enc = new TextEncoder(), dec = new TextDecoder();

/** The live fields that move, played back through a track. */
const MOVING = ["pos", "size", "w"];
const numbers = (v) => (Number.isFinite(v) ? [v] : Array.isArray(v) && v.every(Number.isFinite) ? v : null);

export const colourOf = (device) => PALETTE[(decode(device)?.[0] ?? 0) % PALETTE.length];

/** One or two letters for avatars. */
export function initials(name) {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0].toUpperCase()).join("") || "?";
}

const personOf = (device, name) => ({ device, name, colour: colourOf(device) });
const pointOf = (c) => (c && typeof c.board === "string" && Number.isFinite(c.x) && Number.isFinite(c.y) ? { board: c.board, x: c.x, y: c.y } : null);
const caretOf = (c) =>
  c && typeof c.id === "string" && typeof c.back === "boolean" && Number.isInteger(c.at) && c.at >= 0 ? { id: c.id, back: c.back, at: c.at } : null;
const pick = (f) => Object.fromEntries(Object.entries(f).filter(([k]) => k === "kind" || LIVE_FIELDS.includes(k)));
const holdsFrom = (h) => new Map(Object.entries(h ?? {}).filter(([, ids]) => Array.isArray(ids)).map(([k, ids]) => [k, new Set(ids)]));

/** Runs the latest `go` at most every SEND_MS: at once when it may, else once when it may again. */
class Gate {
  constructor(live) {
    this.live = live;
    this.sent = -Infinity;
    this.queued = false;
    this.go = null;
  }

  run(go) {
    this.go = go;
    const wait = this.live.sendMs - (this.live.now() - this.sent);
    if (wait <= 0) return this.fire();
    if (this.queued) return;
    this.queued = true;
    this.live.schedule(wait, () => {
      this.queued = false;
      this.fire();
    });
  }

  fire() {
    this.sent = this.live.now();
    this.go();
  }
}

export class Live {
  constructor({ relay, space, keys, me, socket = (url) => new WebSocket(url), now = () => Date.now(), clock = () => performance.now(), schedule = (ms, fn) => setTimeout(fn, ms), peerTransport = typeof RTCPeerConnection === "function" ? () => new RTCTransport() : null }) {
    Object.assign(this, { relay, space, keys, me, makeSocket: socket, now, clock, schedule });
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
    /** Connection id → { person, board, selection, cursor, cursorAt, heard, overlay: Map, overlayBoard, caret, awaiting }. */
    this.peers = new Map();
    /** Connection id → the ids it holds. */
    this.holds = new Map();
    /** What this connection holds, or has asked to. */
    this.mine = new Set();
    this.presence = { board: null, selection: [] };
    this.cursor = null;
    this.cursorBoard = "";
    this.presenceSent = -Infinity;
    this.cursorGate = new Gate(this);
    this.liveGate = new Gate(this);
    this.lastLive = null;
    /** When a frame last reached the relay, which keeps this connection's holds there while it hears from it. */
    this.relaySent = -Infinity;
    this.storeCursor = 0;
    this.out = Promise.resolve();
    this.in = Promise.resolve();
    this.onChange = () => {};
    this.onPushed = () => {};
    this.onRefused = () => {};
    this.onUnauthorized = () => {};
    /** The other connections in the space, as the relay names them. */
    this.roster = new Set();
    this.direct = peerTransport && new Direct(peerTransport(), {
      now,
      relay: (to, body) => this.send(body, to),
      message: (from, text) => (this.in = this.in.then(() => this.opened(from, text, true)).catch(() => {})),
      change: () => this.onChange(),
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
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.reset();
  }

  open() {
    const url = new URL(this.relay);
    url.searchParams.set("space", this.space);
    const ws = this.makeSocket(url.href);
    this.ws = ws;
    ws.onopen = () => ws === this.ws && this.frame({ t: "auth", token: encode(this.keys.relayToken) });
    ws.onmessage = (e) => {
      if (ws !== this.ws) return;
      // anything from the relay shows the socket is alive
      this.pingWaiting = null;
      this.in = this.in.then(() => this.received(String(e.data))).catch(() => {});
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

  /** `body` sealed, as base64url; null when too big to send. */
  async seal(body) {
    const sealed = encode(await this.keys.sealLive(enc.encode(JSON.stringify(body))));
    return sealed.length > MAX_FRAME - 100 ? null : sealed;
  }

  /** A sealed body to everyone else, or to connection `to`; resolves to whether it went out. */
  send(body, to) {
    if (!this.connected) return Promise.resolve(false);
    const ws = this.ws;
    const sent = this.out.then(async () => {
      const sealed = await this.seal(body);
      if (!sealed || ws !== this.ws || ws.readyState !== 1) return false;
      ws.send(JSON.stringify(to ? { to, body: sealed } : { body: sealed }));
      this.relaySent = this.now();
      return true;
    }).catch(() => false);
    this.out = sent;
    return sent;
  }

  /** Whether every other connection has an open channel. */
  get allDirect() {
    return this.roster.size > 0 && [...this.roster].every((id) => this.direct?.isOpen(id));
  }

  get sendMs() {
    return this.allDirect ? DIRECT_SEND_MS : SEND_MS;
  }

  /** A cursor or live body, stamped with this device's time and the next sequence number: over every open channel, and
   * to the relay unless all are open; `relayOnly` for the holder's heartbeat, which keeps the holds there. */
  sendFast(body, { relayOnly = false } = {}) {
    if (!this.connected) return Promise.resolve(false);
    const stamped = { ...body, at: this.clock(), seq: ++this.seq };
    const ws = this.ws;
    const sent = this.out.then(async () => {
      const sealed = await this.seal(stamped);
      if (!sealed || ws !== this.ws) return false;
      if (!relayOnly) for (const id of this.roster) this.direct?.send(id, sealed);
      if ((relayOnly || !this.allDirect) && ws.readyState === 1) {
        ws.send(JSON.stringify({ body: sealed }));
        this.relaySent = this.now();
      }
      return true;
    }).catch(() => false);
    this.out = sent;
    return sent;
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
        this.roster = new Set(Array.isArray(m.peers) ? m.peers.filter((p) => typeof p === "string") : []);
        this.direct?.welcome([...this.roster]);
        this.sendPresence();
        if (this.mine.size) this.frame({ t: "hold", ids: [...this.mine].sort() });
        return this.onChange();
      case "join":
        this.roster.add(m.id);
        return this.sendPresence(m.id);
      case "leave":
        this.peers.delete(m.id);
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
    if (typeof m?.from === "string" && typeof m.body === "string") await this.opened(m.from, m.body, false);
  }

  /** A sealed body from connection `from`, through the relay or, `direct`, over its channel, which carries only
   * cursors and live edits. */
  async opened(from, body, direct) {
    let b;
    try {
      b = JSON.parse(dec.decode(await this.keys.openLive(decode(body))));
    } catch {
      return;
    }
    if (!this.connected) return;
    if (["offer", "answer", "ice"].includes(b?.t)) return direct || this.direct?.heard(from, b);
    if (direct && b?.t !== "cursor" && b?.t !== "live") return;
    this.heard(from, b);
  }

  heard(from, b) {
    const now = this.now();
    const p = this.peers.get(from) ?? { person: null, board: null, selection: [], cursor: null, cursorAt: 0, overlay: new Map(), overlayBoard: null, caret: null, awaiting: 0, cursorTrack: null, motion: new Map(), seqs: {} };
    p.heard = now;
    const arrival = this.clock();
    const at = Number.isFinite(b?.at) ? b.at : arrival;
    // a body older than one already taken from this connection, over either pipe, is dropped
    if ((b?.t === "cursor" || b?.t === "live") && Number.isInteger(b.seq)) {
      if (b.seq <= (p.seqs[b.t] ?? 0)) return;
      p.seqs[b.t] = b.seq;
    }
    switch (b?.t) {
      case "presence":
        if (decode(b.device)?.length !== 16) return;
        p.person = personOf(b.device, String(b.name ?? "").slice(0, 100));
        p.board = typeof b.board === "string" ? b.board : null;
        p.selection = Array.isArray(b.selection) ? b.selection.filter((x) => typeof x === "string") : [];
        // a cursor not heard yet, as a newcomer gets it; later ones come as cursor messages, so a faded one stays faded
        if ("cursor" in b && !p.cursorAt) [p.cursor, p.cursorAt] = [pointOf(b.cursor), now];
        break;
      case "cursor": {
        const c = pointOf(b);
        if (!c || c.board !== p.cursor?.board) p.cursorTrack = null;
        if (c) (p.cursorTrack ??= new Track()).push(at, arrival, [c.x, c.y]);
        [p.cursor, p.cursorAt] = [c, now];
        break;
      }
      case "live": {
        const board = typeof b.board === "string" ? b.board : null;
        if (board !== p.overlayBoard) p.motion.clear();
        p.overlayBoard = board;
        for (const [id, f] of Object.entries(b.items ?? {})) {
          if (!f || typeof f !== "object") continue;
          p.overlay.set(id, { ...p.overlay.get(id), ...pick(f) });
          for (const k of MOVING) {
            const v = numbers(f[k]);
            if (!v) continue;
            const key = `${id} ${k}`;
            if (!p.motion.has(key)) p.motion.set(key, new Track());
            p.motion.get(key).push(at, arrival, v);
          }
        }
        p.caret = caretOf(b.caret);
        break;
      }
      case "pushed":
        if (!Number.isInteger(b.version) || b.version < 0) return;
        p.awaiting = Math.max(p.awaiting, b.version);
        break;
      default:
        return;
    }
    this.peers.set(from, p);
    if (b.t === "pushed") this.onPushed(b.version);
    this.dropReleased();
    this.onChange();
  }

  /** Overlays of items no longer held go, unless their holder pushed a version not pulled yet. */
  dropReleased() {
    for (const [conn, p] of this.peers) {
      if (p.awaiting > this.storeCursor) continue;
      p.awaiting = 0;
      const held = this.holds.get(conn) ?? new Set();
      for (const id of [...p.overlay.keys()]) if (!held.has(id)) p.overlay.delete(id);
      for (const key of [...p.motion.keys()]) if (!p.overlay.has(key.slice(0, key.indexOf(" ")))) p.motion.delete(key);
      if (!held.size) p.caret = null;
    }
  }

  /** The store pulled up to `cursor`: overlays waiting for it can go. */
  noteCursor(cursor) {
    this.storeCursor = Math.max(this.storeCursor, cursor);
    this.dropReleased();
    this.onChange();
  }

  /** About once a second: forgets the silent, fades still cursors, repeats presence and a holder's live fields, and checks
   * that the relay still answers. */
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
    for (const [conn, p] of this.peers) {
      if (now - p.heard > GONE_MS) {
        this.peers.delete(conn);
        changed = true;
      } else if (p.cursor && now - p.cursorAt > IDLE_CURSOR_MS) {
        p.cursor = null;
        changed = true;
      }
    }
    // a holder the relay has not heard from lately: live edits that go only direct do not reach it
    if (this.connected && this.mine.size && now - this.relaySent >= HEARTBEAT_MS) {
      this.relaySent = now;
      const minimal = { t: "live", board: this.presence.board ?? this.cursorBoard, items: {}, caret: null };
      (this.lastLive ? this.sendFast(this.lastLive, { relayOnly: true }) : Promise.resolve(false)).then((ok) => ok || this.sendFast(minimal, { relayOnly: true }));
    }
    if (this.connected && now - this.presenceSent >= PRESENCE_MS) this.sendPresence();
    if (changed) this.onChange();
  }

  setMe(me) {
    if (me.device === this.me.device && me.name === this.me.name) return;
    this.me = me;
    this.sendPresence();
  }

  setPresence({ board, selection }) {
    if (board === this.presence.board && JSON.stringify(selection) === JSON.stringify(this.presence.selection)) return;
    this.presence = { board, selection };
    this.sendPresence();
  }

  sendPresence(to) {
    if (!this.connected) return;
    if (!to) this.presenceSent = this.now();
    const { device, name } = this.me;
    this.send({ t: "presence", device, name, colour: colourOf(device), board: this.presence.board, selection: this.presence.selection, cursor: this.cursor }, to);
  }

  /** This device's pointer on `board`; null x and y hide it. At most every 50 ms, and the last one always goes; none while
   * nobody else is here, as a newcomer gets it with the presence sent when it joins. */
  sendCursor(board, x, y) {
    this.cursor = Number.isFinite(x) && Number.isFinite(y) ? { board, x, y } : null;
    this.cursorBoard = board;
    if (!this.peers.size) return;
    this.cursorGate.run(() => this.sendFast({ t: "cursor", board: this.cursorBoard, x: this.cursor?.x ?? null, y: this.cursor?.y ?? null }));
  }

  /** Asks the relay for `ids`; `onRefused` tells if someone else has any. Asked again after a reconnect. */
  hold(ids) {
    const fresh = [...ids].filter((id) => !this.mine.has(id));
    if (!fresh.length) return;
    for (const id of fresh) this.mine.add(id);
    if (this.connected) this.frame({ t: "hold", ids: fresh.sort() });
  }

  release() {
    if (!this.mine.size) return;
    this.mine.clear();
    this.lastLive = null;
    if (this.connected) this.frame({ t: "release" });
  }

  /** What the gesture under way changed of what it holds; at most every 50 ms, and repeated every 5 s while held, which
   * keeps the holds even while nobody else is here to be sent the rest. */
  sendLive(board, items, caret = null) {
    this.lastLive = { t: "live", board, items, caret };
    if (!this.peers.size) return;
    this.liveGate.run(() => this.lastLive && this.sendFast(this.lastLive));
  }

  /** "Direct with 1 of 2 people", for the status lines, while anyone else is here. */
  directStatus() {
    const people = [...this.roster].filter((id) => this.peers.get(id)?.person);
    if (!people.length) return null;
    const open = people.filter((id) => this.direct?.isOpen(id)).length;
    return `Direct with ${open} of ${people.length} ${people.length === 1 ? "person" : "people"}`;
  }

  sendPushed(version) {
    this.send({ t: "pushed", version });
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

  /** Whether any cursor or live edit is still playing back, so that the board draws again next frame. */
  animating() {
    const now = this.clock();
    for (const p of this.peers.values()) {
      if (p.cursor && p.cursorTrack?.playing(now)) return true;
      for (const t of p.motion.values()) if (t.playing(now)) return true;
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
