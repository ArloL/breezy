// Direct data channels to a space's other connections, beside the relay, for cursors and live edits, as BreezyKit's
// Direct; see the WebRTC design. Offers, answers and candidates go through the relay; the transport does WebRTC.
export const OPEN_TIMEOUT_MS = 10_000;
export const RESTART_MS = 2_000;
export const MAX_RESTARTS = 3;

const iceOf = (b) =>
  typeof b.candidate === "string" ? { candidate: b.candidate, mid: typeof b.mid === "string" ? b.mid : null, index: Number.isInteger(b.index) ? b.index : null } : null;

export class Direct {
  /** `relay(to, body)` sends through the relay; `message(from, text)` is a sealed body that came direct; `change()`
   * follows a channel opening or closing. */
  constructor(transport, { now, relay, message, change }) {
    Object.assign(this, { transport, now, relay, message, change });
    /** Connection id → { id, offerer, open, everOpen, since, restarts, restartAt, remote, inbox, ready, outbox, answering }. */
    this.links = new Map();
    transport.onCandidate = (id, c) => this.gathered(id, c);
    transport.onState = (id, state) => this.state(id, state);
    transport.onMessage = (id, text) => this.links.get(id)?.open && this.message(id, text);
  }

  isOpen(id) {
    return this.links.get(id)?.open ?? false;
  }

  send(id, text) {
    return this.isOpen(id) && this.transport.send(id, text);
  }

  /** This connection is new to the space: it offers to each of `ids`, so two sides never offer at once. */
  welcome(ids) {
    this.reset();
    for (const id of ids) this.offer(this.link(id, true));
  }

  link(id, offerer) {
    this.transport.create(id);
    const l = { id, offerer, open: false, everOpen: false, since: this.now(), restarts: 0, restartAt: null, remote: false, inbox: [], ready: false, outbox: [], answering: false };
    this.links.set(id, l);
    return l;
  }

  async offer(l, restart = false) {
    l.ready = false;
    l.remote = false;
    const sdp = await this.transport.offer(l.id, restart).catch(() => null);
    if (this.links.get(l.id) !== l) return;
    if (sdp === null) return this.leave(l.id);
    this.relay(l.id, { t: "offer", sdp });
    this.flushOut(l);
  }

  /** An offer, answer or candidate from connection `from`, through the relay. */
  async heard(from, b) {
    let l = this.links.get(from);
    if (b.t === "offer" && typeof b.sdp === "string") {
      if (l?.offerer || l?.answering) return;
      l ??= this.link(from, false);
      l.since = this.now();
      l.ready = false;
      l.remote = false;
      l.answering = true;
      const sdp = await this.transport.answer(from, b.sdp).catch(() => null);
      l.answering = false;
      if (this.links.get(from) !== l) return;
      if (sdp === null) return this.leave(from);
      this.remoteSet(l);
      this.relay(from, { t: "answer", sdp });
      this.flushOut(l);
    } else if (b.t === "answer" && typeof b.sdp === "string" && l?.offerer) {
      const ok = await this.transport.accept(from, b.sdp).then(() => true, () => false);
      if (this.links.get(from) !== l) return;
      if (ok) this.remoteSet(l);
      else this.leave(from);
    } else if (b.t === "ice" && l) {
      const c = iceOf(b);
      if (!c) return;
      if (l.remote) this.transport.add(from, c);
      else l.inbox.push(c);
    }
  }

  remoteSet(l) {
    l.remote = true;
    for (const c of l.inbox.splice(0)) this.transport.add(l.id, c);
  }

  /** A candidate this side gathered: after its offer or answer has gone, never before. */
  gathered(id, c) {
    const l = this.links.get(id);
    if (!l) return;
    const body = { t: "ice", ...(c ?? { candidate: null, mid: null, index: null }) };
    if (l.ready) this.relay(id, body);
    else l.outbox.push(body);
  }

  flushOut(l) {
    l.ready = true;
    for (const b of l.outbox.splice(0)) this.relay(l.id, b);
  }

  state(id, s) {
    const l = this.links.get(id);
    if (!l) return;
    const was = l.open;
    l.open = s === "open";
    if (l.open) [l.everOpen, l.restarts] = [true, 0];
    if (s === "failed" && l.offerer && l.restarts < MAX_RESTARTS && l.restartAt === null) l.restartAt = this.now() + RESTART_MS;
    if (was !== l.open) this.change();
  }

  /** About once a second: restarts what failed, and gives up on what never opened. */
  tick() {
    const now = this.now();
    for (const l of [...this.links.values()]) {
      if (l.restartAt !== null && now >= l.restartAt) {
        l.restartAt = null;
        l.restarts++;
        l.since = now;
        this.offer(l, true);
      } else if (!l.everOpen && l.restartAt === null && now - l.since >= OPEN_TIMEOUT_MS) {
        this.leave(l.id);
      }
    }
  }

  leave(id) {
    const l = this.links.get(id);
    if (!l) return;
    this.links.delete(id);
    this.transport.close(id);
    if (l.open) this.change();
  }

  reset() {
    for (const id of [...this.links.keys()]) this.leave(id);
  }
}
