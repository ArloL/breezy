// The relay's rules in memory, with the real hold rules and frames, and a clock for the timers of Live.
import { conflicts, holdsOf, lapsed } from "../../../relay/src/holds.js";
import { outFrame, parseFrame } from "../../../relay/src/frames.js";
import { encode, decode } from "../../sync/base64.ts";

type Holds = Record<string, string[]>;
type Conn = { id: string; holds: string[]; last: number };
const relayConflicts = conflicts as (conns: Conn[], id: string, ids: string[]) => string[];
const relayHoldsOf = holdsOf as (conns: Conn[]) => Holds;
const relayLapsed = lapsed as <C extends Conn>(conns: C[], now: number) => C[];
const relayParseFrame = parseFrame as (bytes: Uint8Array) => { to: number | null; body: Uint8Array } | null;
const relayOutFrame = outFrame as (from: number, body: Uint8Array) => Uint8Array<ArrayBuffer>;

type Timed = "encrypt" | "decrypt" | "importKey" | "deriveKey" | "deriveBits" | "digest";
type Body = { bytes?: Uint8Array | null; text?: string };
export type Frame = { from: string; text?: string; bytes?: Uint8Array };
export type MessageEvent = { data: string | ArrayBuffer };

/** Crypto calls under way: sealing and opening run on a thread pool, which a busy machine makes slow. */
let pending = 0;
for (const name of ["encrypt", "decrypt", "importKey", "deriveKey", "deriveBits", "digest"] as Timed[]) {
  const f = (crypto.subtle[name] as (...args: unknown[]) => Promise<unknown>).bind(crypto.subtle);
  (crypto.subtle as unknown as Record<Timed, unknown>)[name] = (...args: unknown[]) => {
    pending++;
    return f(...args).finally(() => pending--);
  };
}

/** Time and timers under a test's control, in ms. */
export class Clock {
  t: number;
  timers: { at: number; fn: () => void }[];
  now: () => number;
  schedule: (ms: number, fn: () => void) => void;

  constructor() {
    this.t = 1_000_000;
    this.timers = [];
    this.now = () => this.t;
    this.schedule = (ms, fn) => void this.timers.push({ at: this.t + ms, fn });
  }

  /** Moves time on by `ms`, running the timers due meanwhile, earliest first. */
  advance(ms: number) {
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

export class Socket {
  relay: FakeRelay;
  id: string;
  authed: boolean;
  v: number;
  holds: string[];
  last: number;
  readyState: number;
  halfOpen: boolean;
  binaryType!: BinaryType;
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;

  constructor(relay: FakeRelay, id: string) {
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

  send(data: string | Uint8Array) {
    this.relay.queue.push(() => this.relay.received(this, data));
  }

  close() {
    this.relay.queue.push(() => this.relay.drop(this, null));
  }
}

/** What sockets send is delivered when `run` is called. `old` acts as the relay before the lean sync design: UUID ids,
 * JSON only, binary frames dropped unread. */
export class FakeRelay {
  old: boolean;
  now: () => number;
  sockets: Socket[];
  queue: (() => unknown)[];
  token: string | null;
  frames: Frame[];
  pings: number;
  opened: number;
  silent?: boolean;

  constructor({ old = false, now = () => 0 }: { old?: boolean; now?: () => number } = {}) {
    this.old = old;
    this.now = now;
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
    // opened over a network that just went: it hears nothing and is not heard
    s.halfOpen = this.silent === true;
    this.sockets.push(s);
    this.queue.push(() => {
      s.readyState = 1;
      s.onopen?.();
    });
    return s;
  }

  /** Delivers until nothing is left, letting sealing and opening finish between rounds, however long a busy machine takes. */
  async run() {
    for (let i = 0, calm = 0; i < 100_000 && calm < 40; i++) {
      calm = this.queue.length || pending ? 0 : calm + 1;
      while (this.queue.length) this.queue.shift()!();
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  kick(s: Socket, code: number) {
    this.drop(s, code);
  }

  lapse(s: Socket) {
    s.holds = [];
    this.announce();
  }

  /** Lets the holds of those silent for over 10 s lapse, as the relay's alarm does. */
  sweep() {
    for (const s of relayLapsed(this.conns(), this.now())) this.lapse(s);
  }

  conns() {
    return this.sockets.filter((s) => s.authed);
  }

  deliver(s: Socket, m: object) {
    const data = JSON.stringify(m);
    this.queue.push(() => s.halfOpen || s.onmessage?.({ data }));
  }

  announce() {
    for (const s of this.conns()) this.deliver(s, { t: "holds", holds: relayHoldsOf(this.conns()) });
  }

  received(s: Socket, data: string | Uint8Array) {
    if (!this.sockets.includes(s) || s.halfOpen) return;
    if (typeof data !== "string") {
      const bytes = new Uint8Array(data);
      this.frames.push({ from: s.id, bytes });
      if (this.old) return;
      s.last = this.now();
      if (!s.authed) return this.drop(s, 4001);
      const f = relayParseFrame(bytes);
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
      const replaced = typeof m.replaces === "string" && this.conns().find((x) => x !== s && x.id === m.replaces);
      if (replaced) this.drop(replaced, 1000);
      const others = this.conns().filter((x) => x !== s);
      this.deliver(s, { t: "welcome", id: s.id, peers: others.map((x) => x.id), holds: relayHoldsOf(others) });
      for (const x of others) this.deliver(x, { t: "join", id: s.id });
      return;
    }
    if (m.t === "hold") {
      const refused = relayConflicts(this.conns(), s.id, m.ids);
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
  forward(s: Socket, body: Body, to: string | null) {
    for (const x of this.conns()) {
      if (x === s || (to !== null && x.id !== to)) continue;
      if (x.v === 2) {
        if (!(body.bytes ??= decode(body.text!))) continue;
        const frame = relayOutFrame(Number(s.id), body.bytes);
        this.queue.push(() => x.halfOpen || x.onmessage?.({ data: frame.buffer }));
      } else this.deliver(x, { from: s.id, body: (body.text ??= encode(body.bytes!)) });
    }
  }

  drop(s: Socket, code: number | null) {
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
