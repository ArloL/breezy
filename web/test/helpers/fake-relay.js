// The relay's rules in memory, with the real hold rules and frames, and a clock for the timers of Live.
import { conflicts, holdsOf, lapsed } from "../../../relay/src/holds.js";
import { outFrame, parseFrame } from "../../../relay/src/frames.js";
import { encode, decode } from "../../sync/base64.js";

/** Time and timers under a test's control, in ms. */
export class Clock {
  constructor() {
    this.t = 1_000_000;
    this.timers = [];
    this.now = () => this.t;
    this.schedule = (ms, fn) => this.timers.push({ at: this.t + ms, fn });
  }

  /** Moves time on by `ms`, running the timers due meanwhile, earliest first. */
  advance(ms) {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers.splice(this.timers.indexOf(due), 1);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = end;
  }
}

class Socket {
  constructor(relay, id) {
    this.relay = relay;
    this.id = id;
    this.authed = false;
    /** 2 when its auth said so: bodies reach it as binary frames, else as JSON. */
    this.v = 1;
    this.holds = [];
    /** When the relay last read a frame from it, which keeps its holds. */
    this.last = relay.now();
    this.readyState = 0;
    /** Its network is gone without a close: nothing it sends arrives, and nothing reaches it. */
    this.halfOpen = false;
  }

  send(data) {
    this.relay.queue.push(() => this.relay.received(this, data));
  }

  close() {
    this.relay.queue.push(() => this.relay.drop(this, null));
  }
}

/** What sockets send is delivered when `run` is called. `old` acts as the relay before the lean sync design: UUID ids,
 * JSON only, binary frames dropped unread. */
export class FakeRelay {
  constructor({ old = false, now = () => 0 } = {}) {
    Object.assign(this, { old, now });
    this.sockets = [];
    this.queue = [];
    this.token = null;
    /** Every frame received, in order: { from, text } or { from, bytes }. */
    this.frames = [];
    this.pings = 0;
    /** Sockets opened so far. */
    this.opened = 0;
  }

  connect() {
    const n = ++this.opened;
    const s = new Socket(this, this.old ? crypto.randomUUID() : String(n));
    this.sockets.push(s);
    this.queue.push(() => {
      s.readyState = 1;
      s.onopen?.();
    });
    return s;
  }

  /** Delivers until nothing is left, letting sealing and opening finish between rounds. */
  async run() {
    for (let i = 0; i < 40; i++) {
      while (this.queue.length) this.queue.shift()();
      await new Promise((r) => setImmediate(r));
    }
  }

  kick(s, code) {
    this.drop(s, code);
  }

  lapse(s) {
    s.holds = [];
    this.announce();
  }

  /** Lets the holds of those silent for over 10 s lapse, as the relay's alarm does. */
  sweep() {
    for (const s of lapsed(this.conns(), this.now())) this.lapse(s);
  }

  conns() {
    return this.sockets.filter((s) => s.authed);
  }

  deliver(s, m) {
    const data = JSON.stringify(m);
    this.queue.push(() => s.halfOpen || s.onmessage?.({ data }));
  }

  announce() {
    for (const s of this.conns()) this.deliver(s, { t: "holds", holds: holdsOf(this.conns()) });
  }

  received(s, data) {
    if (!this.sockets.includes(s) || s.halfOpen) return;
    if (typeof data !== "string") {
      const bytes = new Uint8Array(data);
      this.frames.push({ from: s.id, bytes });
      if (this.old) return;
      s.last = this.now();
      if (!s.authed) return this.drop(s, 4001);
      const f = parseFrame(bytes);
      return f && this.forward(s, { bytes: f.body }, f.to === null ? null : String(f.to));
    }
    if (data === "ping") {
      this.pings++;
      return this.queue.push(() => s.halfOpen || s.onmessage?.({ data: "pong" }));
    }
    const m = JSON.parse(data);
    this.frames.push({ from: s.id, text: data });
    s.last = this.now();
    if (!s.authed) {
      if (m.t !== "auth" || (this.token !== null && this.token !== m.token)) return this.drop(s, 4001);
      this.token = m.token;
      s.authed = true;
      s.v = m.v === 2 && !this.old ? 2 : 1;
      const others = this.conns().filter((x) => x !== s);
      this.deliver(s, { t: "welcome", id: s.id, peers: others.map((x) => x.id), holds: holdsOf(others) });
      for (const x of others) this.deliver(x, { t: "join", id: s.id });
      return;
    }
    if (m.t === "hold") {
      const refused = conflicts(this.conns(), s.id, m.ids);
      if (refused.length) return this.deliver(s, { t: "refused", ids: refused });
      s.holds = [...new Set([...s.holds, ...m.ids])].sort();
      return this.announce();
    }
    if (m.t === "release") {
      if (!s.holds.length) return;
      s.holds = [];
      return this.announce();
    }
    if (typeof m.body !== "string") return;
    this.forward(s, { text: m.body }, m.to || null);
  }

  /** A body ({bytes} or {text}, base64url) from `s` to `to` or everyone else: binary to v2 sockets, JSON to older ones. */
  forward(s, body, to) {
    for (const x of this.conns()) {
      if (x === s || (to !== null && x.id !== to)) continue;
      if (x.v === 2) {
        if (!(body.bytes ??= decode(body.text))) continue;
        const frame = outFrame(Number(s.id), body.bytes);
        this.queue.push(() => x.halfOpen || x.onmessage?.({ data: frame.buffer }));
      } else this.deliver(x, { from: s.id, body: (body.text ??= encode(body.bytes)) });
    }
  }

  drop(s, code) {
    if (!this.sockets.includes(s)) return;
    this.sockets.splice(this.sockets.indexOf(s), 1);
    s.readyState = 3;
    if (s.authed) {
      for (const x of this.conns()) this.deliver(x, { t: "leave", id: s.id });
      if (s.holds.length) this.announce();
    }
    if (code !== null) this.queue.push(() => s.onclose?.({ code }));
  }
}
