import { test } from "node:test";
import assert from "node:assert/strict";
import { Direct, BEAT, OPEN_TIMEOUT_MS, RESTART_MS, SILENT_MS } from "../sync/direct.js";
import { FakeTransport } from "./helpers/fake-transport.js";

const settle = () => new Promise((r) => setImmediate(r));

function direct() {
  let t = 1_000_000;
  const transport = new FakeTransport(), relayed = [], messages = [];
  let changes = 0, lost = 0;
  const d = new Direct(transport, { now: () => t, relay: (to, b) => relayed.push({ to, ...b }), message: (from, data) => messages.push({ from, data }), change: () => changes++, lost: () => lost++ });
  return { d, transport, relayed, messages, advance: (ms) => (t += ms), changes: () => changes, lost: () => lost };
}

test("the newcomer offers to everyone already here, its candidates after its offer", async () => {
  const { d, transport, relayed } = direct();
  transport.onOffer = [{ candidate: "c1", mid: "0", index: 0 }];
  d.welcome(["p1", "p2"]);
  await settle();
  assert.deepEqual(transport.log, ["create p1", "offer p1", "create p2", "offer p2"]);
  assert.deepEqual(relayed.map((b) => `${b.t} ${b.to}`), ["offer p1", "ice p1", "offer p2", "ice p2"]);
  assert.deepEqual(relayed[1], { to: "p1", t: "ice", candidate: "c1", mid: "0", index: 0 });
});

test("an offer is answered; candidates that come early wait for the remote description", async () => {
  const { d, transport, relayed } = direct();
  transport.deferred = true;
  d.heard("p1", { t: "offer", sdp: "o" });
  d.heard("p1", { t: "ice", candidate: "c1", mid: "0", index: 0 });
  await settle();
  assert.deepEqual(transport.log, ["create p1", "answer p1 o"]);
  transport.release();
  await settle();
  assert.deepEqual(transport.log, ["create p1", "answer p1 o", "add p1 c1"]);
  assert.deepEqual(relayed, [{ to: "p1", t: "answer", sdp: "answer-sdp p1", v: 2 }]);
});

test("an answer is accepted, then early candidates are added", async () => {
  const { d, transport } = direct();
  d.welcome(["p1"]);
  await settle();
  d.heard("p1", { t: "ice", candidate: "c1", mid: "0", index: 0 });
  d.heard("p1", { t: "answer", sdp: "a" });
  await settle();
  assert.deepEqual(transport.log, ["create p1", "offer p1", "accept p1 a", "add p1 c1"]);
});

test("an offer to a connection that offered itself is ignored", async () => {
  const { d, transport, relayed } = direct();
  d.welcome(["p1"]);
  await settle();
  d.heard("p1", { t: "offer", sdp: "o" });
  await settle();
  assert.deepEqual(transport.log, ["create p1", "offer p1"]);
  assert.deepEqual(relayed.map((b) => b.t), ["offer"]);
});

test("open channels carry messages; others do not", async () => {
  const { d, transport, messages, changes } = direct();
  d.welcome(["p1"]);
  await settle();
  transport.onMessage("p1", "early");
  transport.onState("p1", "open");
  assert.ok(d.isOpen("p1"));
  assert.equal(changes(), 1);
  transport.onMessage("p1", "hello");
  assert.deepEqual(messages, [{ from: "p1", data: "hello" }]);
  assert.ok(d.send("p1", "x"));
  assert.ok(!d.send("p2", "x"));
  assert.deepEqual(transport.sent, [{ id: "p1", data: "x" }]);
});

test("offers and answers say version 2; a link is version 2 only when the other side said so", async () => {
  const offerer = (answer) => async () => {
    const { d, relayed } = direct();
    d.welcome(["p1"]);
    await settle();
    assert.deepEqual(relayed[0], { to: "p1", t: "offer", sdp: "offer-sdp p1", v: 2 });
    assert.equal(d.version("p1"), 1);
    d.heard("p1", answer);
    await settle();
    return d.version("p1");
  };
  assert.equal(await offerer({ t: "answer", sdp: "a", v: 2 })(), 2);
  assert.equal(await offerer({ t: "answer", sdp: "a" })(), 1);
  const answerer = async (offer) => {
    const { d, relayed } = direct();
    d.heard("p1", offer);
    await settle();
    assert.equal(relayed[0].v, 2);
    return d.version("p1");
  };
  assert.equal(await answerer({ t: "offer", sdp: "o", v: 2 }), 2);
  assert.equal(await answerer({ t: "offer", sdp: "o" }), 1);
  assert.equal(direct().d.version("p9"), 1);
});

test("a version 2 link carries only bytes, a version 1 link only text", async () => {
  const { d, transport, messages } = direct();
  d.welcome(["p1"]);
  d.heard("p2", { t: "offer", sdp: "o", v: 2 });
  await settle();
  transport.onState("p1", "open");
  transport.onState("p2", "open");
  const bytes = new Uint8Array([1, 2]);
  transport.onMessage("p1", bytes);
  transport.onMessage("p1", "one");
  transport.onMessage("p2", "two");
  transport.onMessage("p2", bytes);
  assert.deepEqual(messages, [{ from: "p1", data: "one" }, { from: "p2", data: bytes }]);
  assert.ok(d.sendBytes("p2", bytes));
  assert.ok(!d.sendBytes("p3", bytes));
  assert.deepEqual(transport.sent, [{ id: "p2", data: bytes }]);
});

test("a channel that does not open within 10 s is given up", async () => {
  const { d, transport, advance } = direct();
  d.welcome(["p1"]);
  await settle();
  advance(OPEN_TIMEOUT_MS - 1);
  d.tick();
  assert.ok(!transport.log.includes("close p1"));
  advance(1);
  d.tick();
  assert.ok(transport.log.includes("close p1"));
  assert.ok(!d.isOpen("p1"));
});

test("the offerer restarts ICE on failure, up to three times, 2 s apart", async () => {
  const { d, transport, advance } = direct();
  d.welcome(["p1"]);
  await settle();
  transport.onState("p1", "open");
  for (let i = 0; i < 4; i++) {
    transport.onState("p1", "failed");
    advance(RESTART_MS);
    d.tick();
    await settle();
  }
  assert.equal(transport.log.filter((l) => l === "offer p1 restart").length, 3);
  assert.ok(!d.isOpen("p1"));
});

test("the answerer waits for the offerer to restart", async () => {
  const { d, transport, advance } = direct();
  d.heard("p1", { t: "offer", sdp: "o" });
  await settle();
  transport.onState("p1", "open");
  transport.onState("p1", "failed");
  advance(RESTART_MS);
  d.tick();
  await settle();
  assert.ok(!transport.log.some((l) => l.startsWith("offer")));
  assert.ok(!transport.log.includes("close p1"));
});

test("leave and reset close connections", async () => {
  const { d, transport } = direct();
  d.welcome(["p1", "p2"]);
  await settle();
  d.leave("p1");
  d.reset();
  assert.deepEqual(transport.log.filter((l) => l.startsWith("close")), ["close p1", "close p2"]);
});

test("a second offer while an answer is in flight is ignored", async () => {
  const { d, transport, relayed } = direct();
  transport.deferred = true;
  d.heard("p1", { t: "offer", sdp: "o" });
  d.heard("p1", { t: "offer", sdp: "o" });
  transport.release();
  await settle();
  assert.deepEqual(transport.log, ["create p1", "answer p1 o"]);
  assert.deepEqual(relayed, [{ to: "p1", t: "answer", sdp: "answer-sdp p1", v: 2 }]);
});

test("a failed accept closes the connection", async () => {
  const { d, transport } = direct();
  transport.fail.add("accept");
  d.welcome(["p1"]);
  await settle();
  d.heard("p1", { t: "answer", sdp: "a" });
  await settle();
  assert.ok(transport.log.includes("close p1"));
  assert.ok(!d.isOpen("p1"));
});

/** A version 2 channel to p1 that is open and has beaten once; this side offered unless `answerer`. */
async function beating(answerer = false) {
  const r = direct();
  if (answerer) r.d.heard("p1", { t: "offer", sdp: "o", v: 2 });
  else {
    r.d.welcome(["p1"]);
    await settle();
    r.d.heard("p1", { t: "answer", sdp: "a", v: 2 });
  }
  await settle();
  r.transport.onState("p1", "open");
  r.transport.onMessage("p1", BEAT);
  return r;
}

test("each tick beats over every open version 2 channel, and a beat is no message", async () => {
  const { d, transport, messages } = await beating();
  d.heard("p2", { t: "offer", sdp: "o" });
  await settle();
  transport.onState("p2", "open");
  d.tick();
  assert.deepEqual(transport.sent, [{ id: "p1", data: BEAT }]);
  assert.deepEqual(messages, []);
});

test("a channel silent for 2.5 s after a beat closes, and its offerer restarts ICE at once", async () => {
  const { d, transport, advance, changes } = await beating();
  advance(SILENT_MS - 1);
  d.tick();
  assert.ok(d.isOpen("p1"));
  advance(1);
  d.tick();
  await settle();
  assert.ok(!d.isOpen("p1"));
  assert.equal(changes(), 2);
  assert.ok(transport.log.includes("offer p1 restart"));
});

test("a silent channel's answerer closes it and waits for the offerer to restart", async () => {
  const { d, transport, advance } = await beating(true);
  advance(SILENT_MS);
  d.tick();
  await settle();
  assert.ok(!d.isOpen("p1"));
  assert.ok(!transport.log.some((l) => l.startsWith("offer")));
});

test("any message keeps a channel open", async () => {
  const { d, transport, advance } = await beating();
  for (let i = 0; i < 5; i++) {
    advance(SILENT_MS - 1);
    transport.onMessage("p1", new Uint8Array([0x90]));
    d.tick();
  }
  assert.ok(d.isOpen("p1"));
});

test("a channel that never beat is not closed for silence", async () => {
  const { d, transport, advance } = direct();
  d.heard("p1", { t: "offer", sdp: "o", v: 2 });
  await settle();
  transport.onState("p1", "open");
  advance(OPEN_TIMEOUT_MS);
  d.tick();
  assert.ok(d.isOpen("p1"));
});

test("a channel closed for silence opens again when heard", async () => {
  const { d, transport, messages, advance, changes } = await beating(true);
  advance(SILENT_MS);
  d.tick();
  const bytes = new Uint8Array([0x90]);
  transport.onMessage("p1", bytes);
  assert.ok(d.isOpen("p1"));
  assert.equal(changes(), 3);
  assert.deepEqual(messages, [{ from: "p1", data: bytes }]);
});

test("a channel closed for silence still beats, so the other side can hear it again", async () => {
  const { d, transport, advance } = await beating(true);
  advance(SILENT_MS);
  d.tick();
  transport.sent.length = 0;
  d.tick();
  assert.deepEqual(transport.sent, [{ id: "p1", data: BEAT }]);
});

test("a channel that fails or falls silent is lost; one left is not", async () => {
  const { d, transport, advance, lost } = await beating();
  transport.onState("p1", "failed");
  assert.equal(lost(), 1);
  transport.onState("p1", "open");
  transport.onMessage("p1", BEAT);
  advance(SILENT_MS);
  d.tick();
  assert.equal(lost(), 2);
  transport.onMessage("p1", BEAT);
  d.leave("p1");
  assert.equal(lost(), 2);
});
