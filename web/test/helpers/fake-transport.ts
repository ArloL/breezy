import type { Ice, LinkState, PeerTransport } from "../../sync/direct.ts";

/** A PeerTransport that records what Direct asks of it. Answers and accepts resolve at once, or on `release()` while
 * `deferred`; `onOffer` candidates are gathered while an offer is made, as a browser may; a method named in `fail`
 * rejects. */
export class FakeTransport implements PeerTransport {
  log: string[];
  sent: { id: string; data: string | Uint8Array }[];
  deferred: boolean;
  fail: Set<string>;
  waiting: (() => void)[];
  onOffer: Ice[];
  onCandidate: (id: string, c: Ice | null) => void;
  onState: (id: string, state: LinkState) => void;
  onMessage: (id: string, data: string | Uint8Array) => void;

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

  create(id: string) {
    this.log.push(`create ${id}`);
  }

  async offer(id: string, restart: boolean) {
    this.log.push(`offer ${id}${restart ? " restart" : ""}`);
    if (this.fail.has("offer")) throw new Error("offer");
    for (const c of this.onOffer) this.onCandidate(id, c);
    return `offer-sdp ${id}`;
  }

  answer(id: string, sdp: string) {
    this.log.push(`answer ${id} ${sdp}`);
    if (this.fail.has("answer")) return Promise.reject(new Error("answer"));
    return this.later(`answer-sdp ${id}`);
  }

  accept(id: string, sdp: string) {
    this.log.push(`accept ${id} ${sdp}`);
    if (this.fail.has("accept")) return Promise.reject(new Error("accept"));
    return this.later();
  }

  add(id: string, c: Ice) {
    this.log.push(`add ${id} ${c.candidate}`);
  }

  send(id: string, text: string) {
    this.sent.push({ id, data: text });
    return true;
  }

  sendBytes(id: string, bytes: Uint8Array) {
    this.sent.push({ id, data: bytes });
    return true;
  }

  close(id: string) {
    this.log.push(`close ${id}`);
  }

  later<T = void>(v?: T): Promise<T> {
    return this.deferred ? new Promise<T>((r) => this.waiting.push(() => r(v as T))) : Promise.resolve(v as T);
  }

  release() {
    for (const r of this.waiting.splice(0)) r();
  }
}
