/** A PeerTransport that records what Direct asks of it. Answers and accepts resolve at once, or on `release()` while
 * `deferred`; `onOffer` candidates are gathered while an offer is made, as a browser may; a method named in `fail`
 * rejects. */
export class FakeTransport {
  constructor() {
    this.log = [];
    this.sent = [];
    this.deferred = false;
    this.fail = new Set();
    this.waiting = [];
    this.onOffer = [];
    this.onCandidate = () => {};
    this.onState = () => {};
    this.onMessage = () => {};
  }

  create(id) {
    this.log.push(`create ${id}`);
  }

  async offer(id, restart) {
    this.log.push(`offer ${id}${restart ? " restart" : ""}`);
    if (this.fail.has("offer")) throw new Error("offer");
    for (const c of this.onOffer) this.onCandidate(id, c);
    return `offer-sdp ${id}`;
  }

  answer(id, sdp) {
    this.log.push(`answer ${id} ${sdp}`);
    if (this.fail.has("answer")) return Promise.reject(new Error("answer"));
    return this.later(`answer-sdp ${id}`);
  }

  accept(id, sdp) {
    this.log.push(`accept ${id} ${sdp}`);
    if (this.fail.has("accept")) return Promise.reject(new Error("accept"));
    return this.later();
  }

  add(id, c) {
    this.log.push(`add ${id} ${c.candidate}`);
  }

  send(id, text) {
    this.sent.push({ id, data: text });
    return true;
  }

  sendBytes(id, bytes) {
    this.sent.push({ id, data: bytes });
    return true;
  }

  close(id) {
    this.log.push(`close ${id}`);
  }

  later(v) {
    return this.deferred ? new Promise((r) => this.waiting.push(() => r(v))) : Promise.resolve(v);
  }

  release() {
    for (const r of this.waiting.splice(0)) r();
  }
}
