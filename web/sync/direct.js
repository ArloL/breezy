// Direct data channels to a space's other connections, beside the relay, for cursors and live edits, as BreezyKit's
// Direct; see the WebRTC design. Offers, answers and candidates go through the relay; the transport does WebRTC.
export const OPEN_TIMEOUT_MS = 10_000;
export const RESTART_MS = 2_000;
export const MAX_RESTARTS = 3;
/** A version 2 channel beats every tick; once its other side has beaten, this long without hearing anything closes it,
 * as ICE takes about 30 s to notice a network that went. */
export const SILENT_MS = 2_500;
/** Not compact, so devices from before the beat drop it. */
export const BEAT = new Uint8Array([0]);

const isBeat = (data) => data instanceof Uint8Array && data.length === 1 && data[0] === 0;

const iceOf = (b) =>
  typeof b.candidate === "string" ? { candidate: b.candidate, mid: typeof b.mid === "string" ? b.mid : null, index: Number.isInteger(b.index) ? b.index : null } : null;

const versionOf = (b) => (typeof b.v === "number" && b.v >= 2 ? 2 : 1);

export class Direct {
  /** `relay(to, body)` sends through the relay; `message(from, data)` is what came direct: text on a version 1 link,
   * a `Uint8Array` on a version 2 one; `change()` follows a channel opening or closing, `lost()` one failing or falling
   * silent. */
  constructor(transport, { now, relay, message, change, lost }) {
    Object.assign(this, { transport, now, relay, message, change, lost });
    /** Connection id → { id, offerer, version, up, open, everOpen, beats, heardAt, since, restarts, restartAt, remote, inbox, ready,
     * outbox, answering }; `up` is the transport's open, `open` that and not silent. */
    this.links = new Map();
    transport.onCandidate = (id, c) => this.gathered(id, c);
    transport.onState = (id, state) => this.state(id, state);
    transport.onMessage = (id, data) => {
      const l = this.links.get(id);
      if (!l?.up) return;
      l.heardAt = this.now();
      if (isBeat(data)) l.beats = true;
      if (!l.open) this.opened(l, true);
      if (!isBeat(data) && (l.version === 2 ? data instanceof Uint8Array : typeof data === "string")) this.message(id, data);
    };
  }

  isOpen(id) {
    return this.links.get(id)?.open ?? false;
  }

  /** 2 when the other side's offer or answer said so, else 1. */
  version(id) {
    return this.links.get(id)?.version ?? 1;
  }

  send(id, text) {
    return this.isOpen(id) && this.transport.send(id, text);
  }

  sendBytes(id, bytes) {
    return this.isOpen(id) && this.transport.sendBytes(id, bytes);
  }

  /** This connection is new to the space: it offers to each of `ids`, so two sides never offer at once. */
  welcome(ids) {
    this.reset();
    for (const id of ids) this.offer(this.link(id, true));
  }

  link(id, offerer) {
    this.transport.create(id);
    const l = { id, offerer, version: 1, up: false, open: false, everOpen: false, beats: false, heardAt: 0, since: this.now(), restarts: 0, restartAt: null, remote: false, inbox: [], ready: false, outbox: [], answering: false };
    this.links.set(id, l);
    return l;
  }

  async offer(l, restart = false) {
    l.ready = false;
    l.remote = false;
    const sdp = await this.transport.offer(l.id, restart).catch(() => null);
    if (this.links.get(l.id) !== l) return;
    if (sdp === null) return this.leave(l.id);
    this.relay(l.id, { t: "offer", sdp, v: 2 });
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
      l.version = versionOf(b);
      const sdp = await this.transport.answer(from, b.sdp).catch(() => null);
      l.answering = false;
      if (this.links.get(from) !== l) return;
      if (sdp === null) return this.leave(from);
      this.remoteSet(l);
      this.relay(from, { t: "answer", sdp, v: 2 });
      this.flushOut(l);
    } else if (b.t === "answer" && typeof b.sdp === "string" && l?.offerer) {
      const ok = await this.transport.accept(from, b.sdp).then(() => true, () => false);
      if (this.links.get(from) !== l) return;
      if (!ok) return this.leave(from);
      l.version = versionOf(b);
      this.remoteSet(l);
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
    l.up = s === "open";
    this.opened(l, l.up);
    if (s === "failed" && l.offerer && l.restarts < MAX_RESTARTS && l.restartAt === null) l.restartAt = this.now() + RESTART_MS;
  }

  opened(l, open) {
    const was = l.open;
    l.open = open;
    if (open) [l.everOpen, l.restarts, l.heardAt] = [true, 0, this.now()];
    if (was !== open) this.change();
    if (was && !open) this.lost();
  }

  /** About once a second: beats, closes what went silent, restarts what failed or went silent, and gives up on what never
   * opened. */
  tick() {
    const now = this.now();
    for (const l of [...this.links.values()]) {
      if (l.up && l.version === 2) this.transport.sendBytes(l.id, BEAT);
      if (l.open && l.beats && now - l.heardAt >= SILENT_MS) {
        this.opened(l, false);
        if (l.offerer && l.restarts < MAX_RESTARTS && l.restartAt === null) l.restartAt = now;
      }
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
