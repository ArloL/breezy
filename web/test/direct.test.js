import { test } from "node:test";
import assert from "node:assert/strict";
import { Direct, OPEN_TIMEOUT_MS, RESTART_MS } from "../sync/direct.js";
import { FakeTransport } from "./helpers/fake-transport.js";

const settle = () => new Promise((r) => setImmediate(r));

function direct() {
  let t = 1_000_000;
  const transport = new FakeTransport(), relayed = [], messages = [];
  let changes = 0;
  const d = new Direct(transport, { now: () => t, relay: (to, b) => relayed.push({ to, ...b }), message: (from, text) => messages.push({ from, text }), change: () => changes++ });
  return { d, transport, relayed, messages, advance: (ms) => (t += ms), changes: () => changes };
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
  assert.deepEqual(relayed, [{ to: "p1", t: "answer", sdp: "answer-sdp p1" }]);
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
  assert.deepEqual(messages, [{ from: "p1", text: "hello" }]);
  assert.ok(d.send("p1", "x"));
  assert.ok(!d.send("p2", "x"));
  assert.deepEqual(transport.sent, [{ id: "p1", text: "x" }]);
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
  assert.deepEqual(relayed, [{ to: "p1", t: "answer", sdp: "answer-sdp p1" }]);
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
