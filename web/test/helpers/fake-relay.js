// The relay's rules in memory, with the real hold rules, and a clock for the timers of Live.
import { conflicts, holdsOf } from "../../../relay/src/holds.js";

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
  constructor(relay) {
    this.relay = relay;
    this.id = crypto.randomUUID();
    this.authed = false;
    this.holds = [];
    this.readyState = 0;
  }

  send(text) {
    this.relay.queue.push(() => this.relay.received(this, text));
  }

  close() {
    this.relay.queue.push(() => this.relay.drop(this, null));
  }
}

/** What sockets send is delivered when `run` is called. */
export class FakeRelay {
  constructor() {
    this.sockets = [];
    this.queue = [];
    this.token = null;
    /** Every frame received, in order: { from, text }. */
    this.frames = [];
  }

  connect() {
    const s = new Socket(this);
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

  conns() {
    return this.sockets.filter((s) => s.authed);
  }

  deliver(s, m) {
    const data = JSON.stringify(m);
    this.queue.push(() => s.onmessage?.({ data }));
  }

  announce() {
    for (const s of this.conns()) this.deliver(s, { t: "holds", holds: holdsOf(this.conns()) });
  }

  received(s, text) {
    if (!this.sockets.includes(s)) return;
    const m = JSON.parse(text);
    this.frames.push({ from: s.id, text });
    if (!s.authed) {
      if (m.t !== "auth" || (this.token !== null && this.token !== m.token)) return this.drop(s, 4001);
      this.token = m.token;
      s.authed = true;
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
    for (const x of this.conns()) if (x !== s && (!m.to || m.to === x.id)) this.deliver(x, { from: s.id, body: m.body });
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
