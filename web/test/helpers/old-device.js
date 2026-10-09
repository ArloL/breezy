// A device from before the lean sync design on the fake relay: auth without `v`, JSON frames, and JSON bodies sealed
// with the space key, with `colour` and without `v` or `boards`.
import { encode, decode } from "../../sync/base64.js";
import { colourOf } from "../../sync/live.js";

const enc = new TextEncoder(), dec = new TextDecoder();

export class OldDevice {
  constructor(relay, keys, { name = "Old", device }) {
    Object.assign(this, { relay, keys, name, device });
    this.id = null;
    this.board = null;
    /** Bodies heard, opened: { from, body }. */
    this.heard = [];
    /** Bodies that opened but were not JSON. */
    this.unreadable = 0;
  }

  connect() {
    const ws = (this.ws = this.relay.connect());
    ws.onopen = () => ws.send(JSON.stringify({ t: "auth", token: encode(this.keys.relayToken) }));
    ws.onmessage = async ({ data }) => {
      const m = JSON.parse(data);
      if (m.t === "welcome") this.id = m.id;
      else if (m.t === "join") await this.presence(this.board, m.id);
      else if (typeof m.from === "string" && typeof m.body === "string") {
        const plain = dec.decode(await this.keys.openLive(decode(m.body)));
        try {
          this.heard.push({ from: m.from, body: JSON.parse(plain) });
        } catch {
          this.unreadable++;
        }
      }
    };
  }

  async send(body, to) {
    const sealed = encode(await this.keys.sealLive(enc.encode(JSON.stringify(body))));
    this.ws.send(JSON.stringify(to ? { to, body: sealed } : { body: sealed }));
  }

  presence(board, to) {
    this.board = board;
    return this.send({ t: "presence", device: this.device, name: this.name, colour: colourOf(this.device), board, selection: [], cursor: null }, to);
  }

  /** The last body of type `t` heard. */
  last(t) {
    return this.heard.filter((h) => h.body.t === t).at(-1)?.body;
  }
}
