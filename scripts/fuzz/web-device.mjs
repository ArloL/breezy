// Web devices in the hub's process, answering the same commands as breezy-sim: each is the web app's Spaces, model,
// binding and Collab with its I/O carried by the hub, on virtual time.
import * as V from "./virtual.mjs";
import { Spaces } from "../../web/sync/spaces.js";
import { GestureHolds } from "../../web/sync/gesture-holds.js";
import { Collab } from "../../web/sync/collab.js";
import { Model } from "../../web/model.js";
import { Binding } from "../../web/binding.js";
import * as R from "../../web/rules.js";
import { encode, decode } from "../../web/sync/base64.js";

/** Card heights as both device kinds measure them here: restacking stays local, so they need only be stable. */
export const heightOf = (text) => 72 + 24 * Math.max(1, String(text ?? "").split("\n").length);

const bytesOf = (data) => (data instanceof Uint8Array ? data : new Uint8Array(data));

class Socket {
  constructor(device, sock, url) {
    Object.assign(this, { device, sock, url, readyState: 0, binaryType: "blob", onopen: null, onmessage: null, onclose: null });
  }

  send(data) {
    if (this.readyState !== 1) return;
    this.device.emit(typeof data === "string" ? { ev: "ws-send", sock: this.sock, text: data } : { ev: "ws-send", sock: this.sock, bytes: encode(bytesOf(data)) });
  }

  close() {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.device.emit({ ev: "ws-close", sock: this.sock });
  }
}

/** Direct's transport, with the channels the hub simulates. */
class Peer {
  constructor(device) {
    this.device = device;
    this.open = new Set();
    this.calls = new Map();
    this.onCandidate = () => {};
    this.onState = () => {};
    this.onMessage = () => {};
  }

  call(ev, peer, extra) {
    const call = ++this.device.calls;
    this.device.emit({ ev, peer, call, ...extra });
    return new Promise((resolve) => this.device.peerCalls.set(call, resolve));
  }

  create(peer) {
    this.open.delete(peer);
    this.device.emit({ ev: "peer-create", peer });
  }

  offer(peer, restart) {
    return this.call("peer-offer", peer, { restart: !!restart });
  }

  answer(peer, sdp) {
    return this.call("peer-answer", peer, { sdp });
  }

  async accept(peer, sdp) {
    await this.call("peer-accept", peer, { sdp });
  }

  add(peer, candidate) {
    this.device.emit({ ev: "peer-add", peer, candidate });
  }

  send(peer, text) {
    if (!this.open.has(peer)) return false;
    this.device.emit({ ev: "peer-send", peer, text });
    return true;
  }

  sendBytes(peer, bytes) {
    if (!this.open.has(peer)) return false;
    this.device.emit({ ev: "peer-send", peer, bytes: encode(bytesOf(bytes)) });
    return true;
  }

  close(peer) {
    this.open.delete(peer);
    this.device.emit({ ev: "peer-close", peer });
  }
}

class WebDevice {
  constructor(index, me, seed) {
    this.index = index;
    this.ctx = new V.Context(index, seed);
    this.out = [];
    this.requests = new Map();
    this.sockets = new Map();
    this.peerCalls = new Map();
    this.calls = 0;
    this.nextReq = 0;
    this.nextSock = 0;
    this.visible = true;
    this.peer = null;
    this.open = null;
    this.holds = new GestureHolds();
    const storage = { loadAll: async () => ({}), save: async () => {}, remove: async () => {} };
    V.run(this.ctx, () => {
      this.spaces = new Spaces(storage, { me }, {
        socket: (url) => {
          const s = new Socket(this, ++this.nextSock, url);
          this.sockets.set(s.sock, s);
          this.emit({ ev: "ws-connect", sock: s.sock, url });
          return s;
        },
        peerTransport: () => (this.peer = new Peer(this)),
      });
      this.spaces.onLive = () => this.updateLive();
      this.spaces.onChange = (g, boards, remote) => {
        if (!this.open || g !== this.group || !boards.has(this.open.id)) return;
        if (g.store.title(this.open.id) === null) return this.close();
        if (remote) this.open.binding.pull();
      };
      this.spaces.flushLocal = () => this.open?.binding.flush();
      setInterval(() => this.collab?.tick(), 1000);
      setInterval(() => this.spaces.syncAll({ polling: true }), 5000);
    });
  }

  emit(e) {
    this.out.push({ ...e, dev: this.index });
  }

  get group() {
    return this.spaces.spaces[0] ?? null;
  }

  /** What the hub's `fetch` does for this device: the request goes out, its answer comes with an `http` command. */
  fetch(url, init = {}) {
    this.ctx.online = true;
    const req = ++this.nextReq;
    const body = init.body == null ? null : encode(typeof init.body === "string" ? new TextEncoder().encode(init.body) : bytesOf(init.body));
    this.emit({ ev: "http", req, method: init.method ?? "GET", url: String(url), headers: init.headers ?? {}, body });
    return new Promise((resolve, reject) => {
      const signal = init.signal;
      const abort = () => {
        if (!this.requests.delete(req)) return;
        this.emit({ ev: "http-cancel", req });
        reject(new DOMException("aborted", "AbortError"));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort);
      this.requests.set(req, { resolve, reject, done: () => signal?.removeEventListener("abort", abort) });
    });
  }

  updateLive() {
    const g = this.group;
    if (!g?.live) return;
    if (this.visible) g.live.connect();
    else g.live.close();
    const board = this.open?.id ?? null;
    g.live.setPresence({ board, boards: board ? [board] : [], selection: [] });
  }

  get collab() {
    const g = this.group;
    if (!g) return null;
    if (this.collabOf !== g) {
      this.collabOf = g;
      this._collab = new Collab(g, this.holds);
    }
    return this._collab;
  }

  restack(b) {
    R.gravity(b, (id) => heightOf(R.card(b, id)?.text));
  }

  openBoard(id) {
    this.close();
    const g = this.group;
    if (!g || id == null || g.store.title(id) === null) return;
    const b = g.store.board(id);
    this.restack(b);
    const model = new Model(b);
    const binding = new Binding(g.store, model, id, (x) => this.restack(x));
    binding.taken = () => g.live?.taken() ?? new Set();
    const session = this.collab.open(id, model, binding);
    model.onChange = () => {
      binding.changed();
      session.edited();
    };
    this.open = { id, model, binding, session };
    this.updateLive();
    g.engine.sync();
  }

  close() {
    if (!this.open) return;
    this.open.binding.flush();
    this.open.session.close();
    this.open = null;
    this.updateLive();
  }

  /** `count` of the open board's items of `kind`, from item `n` on, in id order. */
  items(kind, n, count = 1) {
    const ids = this.open.model.board[kind].map((x) => x.id).sort();
    if (!ids.length) return [];
    return Array.from({ length: Math.min(count, ids.length) }, (_, i) => ids[(n + i) % ids.length]);
  }

  op(o) {
    const g = this.group;
    const m = this.open?.model;
    switch (o.op) {
      case "newSpace": {
        const ng = this.spaces.newSpace(o.server, o.name);
        ng.engine.sync();
        return { invite: ng.store.invite };
      }
      case "join": {
        const jg = this.spaces.join(o.invite);
        jg.engine.sync();
        return null;
      }
      case "createBoard":
        return { board: g.store.createBoard(o.title) };
      case "open":
        this.openBoard(o.board);
        return { opened: this.open !== null };
      case "show":
        this.visible = o.visible;
        this.updateLive();
        if (o.visible) this.spaces.retryAll();
        return null;
      case "retry":
        return this.spaces.retryAll(o.changed);
      case "resync":
        g?.engine.reset();
        g?.engine.sync();
        return null;
    }
    if (!m) return null;
    switch (o.op) {
      case "cursor":
        return g?.live?.sendCursor(this.open.id, o.x, o.y);
      case "addCard":
        return m.perform("New Card", (b) => R.addCard(b, o.x, o.y));
      case "addLane":
        return m.perform("New Lane", (b) => R.addLane(b, o.x, o.y));
      case "color":
        return m.perform("Colour", (b) => R.setColor(b, new Set(this.items("cards", o.n, o.count)), o.color));
      case "delete":
        return m.perform("Delete", (b) => {
          R.remove(b, new Set(this.items("cards", o.n, o.count)));
          this.restack(b);
        });
      case "type": {
        const [id] = this.items("cards", o.n);
        if (!id || m.inGesture) return null;
        this.open.session.hold(new Set([id]));
        m.begin();
        m.update((b) => R.setText(b, id, o.text.slice(0, Math.ceil(o.text.length / 2))));
        m.update((b) => R.setText(b, id, o.text));
        m.end("Edit");
        return null;
      }
      case "press": {
        if (m.inGesture) return null;
        const b = m.board;
        let ids;
        if (o.lane) {
          const [lid] = this.items("lanes", o.n);
          if (!lid) return null;
          const carried = R.cardsInLane(b, lid, (c) => heightOf(c.text)).map((c) => c.id);
          ids = [lid, ...carried];
          this.gesture = { lane: lid, carried };
        } else {
          ids = this.items("cards", o.n, o.count);
          if (!ids.length) return null;
          this.gesture = { cards: ids };
        }
        this.open.session.hold(new Set(ids));
        m.begin();
        return null;
      }
      case "drag": {
        if (!m.inGesture || !this.gesture) return null;
        const start = m.start, gs = this.gesture;
        return m.update((b) => {
          const origin = (id) => {
            const x = R.card(start, id) ?? R.lane(start, id);
            return x && { id, x: x.x, y: x.y };
          };
          if (gs.lane) {
            const o0 = origin(gs.lane);
            if (o0) R.moveLane(b, o0, gs.carried.map(origin).filter(Boolean), o.dx, o.dy);
          } else R.moveCards(b, gs.cards.map(origin).filter(Boolean), o.dx, o.dy);
        });
      }
      case "release":
        this.gesture = null;
        return m.end("Move");
      case "cancel":
        this.gesture = null;
        return m.cancel();
      case "undo":
        return m.undo();
      case "redo":
        return m.redo();
    }
    throw new Error(`unknown op ${o.op}`);
  }

  handle(c) {
    switch (c.cmd) {
      case "op":
        return this.op(c.op);
      case "fire":
        return V.fire(this.ctx);
      case "http": {
        const r = this.requests.get(c.req);
        if (!r) return;
        this.requests.delete(c.req);
        r.done();
        // HttpTransport tells offline from unreachable by navigator.onLine, read as it catches
        this.ctx.online = c.error !== "offline";
        if (c.error) return r.reject(new TypeError(`fetch failed: ${c.error}`));
        return r.resolve(new Response(c.body ? decode(c.body) : null, { status: c.status }));
      }
      case "ws-open": {
        const s = this.sockets.get(c.sock);
        if (!s || s.readyState !== 0) return;
        s.readyState = 1;
        return s.onopen?.({});
      }
      case "ws-msg": {
        const s = this.sockets.get(c.sock);
        if (!s || s.readyState !== 1) return;
        return s.onmessage?.({ data: c.text ?? decode(c.bytes).buffer });
      }
      case "ws-close": {
        const s = this.sockets.get(c.sock);
        if (!s || s.readyState === 3) return;
        s.readyState = 3;
        this.sockets.delete(c.sock);
        return s.onclose?.({ code: c.code });
      }
      case "peer-done": {
        const resolve = this.peerCalls.get(c.call);
        this.peerCalls.delete(c.call);
        return resolve?.(c.value);
      }
      case "peer-state":
        if (!this.peer) return;
        if (c.state === "open") this.peer.open.add(c.peer);
        else this.peer.open.delete(c.peer);
        return this.peer.onState(c.peer, c.state);
      case "peer-msg":
        return this.peer?.open.has(c.peer) && this.peer.onMessage(c.peer, c.text ?? decode(c.bytes));
      case "peer-candidate":
        return this.peer?.onCandidate(c.peer, c.candidate);
      case "state":
        return this.snapshot();
    }
    throw new Error(`unknown command ${c.cmd}`);
  }

  snapshot() {
    const g = this.group;
    if (!g) return { boards: {}, pending: 0, overlays: {}, mine: 0, connected: false, seen: [], status: "local" };
    const boards = {}, overlays = {};
    for (const { id, title } of g.store.boards()) {
      const b = g.store.board(id);
      boards[id] = {
        title,
        cards: b.cards.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, text: c.text ?? "", notes: c.notes ?? "", color: c.color })),
        lanes: b.lanes.map((l) => ({ id: l.id, x: l.x, y: l.y, w: l.w, h: l.h, title: l.title ?? "" })),
      };
      overlays[id] = g.live?.overlay(id).size ?? 0;
    }
    const seen = [...new Set([...(g.live?.peers.values() ?? [])].map((p) => p.person?.device).filter(Boolean))].sort();
    return { boards, pending: g.store.pending().length, overlays, mine: g.live?.mine.size ?? 0, connected: !!g.live?.connected, seen, status: g.engine.status.state };
  }
}

/** The run's web devices: `fetch` and warnings under a device's context go to it. */
let active = null;
let hooked = false;

function hook() {
  if (hooked) return;
  hooked = true;
  V.install();
  // devices' warnings, such as a captive portal's page failing to parse, go to the hub's log
  const warn = console.warn;
  console.warn = (...a) => (V.current() && active ? active.log(`device ${V.current().name}:`, ...a) : warn(...a));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const ctx = V.current();
    const d = ctx && active?.devices.get(ctx.name);
    return d ? d.fetch(url, init) : realFetch(url, init);
  };
}

/** The web devices, behind the interface breezy-sim has; one run's at a time. */
export class WebDevices {
  constructor() {
    hook();
    active = this;
    this.devices = new Map();
    this.log = () => {};
  }

  /** A command; answers once every web device is idle. */
  async command(c) {
    if (c.cmd === "time") {
      V.setTime(c.t);
      for (const [i, d] of this.devices) d.ctx.skew = c.skew?.[i] ?? 0;
      return { out: [], next: this.next() };
    }
    if (c.cmd === "new") {
      this.devices.set(c.dev, new WebDevice(c.dev, c.me, c.seed));
      await V.settle();
      return { out: this.drain(), next: this.next() };
    }
    const d = this.devices.get(c.dev);
    let reply;
    V.run(d.ctx, () => (reply = d.handle(c)));
    await V.settle();
    return { out: this.drain(), next: this.next(), reply: reply ?? null };
  }

  drain() {
    const out = [];
    for (const d of this.devices.values()) out.push(...d.out.splice(0));
    return out;
  }

  next() {
    return Object.fromEntries([...this.devices].map(([i, d]) => [i, V.next(d.ctx)]));
  }
}
