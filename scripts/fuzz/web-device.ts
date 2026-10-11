// Web devices in the hub's process, answering the same commands as breezy-sim: each is the web app's Spaces, model,
// binding and Collab with its I/O carried by the hub, on virtual time.
import * as V from "./virtual.ts";
import { Spaces } from "../../web/sync/spaces.ts";
import { GestureHolds } from "../../web/sync/gesture-holds.ts";
import { Collab } from "../../web/sync/collab.ts";
import { App } from "../../web/app.ts";
import { Mouse } from "../../web/mouse.ts";
import { Gestures, HOLD_MS } from "../../web/gestures.ts";
import { command, perform } from "../../web/keys.ts";
import { FakeView, fakeHeight, fakePorts } from "../../web/test/fakes.ts";
import type { Person } from "../../web/presence.ts";
import type { Model } from "../../web/model.ts";
import { Binding } from "../../web/binding.ts";
import * as R from "../../web/rules.ts";
import type { Board } from "../../web/types.ts";
import { encode, decode } from "../../web/sync/base64.ts";
import type { Ice, LinkState, PeerTransport } from "../../web/sync/direct.ts";
import type { Command, DeviceCommand, Event, Me, Op, Pointer, Reply, Snapshot, Target } from "./hub.ts";

type Group = Spaces["spaces"][number];
type Session = ReturnType<Collab["open"]>;
type Payload<E> = E extends unknown ? Omit<E, "dev"> : never;

/** Card heights as both device kinds measure them here: restacking stays local, so they need only be stable. */
export const heightOf = (text: string | null | undefined) => fakeHeight(text ?? undefined);

const bytesOf = (data: Uint8Array | ArrayBuffer) => (data instanceof Uint8Array ? data : new Uint8Array(data));

class Socket {
  declare device: WebDevice;
  declare sock: number;
  declare url: string;
  declare readyState: 0 | 1 | 2 | 3;
  declare binaryType: BinaryType;
  declare onopen: ((e: object) => void) | null;
  declare onmessage: ((e: { data: string | ArrayBuffer }) => void) | null;
  declare onclose: ((e: { code: number }) => void) | null;

  constructor(device: WebDevice, sock: number, url: string) {
    Object.assign(this, { device, sock, url, readyState: 0, binaryType: "blob", onopen: null, onmessage: null, onclose: null });
  }

  send(data: Parameters<WebSocket["send"]>[0]) {
    if (this.readyState !== 1) return;
    this.device.emit(typeof data === "string" ? { ev: "ws-send", sock: this.sock, text: data } : { ev: "ws-send", sock: this.sock, bytes: encode(bytesOf(data as Uint8Array | ArrayBuffer)) });
  }

  close() {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.device.emit({ ev: "ws-close", sock: this.sock });
  }
}

/** Direct's transport, with the channels the hub simulates. */
class Peer implements PeerTransport {
  device: WebDevice;
  open: Set<string>;
  calls: Map<number, unknown>;
  onCandidate: PeerTransport["onCandidate"];
  onState: PeerTransport["onState"];
  onMessage: PeerTransport["onMessage"];

  constructor(device: WebDevice) {
    this.device = device;
    this.open = new Set();
    this.calls = new Map();
    this.onCandidate = () => {};
    this.onState = () => {};
    this.onMessage = () => {};
  }

  call<T>(ev: "peer-offer" | "peer-answer" | "peer-accept", peer: string, extra: { restart?: boolean; sdp?: string }) {
    const call = ++this.device.calls;
    this.device.emit({ ev, peer, call, ...extra });
    return new Promise<T>((resolve) => this.device.peerCalls.set(call, resolve as (v: unknown) => void));
  }

  create(peer: string) {
    this.open.delete(peer);
    this.device.emit({ ev: "peer-create", peer });
  }

  offer(peer: string, restart: boolean) {
    return this.call<string>("peer-offer", peer, { restart: !!restart });
  }

  answer(peer: string, sdp: string) {
    return this.call<string>("peer-answer", peer, { sdp });
  }

  async accept(peer: string, sdp: string) {
    await this.call("peer-accept", peer, { sdp });
  }

  add(peer: string, candidate: Ice) {
    this.device.emit({ ev: "peer-add", peer, candidate });
  }

  send(peer: string, text: string) {
    if (!this.open.has(peer)) return false;
    this.device.emit({ ev: "peer-send", peer, text });
    return true;
  }

  sendBytes(peer: string, bytes: Uint8Array<ArrayBuffer>) {
    if (!this.open.has(peer)) return false;
    this.device.emit({ ev: "peer-send", peer, bytes: encode(bytesOf(bytes)) });
    return true;
  }

  close(peer: string) {
    this.open.delete(peer);
    this.device.emit({ ev: "peer-close", peer });
  }
}

class WebDevice {
  index: number;
  ctx: V.Context;
  out: Event[];
  requests: Map<number, { resolve: (r: Response) => void; reject: (e: unknown) => void; done: () => void }>;
  sockets: Map<number, Socket>;
  peerCalls: Map<number, (v: unknown) => void>;
  calls: number;
  nextReq: number;
  nextSock: number;
  visible: boolean;
  peer: Peer | null;
  open: { id: string; app: App; model: Model; binding: Binding; session: Session; mouse: Mouse; gestures: Gestures } | null;
  holds: GestureHolds;
  declare spaces: Spaces;
  declare collabOf: Group | undefined;
  declare _collab: Collab;
  /** Where the fuzzer's press went down. */
  pressedAt: { x: number; y: number } | null = null;
  /** The time a mouse event carries, which tells a double-click from two clicks. */
  clicks = 0;

  constructor(index: number, me: Me, seed: number) {
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
        socket: (url: string) => {
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

  emit(e: Payload<Event>) {
    this.out.push({ ...e, dev: this.index });
  }

  get group() {
    return this.spaces.spaces[0] ?? null;
  }

  /** What the hub's `fetch` does for this device: the request goes out, its answer comes with an `http` command. */
  fetch(url: string | URL | Request, init: RequestInit = {}) {
    this.ctx.online = true;
    const req = ++this.nextReq;
    const body = init.body == null ? null : encode(typeof init.body === "string" ? new TextEncoder().encode(init.body) : bytesOf(init.body as Uint8Array | ArrayBuffer));
    this.emit({ ev: "http", req, method: init.method ?? "GET", url: String(url), headers: (init.headers ?? {}) as Record<string, string>, body });
    return new Promise<Response>((resolve, reject) => {
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

  taken() {
    return this.group?.live?.taken() ?? new Set();
  }

  restack(b: Board) {
    R.gravity(b, (id) => heightOf(R.card(b, id)?.text));
  }

  openBoard(id: string | null | undefined) {
    this.close();
    const g = this.group;
    if (!g || id == null || g.store.title(id) === null) return;
    const b = g.store.board(id);
    this.restack(b);
    // the app's core, drawn by fakes: input goes through it as in a browser
    const app = new App(b, fakePorts);
    const model = app.model;
    const binding = new Binding(g.store, model, id, (x) => this.restack(x));
    binding.taken = () => g.live?.taken() ?? new Set();
    const session = this.collab!.open(id, model, binding);
    app.space = { hold: (ids) => session.hold(new Set(ids)), edited: () => session.edited() };
    const drawn = model.onChange;
    model.onChange = () => {
      drawn();
      binding.changed();
      session.edited();
    };
    this.open = { id, app, model, binding, session, mouse: new Mouse(app), gestures: new Gestures(app.input) };
    this.updateLive();
    g.engine.sync();
  }

  close() {
    if (!this.open) return;
    this.open.binding.flush();
    this.open.session.close();
    this.open = null;
    this.pressedAt = null;
    this.updateLive();
  }

  /** `count` of the open board's items of `kind`, from item `n` on, in id order. */
  items(kind: "cards" | "lanes", n: number, count = 1) {
    const ids = this.open!.model.board[kind].map((x) => x.id).sort();
    if (!ids.length) return [];
    return Array.from({ length: Math.min(count, ids.length) }, (_, i) => ids[(n + i) % ids.length]);
  }

  op(o: Op) {
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
        return g?.live?.sendCursor(this.open!.id, o.x, o.y);
      case "addCard":
      case "addLane": {
        let id = "";
        m.perform(o.op === "addCard" ? "New Card" : "New Lane", (b) => (id = (o.op === "addCard" ? R.addCard : R.addLane)(b, o.x, o.y)));
        return { id };
      }
      case "color":
        return m.perform("Colour", (b) => R.setColor(b, new Set(this.items("cards", o.n, o.count)), o.color));
      case "delete":
        return m.perform("Delete", (b) => {
          R.remove(b, new Set(this.items("cards", o.n, o.count)));
          this.restack(b);
        });
      case "type": {
        // as a person edits through the app: the side wanted turned up, its text typed over, then finished
        const [id] = this.items("cards", o.n);
        if (!id || m.inGesture) return null;
        const a = this.open!.app;
        this.noteTaken();
        a.turn(o.back ? id : null);
        a.beginEdit(id);
        return this.typeAndFinish(o.text);
      }
      case "newCard": {
        // as a double-click makes one: its top left where the pointer is, typed into, then finished
        if (m.inGesture) return null;
        this.noteTaken();
        this.open!.app.newCard({ x: o.x, y: o.y }, "corner");
        return this.typeAndFinish(o.text);
      }
      case "laneTitle": {
        // as a person renames one through the app: its title typed over, then Return
        const [lid] = this.items("lanes", o.n);
        if (!lid || m.inGesture) return null;
        const a = this.open!.app;
        this.noteTaken();
        a.beginRename(lid);
        const f = (a.view as FakeView).focused;
        if (a.state.renaming !== lid || !f) return null;
        f.key("a", true);
        f.type(o.text);
        f.key("Enter", false);
        return null;
      }
      case "resize": {
        const [lid] = this.items("lanes", o.n);
        if (!lid || m.inGesture || this.taken().has(lid)) return null;
        const l = R.lane(m.board, lid)!;
        m.begin();
        this.open!.session.hold(new Set([lid]));
        m.update((b) => R.resizeLane(b, lid, l.w + o.dw, l.h + o.dh));
        m.end("Resize Lane");
        return null;
      }
      case "click": {
        const p = this.spot(o.target, o.n);
        if (!p || m.inGesture) return null;
        this.pointer({ phase: "down", ...p, shift: o.shift });
        return this.pointer({ phase: "up", ...p });
      }
      case "press": {
        // as a mouse does it: the press goes where the item is drawn, and the app decides what it hits
        if (m.inGesture) return null;
        const o0 = this.open!;
        const b = m.board;
        let p: { x: number; y: number };
        if (o.empty) {
          const s = this.spot("empty", o.n);
          if (!s) return null;
          p = s;
        } else if (o.lane) {
          const [lid] = this.items("lanes", o.n);
          const l = lid && R.lane(b, lid);
          if (!l) return null;
          p = { x: l.x + R.GRID, y: l.y + R.GRID };
        } else {
          const ids = this.items("cards", o.n, o.count);
          const c = ids[0] && R.card(b, ids[0]);
          if (!c) return null;
          o0.app.select(ids);
          const r = o0.app.view.rectOf(c);
          p = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
        }
        this.pressedAt = p;
        return this.pointer({ phase: "down", ...p });
      }
      case "drag": {
        const p = this.pressedAt;
        return p ? this.pointer({ phase: "move", x: p.x + o.dx, y: p.y + o.dy }) : null;
      }
      case "release":
      case "cancel": {
        const p = this.pressedAt;
        this.pressedAt = null;
        return this.pointer({ phase: o.op === "release" ? "up" : "cancel", x: p?.x ?? 0, y: p?.y ?? 0 });
      }
      case "pointer":
        return this.pointer(o);
      case "text": {
        const f = (this.open!.app.view as FakeView).focused;
        if (!f) throw new Error("nothing has the keyboard");
        return f.type(o.text);
      }
      case "key": {
        // as main.ts hands a key to the app, on a Mac
        const a = this.open!.app, s = a.state;
        // the field with the keyboard takes its keys first, as the focused element does in a browser
        if ((a.view as FakeView).focused?.key(o.key, !!o.meta)) return null;
        const typing = s.editing ? "card" : s.renaming ? "lane" : null;
        const e = { key: o.key, code: o.key === "0" ? "Digit0" : "", metaKey: !!o.meta, shiftKey: !!o.shift, ctrlKey: false, altKey: false };
        const cmd = command(e, { mac: true, typing });
        return cmd && perform(a, cmd, this.open!.mouse);
      }
      case "undo":
        return m.undo();
      case "redo":
        return m.redo();
    }
    throw new Error(`unknown op ${o.op}`);
  }

  /** A screen point for `target`, as breezy-sim's `spot` finds one; null when there is none. */
  spot(target: Target, n: number): { x: number; y: number } | null {
    const a = this.open!.app, b = a.model.board, v = a.view;
    if (target === "card") {
      const [id] = this.items("cards", n);
      const c = id && R.card(b, id);
      if (!c) return null;
      const r = v.rectOf(c);
      return v.toScreen({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    }
    if (target === "header" || target === "corner") {
      const [id] = this.items("lanes", n);
      const l = id && R.lane(b, id);
      if (!l) return null;
      return v.toScreen(target === "header" ? { x: l.x + l.w / 2, y: l.y + 12 } : { x: l.x + l.w - 6, y: l.y + l.h - 6 });
    }
    // a grid of points from the `n`th on, the first that hits nothing
    for (let i = 0; i < 400; i++) {
      const k = (n + i) % 400;
      const w = { x: (k % 20) * 60 + 30, y: Math.floor(k / 20) * 40 + 20 };
      if (a.input.hit(v.toScreen(w), false).kind === "empty") return v.toScreen(w);
    }
    return null;
  }

  /** What others hold, as library.ts gives it to the app. */
  noteTaken() {
    const live = this.group?.live;
    this.open!.app.state.taken = new Map<string, Person>([...(live?.taken() ?? [])].map((id) => [id, live!.holderOf(id)!]));
  }

  /** Types `text` key by key over what the field with the keyboard holds, then ends the edit; nothing when no edit began. */
  typeAndFinish(text: string) {
    const a = this.open!.app;
    const f = (a.view as FakeView).focused;
    if (!a.state.editing || !f) return null;
    f.value = "";
    f.type(text);
    a.endEditing();
    return null;
  }

  /** A mouse or finger event at screen point (x, y), as main.ts hands it to the app. */
  pointer(e: Omit<Pointer, "op">) {
    const o = this.open;
    if (!o) return null;
    this.noteTaken();
    const p = { x: e.x, y: e.y };
    const t = performance.now();
    if (e.kind === "touch") {
      const id = e.finger ?? 0;
      if (e.phase === "down") {
        o.app.touching = true;
        o.app.input.touchStart();
        o.gestures.down(id, p.x, p.y, t);
        setTimeout(() => this.open?.gestures.tick(performance.now()), HOLD_MS + 10);
        return null;
      }
      if (e.phase === "move") return o.gestures.move(id, p.x, p.y, t);
      if (e.phase === "up") return o.gestures.up(id, p.x, p.y, t);
      return o.gestures.cancel(id);
    }
    o.app.touching = false;
    if (e.phase === "down") {
      // a second click comes at once, a first long after the last
      this.clicks += e.clicks === 2 ? 1 : 10_000;
      return o.mouse.down({ ...p, shiftKey: !!e.shift, altKey: !!e.option }, this.clicks);
    }
    if (e.phase === "move") return o.mouse.move(p);
    if (e.phase === "up") return o.mouse.up(p);
    return o.mouse.cancel();
  }

  scene() {
    return this.open ? (this.open.app.view as FakeView).scene() : null;
  }

  handle(c: DeviceCommand) {
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
        return s.onmessage?.({ data: c.text ?? decode(c.bytes)!.buffer });
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
        return this.peer?.open.has(c.peer) && this.peer.onMessage(c.peer, c.text ?? decode(c.bytes)!);
      case "peer-candidate":
        return this.peer?.onCandidate(c.peer, c.candidate);
      case "state":
        return this.snapshot();
      case "scene":
        return this.scene();
    }
    throw new Error(`unknown command ${c.cmd}`);
  }

  snapshot(): Snapshot {
    const g = this.group;
    if (!g) return { boards: {}, pending: 0, overlays: {}, mine: 0, connected: false, seen: [], status: "local" };
    const boards: Snapshot["boards"] = {}, overlays: Snapshot["overlays"] = {};
    for (const { id, title } of g.store.boards()) {
      const b = g.store.board(id);
      boards[id] = {
        title,
        cards: b.cards.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, text: c.text ?? "", notes: c.notes ?? "", color: c.color })),
        lanes: b.lanes.map((l) => ({ id: l.id, x: l.x, y: l.y, w: l.w, h: l.h, title: l.title ?? "" })),
      };
      overlays[id] = g.live?.overlay(id).size ?? 0;
    }
    const seen = [...new Set([...(g.live?.peers.values() ?? [])].map((p) => p.person?.device).filter(Boolean) as string[])].sort();
    // what the open board shows: its store's
    let shown: Snapshot["shown"] = null;
    if (this.open && !this.open.model.inGesture) {
      // but for where stacking puts cards and how tall lanes grow, which stay local, and lanes' order, which a pull sets
      const content = (b: Board) => JSON.stringify([...b.cards.map((c) => [c.id, c.x, c.w, c.color, c.text, c.notes ?? ""]), ...[...b.lanes].sort((x, y) => (x.id < y.id ? -1 : 1)).map((l) => [l.id, l.x, l.y, l.w, l.title])]);
      shown = { board: this.open.id, same: content(g.store.board(this.open.id)) === content(this.open.model.board) };
    }
    return { boards, pending: g.store.pending().length, overlays, mine: g.live?.mine.size ?? 0, connected: !!g.live?.connected, seen, status: g.engine.status.state, shown };
  }
}

/** The run's web devices: `fetch` and warnings under a device's context go to it. */
let active: WebDevices | null = null;
let hooked = false;

function hook() {
  if (hooked) return;
  hooked = true;
  V.install();
  // devices' warnings, such as a captive portal's page failing to parse, go to the hub's log
  const warn = console.warn;
  console.warn = (...a) => (V.current() && active ? active.log(`device ${V.current()!.name}:`, ...a) : warn(...a));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url: string | URL | Request, init?: RequestInit) => {
    const ctx = V.current();
    const d = ctx && active?.devices.get(ctx.name);
    return d ? d.fetch(url, init) : realFetch(url, init);
  };
}

/** The web devices, behind the interface breezy-sim has; one run's at a time. */
export class WebDevices {
  devices: Map<V.Context["name"], WebDevice>;
  log: (...a: unknown[]) => void;

  constructor() {
    hook();
    active = this;
    this.devices = new Map();
    this.log = () => {};
  }

  /** A command; answers once every web device is idle. */
  async command(c: Command): Promise<Reply> {
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
    const d = this.devices.get(c.dev)!;
    let reply: unknown;
    V.run(d.ctx, () => (reply = d.handle(c)));
    await V.settle();
    return { out: this.drain(), next: this.next(), reply: reply ?? null };
  }

  drain() {
    const out: Event[] = [];
    for (const d of this.devices.values()) out.push(...d.out.splice(0));
    return out;
  }

  next() {
    return Object.fromEntries([...this.devices].map(([i, d]) => [i, V.next(d.ctx)]));
  }
}
