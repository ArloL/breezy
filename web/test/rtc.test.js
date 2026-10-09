import { test } from "node:test";
import assert from "node:assert/strict";

class FakeChannel {
  readyState = "connecting";
  send(text) {
    this.sent = text;
  }
}

class FakePC {
  static made = [];
  connectionState = "new";
  constructor(config) {
    this.config = config;
    FakePC.made.push(this);
  }
  createDataChannel(label, options) {
    this.options = options;
    return (this.channel = new FakeChannel());
  }
  restartIce() {
    this.restarted = true;
  }
  async setLocalDescription() {
    this.localDescription = { sdp: this.remote ? "answer" : "offer" };
  }
  async setRemoteDescription(d) {
    this.remote = d;
  }
  async addIceCandidate(c) {
    this.added = c;
  }
  close() {
    this.closed = true;
  }
  set(state, channel) {
    this.connectionState = state;
    this.channel.readyState = channel;
    this.onconnectionstatechange?.();
  }
}
globalThis.RTCPeerConnection = FakePC;
const { RTCTransport, ICE_SERVERS } = await import("../sync/rtc.js");

test("each peer gets a negotiated, unordered channel without retransmits, over Cloudflare's STUN", () => {
  new RTCTransport().create("p1");
  const pc = FakePC.made.at(-1);
  assert.deepEqual(pc.config, { iceServers: ICE_SERVERS });
  assert.deepEqual(ICE_SERVERS, [{ urls: "stun:stun.cloudflare.com:3478" }]);
  assert.deepEqual(pc.options, { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
});

test("offers, answers, candidates and messages pass through", async () => {
  const t = new RTCTransport(), got = [];
  t.onMessage = (id, text) => got.push([id, text]);
  t.onCandidate = (id, c) => got.push([id, c]);
  t.create("p1");
  const pc = FakePC.made.at(-1);
  assert.equal(await t.offer("p1", false), "offer");
  await t.accept("p1", "remote");
  assert.deepEqual(pc.remote, { type: "answer", sdp: "remote" });
  t.add("p1", { candidate: "c", mid: "0", index: 0 });
  assert.deepEqual(pc.added, { candidate: "c", sdpMid: "0", sdpMLineIndex: 0 });
  pc.onicecandidate({ candidate: { candidate: "x", sdpMid: "0", sdpMLineIndex: 0 } });
  pc.onicecandidate({ candidate: null });
  pc.channel.onmessage({ data: "hi" });
  assert.deepEqual(got, [["p1", { candidate: "x", mid: "0", index: 0 }], ["p1", null], ["p1", "hi"]]);
});

test("a connection that recovers after a restart reports open again, though its channel never closed", async () => {
  const t = new RTCTransport(), states = [];
  t.onState = (id, s) => states.push(s);
  t.create("p1");
  const pc = FakePC.made.at(-1);
  pc.set("connected", "open");
  pc.set("failed", "open");
  await t.offer("p1", true);
  assert.ok(pc.restarted);
  pc.set("connected", "open");
  assert.deepEqual(states, ["open", "failed", "open"]);
});

test("send says whether it went; close forgets the peer", () => {
  const t = new RTCTransport();
  t.create("p1");
  const pc = FakePC.made.at(-1);
  assert.equal(t.send("p1", "x"), false);
  pc.set("connected", "open");
  assert.equal(t.send("p1", "x"), true);
  t.close("p1");
  assert.ok(pc.closed);
  assert.equal(t.send("p1", "x"), false);
});
