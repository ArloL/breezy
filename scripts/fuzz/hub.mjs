// The fuzzer's discrete-event simulation: devices of both kinds, the real sync.php, the relay's Durable Object and
// direct channels, joined by simulated networks on virtual time. See the convergence fuzzing design.
import { createHash } from "node:crypto";
import * as V from "./virtual.mjs";
import { Rng } from "./rng.mjs";
import { Relay } from "./relay.mjs";
import { Server } from "./server.mjs";
import { Link } from "./links.mjs";
import { WebDevices } from "./web-device.mjs";
import { SwiftDevices } from "./swift-devices.mjs";

const RELAY = "ws://127.0.0.1:9/";
/** How long after the last operation the hub lets everything settle before it checks. */
const HEAL_MS = Number(process.env.HEAL_MS ?? 90_000);
const OP_MEAN_MS = 700;
const FAULT_MEAN_MS = 6_000;

const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const unb64 = (s) => (s == null ? null : Buffer.from(s, "base64url"));

/** Operation weights; a gesture is press, drags, then release or cancel. */
const OPS = { addCard: 10, type: 10, color: 6, delete: 3, addLane: 2, drag: 12, dragLane: 3, undo: 4, redo: 2, hide: 3, retry: 1, resync: 0.5, bulk: 0.4, board: 0.5, cursor: 6 };
const FAULTS = {
  lostResponse: 3, serverError: 2, portal: 2, truncated: 1, failFast: 1, relayDrop: 2, relayRestart: 1, relayEvict: 1,
  directClose: 2, directSilent: 2, skew: 1, freeze: 2, outage: 2, restore: 0.3,
};

export class Hub {
  constructor(opts) {
    this.opts = { steps: 300, web: 2, swift: 2, profile: "mixed", restore: true, faults: true, plant: null, log: () => {}, ...opts };
    this.rng = new Rng(this.opts.seed);
    this.rngOps = new Rng(this.rng.fork());
    this.rngNet = new Rng(this.rng.fork());
    this.rngFault = new Rng(this.rng.fork());
    this.queue = [];
    this.seq = 0;
    this.trace = [];
    this.conns = new Map();
    this.peers = new Map();
    this.devices = [];
    this.stats = { requests: 0, frames: 0, channelMessages: 0, faults: {}, ops: {} };
  }

  log(...a) {
    this.opts.log(`[${(V.now / 1000).toFixed(3)}]`, ...a);
  }

  note(kind, detail) {
    // the server's port changes from run to run
    const entry = JSON.parse(JSON.stringify({ t: Math.round(V.now), kind, ...detail }).replaceAll(this.server?.url ?? "\0", "SERVER"));
    this.trace.push(entry);
  }

  at(t, what, fn) {
    this.queue.push({ t: Math.max(t, V.now), seq: ++this.seq, what, fn });
  }

  async start() {
    if (this.opts.plant) process.env.BREEZY_PLANT = this.opts.plant;
    globalThis.__breezyPlant = this.opts.plant;
    V.reset();
    this.server = await Server.start(RELAY);
    this.relayCtx = new V.Context("relay", this.rng.fork());
    this.relay = new Relay(this.relayCtx, {
      toClient: (conn, data) => this.down(conn, typeof data === "string" ? { text: data } : { bytes: b64(new Uint8Array(data)) }),
      closeClient: (conn, code) => this.down(conn, { close: code }),
    });
    this.web = new WebDevices();
    this.web.log = (...a) => this.log(...a);
    this.swift = this.opts.swift > 0 ? await SwiftDevices.start() : null;
    // the kinds interleave, so that the first two differ when both run
    const order = [];
    for (let i = 0; order.length < this.opts.web + this.opts.swift; i++) {
      if (i < this.opts.web) order.push("web");
      if (i < this.opts.swift) order.push("swift");
    }
    for (const [i, kind] of order.entries()) {
      const d = {
        i, kind, backend: kind === "web" ? this.web : this.swift, next: null, frozen: false, inbox: [], skew: 0,
        me: { device: b64(this.rng.bytes(16)), name: `d${i}` }, board: null, opened: false, gesture: null, hidden: false,
        link: new Link(new Rng(this.rng.fork()), this.opts.profile), joined: false,
      };
      this.devices.push(d);
      await this.command(d, { cmd: "new", me: d.me, seed: Number(this.rng.next64() & 0xffffffffn) });
    }
  }

  stop() {
    this.server?.stop();
    this.swift?.stop();
  }

  // MARK: devices

  /** Sends a command to `d`'s backend and takes what it emitted. */
  async command(d, c) {
    const r = await d.backend.command({ ...c, dev: d.i });
    if (r.error) throw new Error(`device ${d.i} (${d.kind}): ${r.error}`);
    for (const [i, t] of Object.entries(r.next ?? {})) {
      const x = this.devices[Number(i)];
      if (x && x.backend === d.backend) x.next = t;
    }
    for (const e of r.out ?? []) this.emitted(e);
    return r.reply ?? null;
  }

  /** Something for device `d` arrives: now, or when it thaws. */
  async deliver(d, c) {
    if (d.frozen) return d.inbox.push(c);
    await this.command(d, c);
  }

  async op(d, o) {
    this.stats.ops[o.op] = (this.stats.ops[o.op] ?? 0) + 1;
    this.note("op", { dev: d.i, op: o });
    return this.command(d, { cmd: "op", op: o });
  }

  // MARK: network

  /** When a message `d` sends to `dest` now on `conn` arrives, or null when it is lost. */
  transit(d, dest, conn) {
    if (conn?.dead) return null;
    const link = d.link;
    let ms = link.latency(dest, dest !== "peer");
    if (ms === null && link.state === "tunnel" && link.keeps && dest !== "peer" && !link.blocked[dest]) {
      ms = link.until - V.now + this.rngNet.between(0, 1000);
    }
    if (ms === null) return null;
    let t = V.now + ms;
    // a connection keeps its order each way
    if (conn) {
      const key = dest === "client" ? "lastDown" : "lastUp";
      t = Math.max(t, (conn[key] ?? 0) + 0.01);
      conn[key] = t;
    }
    return t;
  }

  emitted(e) {
    const d = this.devices[e.dev];
    switch (e.ev) {
      case "http":
        return this.http(d, e);
      case "http-cancel": {
        const c = this.conns.get(`http ${d.i} ${e.req}`);
        if (c) c.cancelled = true;
        return;
      }
      case "ws-connect":
        return this.wsConnect(d, e);
      case "ws-send":
      case "ws-close":
        return this.wsUp(d, e);
      default:
        if (e.ev.startsWith("peer-")) return this.peer(d, e);
        throw new Error(`unknown event ${e.ev}`);
    }
  }

  http(d, e) {
    this.stats.requests++;
    const conn = { kind: "http", dev: d.i, req: e.req, dead: false };
    this.conns.set(`http ${d.i} ${e.req}`, conn);
    const answer = (t, a) => this.at(t, "http answer", async () => {
      this.conns.delete(`http ${d.i} ${e.req}`);
      if (conn.dead || conn.cancelled) return;
      await this.deliver(d, { cmd: "http", req: e.req, ...a });
    });
    if (d.link.toldOffline) return answer(V.now + 1, { error: "offline" });
    const t = this.transit(d, "server", conn);
    if (t === null) return;
    this.at(t, "http request", async () => {
      if (conn.dead) return;
      const fault = this.httpFault;
      this.httpFault = null;
      if (fault) {
        this.note("fault", { fault, dev: d.i });
        if (fault === "serverError") return answer(this.transit(d, "client", conn) ?? Infinity, { status: 503, body: null });
        if (fault === "portal") return answer(this.transit(d, "client", conn) ?? Infinity, { status: 200, body: b64(Buffer.from("<html><body>Log in to continue</body></html>")) });
        if (fault === "failFast") return answer(V.now + 1, { error: "unreachable" });
      }
      const res = await this.server.send({ method: e.method, url: e.url, headers: e.headers, body: unb64(e.body) });
      if (fault === "lostResponse") return;
      let body = res.body;
      if (fault === "truncated") body = body.subarray(0, Math.floor(body.length / 2));
      const back = this.transit(d, "client", conn);
      if (back !== null) answer(back, { status: res.status, body: b64(body) });
    });
  }

  wsConnect(d, e) {
    const conn = { kind: "ws", dev: d.i, sock: e.sock, dead: false, open: false };
    this.conns.set(`ws ${d.i} ${e.sock}`, conn);
    if (d.link.toldOffline) return this.at(V.now + 1, "ws refused", () => this.deliver(d, { cmd: "ws-close", sock: e.sock, code: 1006 }));
    const t = this.transit(d, "relay", conn);
    if (t === null) return;
    this.at(t, "ws accept", async () => {
      if (conn.dead) return;
      conn.open = true;
      await this.relay.open(conn);
      const back = this.transit(d, "client", conn);
      if (back !== null) this.at(back, "ws open", () => this.deliver(d, { cmd: "ws-open", sock: e.sock }));
    });
  }

  /** A frame or a close from a device's socket to the relay. */
  wsUp(d, e) {
    const conn = this.conns.get(`ws ${d.i} ${e.sock}`);
    if (!conn) return;
    if (e.ev === "ws-close") conn.closing = true;
    const t = this.transit(d, "relay", conn);
    if (t === null) return;
    this.stats.frames++;
    this.at(t, e.ev, async () => {
      if (conn.dead || !conn.open) return;
      if (e.ev === "ws-close") {
        await this.relay.closed(conn);
        this.conns.delete(`ws ${d.i} ${e.sock}`);
        const back = this.transit(d, "client", conn);
        if (back !== null) this.at(back, "ws closed", () => this.deliver(d, { cmd: "ws-close", sock: e.sock, code: 1000 }));
        return;
      }
      await this.relay.message(conn, e.text ?? new Uint8Array(unb64(e.bytes)));
    });
  }

  /** The relay sends `conn`'s device a frame or a close. */
  down(conn, m) {
    const d = this.devices[conn.dev];
    const t = this.transit(d, "client", conn);
    if (t === null) return;
    this.at(t, "ws down", async () => {
      if (conn.dead) return;
      if (m.close !== undefined) {
        // the device answers the close, after which the relay lets the socket go
        await this.deliver(d, { cmd: "ws-close", sock: conn.sock, code: m.close });
        const up = this.transit(d, "relay", conn);
        if (up !== null) this.at(up, "ws close ack", () => this.relay.closed(conn));
        this.conns.delete(`ws ${d.i} ${conn.sock}`);
        return;
      }
      await this.deliver(d, { cmd: "ws-msg", sock: conn.sock, ...m });
    });
  }

  /** `d` lost its connections without a word, as on a network change: a dead socket stays at the relay until TCP
   * gives up on it. */
  kill(d) {
    for (const [k, c] of this.conns) {
      if (c.dev !== d.i || c.dead) continue;
      c.dead = true;
      this.conns.delete(k);
      if (c.kind === "ws" && c.open) this.at(V.now + this.rngNet.between(30_000, 120_000), "tcp gives up", () => this.relay.closed(c));
    }
    for (const ep of this.peers.values()) if (ep.dev === d.i && ep.open) this.silence(ep);
  }

  // MARK: direct channels

  endpoint(d, peer) {
    const k = `${d.i} ${peer}`;
    if (!this.peers.has(k)) this.peers.set(k, { dev: d.i, peer, other: null, open: false, silent: false, gen: 0 });
    return this.peers.get(k);
  }

  peer(d, e) {
    const ep = this.endpoint(d, e.peer);
    const soon = () => V.now + this.rngNet.between(1, 20);
    const done = (value) => this.at(soon(), "peer done", () => this.deliver(d, { cmd: "peer-done", call: e.call, value }));
    const candidates = () =>
      this.at(soon(), "candidates", async () => {
        await this.deliver(d, { cmd: "peer-candidate", peer: e.peer, candidate: { candidate: `candidate:sim ${d.i}`, mid: "0", index: 0 } });
        await this.deliver(d, { cmd: "peer-candidate", peer: e.peer, candidate: null });
      });
    switch (e.ev) {
      case "peer-create":
        this.closeChannel(ep, false);
        ep.gen++;
        return;
      case "peer-offer":
        candidates();
        return done(`sim ${d.i} ${e.peer} ${ep.gen}`);
      case "peer-answer": {
        const [, dev, peer] = String(e.sdp).split(" ");
        ep.other = `${dev} ${peer}`;
        candidates();
        return done(`sim ${d.i} ${e.peer} ${ep.gen}`);
      }
      case "peer-accept": {
        const [, dev, peer] = String(e.sdp).split(" ");
        ep.other = `${dev} ${peer}`;
        done(true);
        return this.tryOpen(ep);
      }
      case "peer-add":
        return;
      case "peer-send":
        return this.channelSend(ep, e);
      case "peer-close":
        return this.closeChannel(ep, true);
    }
  }

  tryOpen(a) {
    const b = this.peers.get(a.other);
    if (!b || b.other !== `${a.dev} ${a.peer}`) return;
    const da = this.devices[a.dev], db = this.devices[b.dev];
    if (this.directFails || !da.link.up || !db.link.up) return;
    const t = V.now + this.rngNet.between(50, 500);
    const gens = [a.gen, b.gen];
    this.at(t, "channel open", async () => {
      if (a.gen !== gens[0] || b.gen !== gens[1]) return;
      a.open = b.open = true;
      a.silent = b.silent = false;
      await this.deliver(da, { cmd: "peer-state", peer: a.peer, state: "open" });
      await this.deliver(db, { cmd: "peer-state", peer: b.peer, state: "open" });
    });
  }

  channelSend(a, e) {
    const b = this.peers.get(a.other);
    if (!a.open || !b?.open || a.silent) return;
    const da = this.devices[a.dev], db = this.devices[b.dev];
    const up = da.link.latency("peer", false), down = db.link.latency("peer", false);
    if (up === null || down === null) return;
    this.stats.channelMessages++;
    const gen = b.gen;
    this.at(V.now + up + down, "channel message", () => b.gen === gen && b.open && this.deliver(db, { cmd: "peer-msg", peer: b.peer, text: e.text, bytes: e.bytes }));
  }

  /** `ep`'s channel closes; the other end hears of it unless `local` only. */
  closeChannel(ep, tell) {
    const other = ep.other && this.peers.get(ep.other);
    ep.open = false;
    if (tell && other?.open) {
      other.open = false;
      const d = this.devices[other.dev];
      const gen = other.gen;
      this.at(V.now + this.rngNet.between(5, 100), "channel closed", () => other.gen === gen && this.deliver(d, { cmd: "peer-state", peer: other.peer, state: "closed" }));
    }
  }

  /** The channel stops carrying anything; ICE notices a few seconds on and both ends close. */
  silence(ep) {
    const other = ep.other && this.peers.get(ep.other);
    if (!ep.open || !other) return;
    ep.silent = other.silent = true;
    const gens = [ep.gen, other.gen];
    this.at(V.now + this.rngNet.between(5_000, 30_000), "ice gives up", async () => {
      for (const [x, g] of [[ep, gens[0]], [other, gens[1]]]) {
        if (x.gen !== g || !x.open) continue;
        x.open = false;
        await this.deliver(this.devices[x.dev], { cmd: "peer-state", peer: x.peer, state: "failed" });
      }
    });
  }

  // MARK: the run

  /** Moves to `t`, then runs whatever is due there: queued events, device timers and the relay's. */
  async advance(t) {
    V.setTime(t);
    const skew = Object.fromEntries(this.devices.map((d) => [d.i, d.skew]));
    await this.web.command({ cmd: "time", t, skew });
    if (this.swift) await this.swift.command({ cmd: "time", t, skew });
    for (;;) {
      this.queue.sort((a, b) => a.t - b.t || a.seq - b.seq);
      if (this.queue.length && this.queue[0].t <= t) {
        const e = this.queue.shift();
        await e.fn();
        continue;
      }
      const d = this.devices.find((x) => !x.frozen && x.next !== null && x.next <= t);
      if (d) {
        await this.command(d, { cmd: "fire" });
        continue;
      }
      const r = V.next(this.relayCtx);
      if (r !== null && r <= t) {
        V.fire(this.relayCtx);
        await V.settle();
        continue;
      }
      return;
    }
  }

  nextTime() {
    let t = Infinity;
    for (const e of this.queue) t = Math.min(t, e.t);
    for (const d of this.devices) if (!d.frozen && d.next !== null) t = Math.min(t, d.next);
    const r = V.next(this.relayCtx);
    if (r !== null) t = Math.min(t, r);
    return t;
  }

  async runUntil(end) {
    for (;;) {
      const t = this.nextTime();
      if (t > end) break;
      await this.advance(Math.max(t, V.now));
    }
    await this.advance(end);
  }

  async run() {
    try {
      await this.start();
      await this.setUp();
      this.scheduleOps();
      if (this.opts.faults) {
        this.scheduleFaults();
        for (const d of this.devices) this.scheduleLink(d);
      }
      while (this.opsLeft > 0 || this.gestures > 0) {
        await this.runUntil(V.now + 1000);
        if (V.now > 3_600_000 * 4) throw new Error("ran over four virtual hours");
      }
      await this.heal();
      return await this.check();
    } finally {
      this.stop();
    }
  }

  async setUp() {
    const [first, ...others] = this.devices;
    const { invite } = await this.op(first, { op: "newSpace", server: this.server.url, name: "Fuzz" });
    const { board } = await this.op(first, { op: "createBoard", title: "Board" });
    this.boards = [board];
    first.joined = true;
    await this.openBoard(first);
    this.invite = invite;
    // the others join at random times, some after edits exist
    for (const d of others) this.at(V.now + this.rngOps.between(0, 20_000), "join", async () => {
      d.joined = true;
      await this.op(d, { op: "join", invite });
    });
  }

  async openBoard(d) {
    const board = this.rngOps.pick(this.boards);
    const r = await this.op(d, { op: "open", board });
    d.opened = !!r?.opened;
    d.board = d.opened ? board : null;
  }

  scheduleOps() {
    this.opsLeft = this.opts.steps;
    this.gestures = 0;
    for (const d of this.devices) this.nextOp(d);
  }

  nextOp(d) {
    if (this.opsLeft <= 0) return;
    this.at(V.now + this.rngOps.between(0, 2 * OP_MEAN_MS), "op", async () => {
      if (this.opsLeft <= 0) return;
      if (!d.frozen && d.joined && !d.gesture) {
        this.opsLeft--;
        await this.randomOp(d);
      }
      this.nextOp(d);
    });
  }

  async randomOp(d) {
    const r = this.rngOps;
    if (!d.opened) return this.openBoard(d);
    const kind = r.weighted(OPS);
    const n = r.int(1000);
    switch (kind) {
      case "addCard":
        return this.op(d, { op: "addCard", x: r.int(40) * 24, y: r.int(30) * 24 });
      case "addLane":
        return this.op(d, { op: "addLane", x: r.int(10) * 480, y: 0 });
      case "type":
        return this.op(d, { op: "type", n, text: `${d.me.name} ${r.int(1e6)}${r.chance(0.2) ? "\nmore" : ""}` });
      case "color":
        return this.op(d, { op: "color", n, count: r.chance(0.8) ? 1 : 1 + r.int(5), color: 1 + r.int(5) });
      case "delete":
        return this.op(d, { op: "delete", n, count: 1 });
      case "undo":
      case "redo":
        return this.op(d, { op: kind });
      case "retry":
        return this.op(d, { op: "retry", changed: r.chance(0.5) });
      case "resync":
        return this.op(d, { op: "resync" });
      case "hide": {
        if (d.hidden) return;
        d.hidden = true;
        await this.op(d, { op: "show", visible: false });
        this.at(V.now + r.between(1000, 20_000), "show", async () => {
          d.hidden = false;
          if (!d.frozen) await this.op(d, { op: "show", visible: true });
        });
        return;
      }
      case "board": {
        if (d.i === 0 && this.boards.length < 3 && r.chance(0.5)) {
          const { board } = await this.op(d, { op: "createBoard", title: `Board ${this.boards.length + 1}` });
          this.boards.push(board);
        }
        return this.openBoard(d);
      }
      case "bulk": {
        // many cards at once, then a bulk move, recolour or delete whose live body passes the relay's 64 KB
        const count = 50 + r.int(250);
        for (let i = 0; i < count; i++) await this.op(d, { op: "addCard", x: (i % 20) * 264, y: Math.floor(i / 20) * 120 });
        const what = r.pick(["drag", "color", "delete", "none"]);
        if (what === "color") return this.op(d, { op: "color", n, count, color: 1 + r.int(5) });
        if (what === "delete") return this.op(d, { op: "delete", n, count });
        if (what === "drag") return this.gesture(d, { op: "press", n, count, lane: false });
        return;
      }
      case "drag":
        return this.gesture(d, { op: "press", n, count: r.chance(0.85) ? 1 : 2 + r.int(4), lane: false });
      case "cursor": {
        let t = V.now, x = r.int(1000), y = r.int(800);
        for (let i = 0; i < 1 + r.int(20); i++) {
          t += r.between(8, 40);
          x += r.int(41) - 20;
          y += r.int(41) - 20;
          const [cx, cy] = [x, y];
          this.at(t, "cursor", () => !d.frozen && this.op(d, { op: "cursor", x: cx, y: cy }));
        }
        if (r.chance(0.2)) this.at(t + 50, "cursor", () => !d.frozen && this.op(d, { op: "cursor", x: null, y: null }));
        return;
      }
      case "dragLane":
        return this.gesture(d, { op: "press", n, count: 1, lane: true });
    }
  }

  /** A press, moves every 16–80 ms, then a release, or now and then a cancel. */
  async gesture(d, press) {
    const r = this.rngOps;
    d.gesture = true;
    this.gestures++;
    await this.op(d, press);
    const moves = 1 + r.int(30);
    let dx = 0, dy = 0, t = V.now;
    for (let i = 0; i < moves; i++) {
      dx += (r.int(5) - 2) * 12;
      dy += (r.int(5) - 2) * 12;
      t += r.between(16, 80);
      const [x, y] = [dx, dy];
      this.at(t, "drag", async () => {
        if (!d.gesture || d.frozen) return;
        await this.op(d, { op: "drag", dx: x, dy: y });
        await this.op(d, { op: "cursor", x: 500 + x, y: 400 + y });
      });
    }
    this.at(t + r.between(16, 200), "release", async () => {
      if (!d.gesture) return;
      d.gesture = false;
      this.gestures--;
      await this.op(d, { op: r.chance(0.9) ? "release" : "cancel" });
    });
  }

  // MARK: faults and links

  scheduleFaults() {
    const next = () =>
      this.at(V.now + this.rngFault.between(0, 2 * FAULT_MEAN_MS), "fault", async () => {
        if (this.opsLeft <= 0) return;
        await this.fault();
        next();
      });
    next();
  }

  async fault() {
    const r = this.rngFault;
    const weights = { ...FAULTS };
    if (!this.opts.restore) weights.restore = 0;
    const f = r.weighted(weights);
    const d = r.pick(this.devices);
    this.stats.faults[f] = (this.stats.faults[f] ?? 0) + 1;
    switch (f) {
      case "lostResponse":
      case "serverError":
      case "portal":
      case "truncated":
      case "failFast":
        // the next request to reach the server meets it
        this.httpFault = f;
        return;
      case "relayDrop": {
        this.note("fault", { fault: f, dev: d.i });
        for (const c of this.conns.values()) if (c.dev === d.i && c.kind === "ws" && c.server && !c.dead) c.server.close(1011);
        return;
      }
      case "relayRestart":
        this.note("fault", { fault: f });
        return this.relay.restart();
      case "relayEvict":
        this.note("fault", { fault: f });
        return this.relay.evict();
      case "directClose": {
        const eps = [...this.peers.values()].filter((e) => e.open);
        if (!eps.length) return;
        const ep = r.pick(eps);
        this.note("fault", { fault: f, dev: ep.dev });
        await this.deliver(this.devices[ep.dev], { cmd: "peer-state", peer: ep.peer, state: "closed" });
        return this.closeChannel(ep, true);
      }
      case "directSilent": {
        const eps = [...this.peers.values()].filter((e) => e.open && !e.silent);
        if (!eps.length) return;
        const ep = r.pick(eps);
        this.note("fault", { fault: f, dev: ep.dev });
        return this.silence(ep);
      }
      case "skew":
        d.skew = r.chance(0.5) ? 0 : Math.round(r.between(-300_000, 300_000));
        this.note("fault", { fault: f, dev: d.i, skew: d.skew });
        return;
      case "freeze":
        return this.freeze(d, r.chance(0.7) ? r.between(5_000, 60_000) : r.between(60_000, 8 * 3_600_000));
      case "outage": {
        const dest = r.pick(["server", "relay"]);
        const ms = r.between(10_000, 60_000);
        this.note("fault", { fault: f, dev: d.i, dest, ms: Math.round(ms) });
        d.link.blocked[dest] = true;
        this.at(V.now + ms, "outage ends", () => {
          d.link.blocked[dest] = d.link.profile.relayBlocked && dest === "relay";
        });
        return;
      }
      case "restore":
        this.note("fault", { fault: f });
        if (!this.backedUp) {
          this.server.backup();
          this.backedUp = true;
          return;
        }
        return this.server.restore();
    }
  }

  async freeze(d, ms) {
    if (d.frozen) return;
    this.note("fault", { fault: "freeze", dev: d.i, ms: Math.round(ms) });
    d.frozen = true;
    // a long suspension ends the sockets: the OS lets them go, and nobody tells the other end
    if (ms > 30_000) this.at(V.now + 30_000, "suspended", () => d.frozen && this.kill(d));
    this.at(V.now + ms, "thaw", () => this.thaw(d));
  }

  async thaw(d) {
    if (!d.frozen) return;
    d.frozen = false;
    const inbox = d.inbox.splice(0);
    for (const c of inbox) await this.command(d, c);
    // the app shows again, or the Mac wakes: both check the network
    await this.op(d, { op: "retry", changed: d.kind === "swift" });
    if (!d.hidden) await this.op(d, { op: "show", visible: true });
  }

  scheduleLink(d) {
    const step = () => {
      if (this.healing) return;
      const s = d.link.step(V.now);
      if (s.from !== s.to) this.note("link", { dev: d.i, to: s.to, until: Math.round(s.until) });
      if (s.kills) this.kill(d);
      if (s.to === "flapping") this.flap(d, s.until);
      if (s.tell) this.at(V.now + this.rngNet.between(0, 2000), "network event", () => !d.frozen && this.op(d, { op: "retry", changed: true }));
      this.at(Math.max(s.until, V.now + 1), "link", step);
    };
    this.at(V.now + this.rngNet.between(0, 10_000), "link", step);
  }

  flap(d, until) {
    const t = V.now + this.rngNet.between(200, 2000);
    if (t >= until) return;
    this.at(t, "flap", async () => {
      if (this.healing) return;
      this.kill(d);
      if (!d.frozen && this.rngNet.chance(0.7)) await this.op(d, { op: "retry", changed: true });
      this.flap(d, until);
    });
  }

  // MARK: healing and checks

  async heal() {
    this.healing = true;
    this.httpFault = null;
    this.directFails = false;
    this.note("heal", {});
    for (const d of this.devices) {
      d.link.state = d.link.profile.base === "lan" ? "lan" : "good";
      d.link.blocked = { server: false, relay: false };
      d.link.toldOffline = false;
      d.skew = 0;
    }
    // what the queue still holds for the healed network keeps its times; whatever was lost stays lost
    for (const d of this.devices) {
      if (d.frozen) await this.thaw(d);
      if (d.gesture) {
        d.gesture = false;
        this.gestures--;
        await this.op(d, { op: "release" });
      }
      if (!d.joined) {
        d.joined = true;
        await this.op(d, { op: "join", invite: this.invite });
      }
      d.hidden = false;
      await this.op(d, { op: "show", visible: true });
      await this.op(d, { op: "retry", changed: true });
      if (!d.opened) await this.openBoard(d);
    }
    await this.runUntil(V.now + HEAL_MS);
  }

  async check() {
    const snaps = [];
    for (const d of this.devices) snaps.push(await this.command(d, { cmd: "state" }));
    const problems = [];
    const canon = (s) => stable(s.boards);
    const want = canon(snaps[0]);
    const ids = this.devices.map((d) => d.me.device);
    for (const [i, s] of snaps.entries()) {
      const d = this.devices[i];
      if (canon(s) !== want) problems.push({ dev: i, problem: "boards differ from device 0's", diff: firstDiff(snaps[0].boards, s.boards) });
      if (s.pending) problems.push({ dev: i, problem: `${s.pending} records pending` });
      for (const [b, n] of Object.entries(s.overlays)) if (n) problems.push({ dev: i, problem: `${n} overlaid items on ${b}` });
      if (s.mine) problems.push({ dev: i, problem: `holds ${s.mine} items` });
      if (!s.connected) problems.push({ dev: i, problem: "live layer not connected" });
      if (s.status !== "synced") problems.push({ dev: i, problem: `status ${s.status}` });
      const others = ids.filter((x) => x !== d.me.device).sort();
      const missing = others.filter((x) => !s.seen.includes(x));
      if (missing.length) problems.push({ dev: i, problem: `does not see ${missing.length} of the others` });
    }
    const held = this.relay.holds();
    if (Object.keys(held).length) problems.push({ problem: `relay holds ${JSON.stringify(held)}` });
    const hash = createHash("sha256").update(JSON.stringify(this.trace)).update(want).digest("hex").slice(0, 16);
    return { ok: problems.length === 0, problems, hash, trace: this.trace, stats: this.stats, cards: Object.values(snaps[0].boards).reduce((n, b) => n + b.cards.length, 0) };
  }
}

/** JSON with every object's keys sorted, as the two kinds of device order them differently. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

function firstDiff(a, b, path = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return { path, want: a, got: b };
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) {
    const ka = new Set(a.map((x) => x?.id)), kb = new Set(b.map((x) => x?.id));
    return { path, missing: [...ka].filter((x) => !kb.has(x)), extra: [...kb].filter((x) => !ka.has(x)) };
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = firstDiff(a[k], b[k], `${path}/${k}`);
    if (d) return d;
  }
  return null;
}
