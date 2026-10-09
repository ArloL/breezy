import { test } from "node:test";
import assert from "node:assert/strict";
import { Live, initials, colourOf, PALETTE } from "../sync/live.js";
import { SpaceKeys, randomBytes } from "../sync/crypto.js";
import { encode, decode } from "../sync/base64.js";
import { FakeRelay, Clock } from "./helpers/fake-relay.js";
import { FakeTransport } from "./helpers/fake-transport.js";

const SPACE = "QEFCQ0RFRkdISUpLTE1OTw";
const keys = await SpaceKeys.create(decode(SPACE), decode("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"));
const device = () => encode(randomBytes(16));
const moved = { c1: { pos: [48, 0] } };

function live(relay, clock, { name = "Ana", dev = device(), k = keys } = {}) {
  return new Live({ relay: "wss://relay.example/", space: SPACE, keys: k, me: { device: dev, name }, socket: () => relay.connect(), now: clock.now, clock: clock.now, schedule: clock.schedule });
}

/** Two connected devices, both showing board B1. */
async function two() {
  const relay = new FakeRelay(), clock = new Clock();
  const a = live(relay, clock, { name: "Ana Lima" }), b = live(relay, clock, { name: "Bo" });
  a.connect();
  await relay.run();
  b.connect();
  await relay.run();
  a.setPresence({ board: "B1", selection: [] });
  b.setPresence({ board: "B1", selection: [] });
  await relay.run();
  return { relay, clock, a, b };
}

test("people see each other and what they have selected", async () => {
  const { relay, a, b } = await two();
  assert.ok(a.connected && b.connected);
  a.setPresence({ board: "B1", selection: ["c1"] });
  await relay.run();
  assert.deepEqual(b.people("B1").map((p) => p.name), ["Ana Lima"]);
  assert.equal(initials(b.people("B1")[0].name), "AL");
  assert.equal(b.people("B1")[0].colour, colourOf(a.me.device));
  assert.equal(b.selections("B1").get("c1").name, "Ana Lima");
  assert.deepEqual(a.people("B1").map((p) => p.name), ["Bo"]);
  assert.deepEqual(a.people("B2"), []);
  assert.equal(initials(" "), "?");
  assert.ok(PALETTE.includes(colourOf(device())));
});

test("cursors go at most twenty times a second", async () => {
  const { relay, clock, a, b } = await two();
  const before = relay.frames.length;
  a.sendCursor("B1", 1, 1);
  a.sendCursor("B1", 2, 2);
  a.sendCursor("B1", 3, 3);
  await relay.run();
  assert.equal(relay.frames.length, before + 1);
  assert.deepEqual(b.cursors("B1").map((c) => c.x), [1]);
  clock.advance(50);
  await relay.run();
  assert.equal(relay.frames.length, before + 2);
  clock.advance(200);
  assert.deepEqual(b.cursors("B1").map((c) => c.x), [3]);
  a.sendCursor("B1", null, null);
  clock.advance(50);
  await relay.run();
  assert.deepEqual(b.cursors("B1"), []);
});

test("a still cursor fades after a minute", async () => {
  const { relay, clock, a, b } = await two();
  a.sendCursor("B1", 1, 1);
  await relay.run();
  for (let i = 0; i < 2; i++) {
    clock.advance(29_000);
    a.tick();
    await relay.run();
  }
  b.tick();
  assert.equal(b.cursors("B1").length, 1);
  clock.advance(3000);
  b.tick();
  assert.deepEqual(b.cursors("B1"), []);
  assert.equal(b.people("B1").length, 1);
});

test("holds are all or none and show who holds", async () => {
  const { relay, a, b } = await two();
  let refused = null;
  b.onRefused = (ids) => (refused = ids);
  a.hold(["x", "y"]);
  await relay.run();
  assert.deepEqual([...b.taken()].sort(), ["x", "y"]);
  assert.equal(b.holderOf("x").name, "Ana Lima");
  assert.equal(a.taken().size, 0);
  b.hold(["y", "z"]);
  await relay.run();
  assert.deepEqual([...refused], ["y"]);
  b.release();
  a.release();
  await relay.run();
  assert.equal(b.taken().size, 0);
  assert.equal(a.mine.size, 0);
});

test("live edits show as an overlay", async () => {
  const { relay, a, b } = await two();
  a.hold(["c1"]);
  a.sendLive("B1", moved, { id: "c1", back: false, at: 3 });
  await relay.run();
  assert.deepEqual(Object.fromEntries(b.overlay("B1")), moved);
  assert.equal(b.overlay("B2").size, 0);
  assert.deepEqual(b.carets("B1").map(({ id, back, at }) => ({ id, back, at })), [{ id: "c1", back: false, at: 3 }]);
});

test("the overlay stays until the pull reaches the pushed version", async () => {
  const { relay, a, b } = await two();
  const pushes = [];
  b.onPushed = (v) => pushes.push(v);
  a.hold(["c1"]);
  a.sendLive("B1", moved, null);
  await relay.run();
  a.sendPushed({ version: 7 });
  a.release();
  await relay.run();
  assert.deepEqual(pushes, [7]);
  assert.deepEqual(Object.fromEntries(b.overlay("B1")), moved);
  b.noteCursor(6);
  assert.equal(b.overlay("B1").size, 1);
  b.noteCursor(7);
  assert.equal(b.overlay("B1").size, 0);
});

test("a hold that ends without a push drops the overlay", async () => {
  const { relay, a, b } = await two();
  a.hold(["c1"]);
  a.sendLive("B1", moved, { id: "c1", back: false, at: 0 });
  await relay.run();
  relay.lapse(relay.sockets[0]);
  await relay.run();
  assert.equal(b.taken().size, 0);
  assert.equal(b.overlay("B1").size, 0);
  assert.deepEqual(b.carets("B1"), []);
});

test("another connection of the same device still holds", async () => {
  const relay = new FakeRelay(), clock = new Clock();
  const dev = device();
  const a = live(relay, clock, { dev }), a2 = live(relay, clock, { dev });
  a.connect();
  a2.connect();
  await relay.run();
  a.setPresence({ board: "B1", selection: [] });
  a.hold(["c1"]);
  await relay.run();
  assert.deepEqual([...a2.taken()], ["c1"]);
  assert.deepEqual(a2.people("B1"), []);
});

test("a peer that leaves or falls silent is gone", async () => {
  const { relay, clock, a, b } = await two();
  a.hold(["c1"]);
  await relay.run();
  a.close();
  await relay.run();
  assert.deepEqual(b.people("B1"), []);
  assert.equal(b.taken().size, 0);
  const c = live(relay, clock, { name: "Cy" });
  c.connect();
  await relay.run();
  c.setPresence({ board: "B1", selection: [] });
  await relay.run();
  assert.deepEqual(b.people("B1").map((p) => p.name), ["Cy"]);
  clock.advance(31_000);
  b.tick();
  assert.deepEqual(b.people("B1"), []);
});

test("presence repeats and a holder keeps sending live", async () => {
  const { relay, clock, a } = await two();
  const me = relay.sockets[0].id;
  const bodies = () => relay.frames.filter((f) => f.from === me && f.text.includes('"body"')).length;
  a.hold(["c1"]);
  a.sendLive("B1", moved, null);
  await relay.run();
  const start = bodies();
  clock.advance(5000);
  a.tick();
  await relay.run();
  assert.equal(bodies(), start + 1);
  clock.advance(10_000);
  a.tick();
  await relay.run();
  assert.equal(bodies(), start + 3);
  a.release();
  clock.advance(5000);
  a.tick();
  await relay.run();
  assert.equal(bodies(), start + 3);
});

test("a reconnect asks for its holds again", async () => {
  const { relay, clock, a, b } = await two();
  let refused = null;
  a.onRefused = (ids) => (refused = ids);
  a.hold(["c1"]);
  await relay.run();
  relay.kick(relay.sockets[0], 1006);
  await relay.run();
  assert.ok(!a.connected);
  assert.equal(b.taken().size, 0);
  assert.deepEqual([...a.mine], ["c1"]);
  b.hold(["c1"]);
  await relay.run();
  clock.advance(1000);
  await relay.run();
  assert.ok(a.connected);
  assert.deepEqual([...refused], ["c1"]);
});

test("reconnects back off and stop for a wrong token", async () => {
  const relay = new FakeRelay(), clock = new Clock();
  const a = live(relay, clock);
  a.connect();
  await relay.run();
  relay.kick(relay.sockets[0], 1006);
  await relay.run();
  clock.advance(1000);
  relay.kick(relay.sockets[0], 1006);
  await relay.run();
  clock.advance(1900);
  await relay.run();
  assert.equal(relay.sockets.length, 0);
  clock.advance(100);
  await relay.run();
  assert.ok(a.connected);

  const wrong = new FakeRelay();
  wrong.token = "someone else's";
  let unauthorized = false;
  const b = live(wrong, clock);
  b.onUnauthorized = () => (unauthorized = true);
  b.connect();
  await wrong.run();
  clock.advance(60_000);
  await wrong.run();
  assert.ok(unauthorized && !b.connected);
  assert.equal(wrong.sockets.length, 0);
});

test("bodies sealed for another space are dropped", async () => {
  const relay = new FakeRelay(), clock = new Clock();
  // the same secret, so the same token and key, but another space: its bodies do not open here
  const stranger = live(relay, clock, { k: await SpaceKeys.create(randomBytes(16), decode("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")) });
  const b = live(relay, clock);
  stranger.connect();
  b.connect();
  await relay.run();
  stranger.setPresence({ board: "B1", selection: [] });
  await relay.run();
  assert.ok(stranger.connected && b.connected);
  assert.deepEqual(b.people("B1"), []);
});

test("a holder with nothing live yet still keeps its hold", async () => {
  const { relay, clock, a } = await two();
  const me = relay.sockets[0].id;
  const bodies = () => relay.frames.filter((f) => f.from === me && f.text.includes('"body"')).length;
  a.hold(["c1"]);
  await relay.run();
  const start = bodies();
  clock.advance(5000);
  a.tick();
  await relay.run();
  assert.equal(bodies(), start + 1);
  a.release();
  clock.advance(5000);
  a.tick();
  await relay.run();
  assert.equal(bodies(), start + 1);
});

test("the relay gets a token made for it", async () => {
  const { relay } = await two();
  assert.equal(relay.token, encode(keys.relayToken));
});

test("connecting again waits for the back-off", async () => {
  const relay = new FakeRelay(), clock = new Clock();
  const a = live(relay, clock);
  a.connect();
  await relay.run();
  relay.kick(relay.sockets[0], 1006);
  await relay.run();
  for (let i = 0; i < 3; i++) {
    a.connect();
    await relay.run();
  }
  clock.advance(900);
  a.connect();
  await relay.run();
  assert.equal(relay.opened, 1);
  clock.advance(100);
  await relay.run();
  assert.ok(relay.opened === 2 && a.connected);
});

test("a refused token keeps the layer closed", async () => {
  const relay = new FakeRelay(), clock = new Clock();
  relay.token = "someone else's";
  const a = live(relay, clock);
  a.connect();
  await relay.run();
  for (let i = 0; i < 3; i++) {
    a.close();
    a.connect();
    clock.advance(60_000);
    await relay.run();
  }
  assert.ok(relay.opened === 1 && !a.connected);
});

test("a socket that stops answering is closed and opened again", async () => {
  const { relay, clock, a } = await two();
  const first = relay.sockets[0];
  clock.advance(20_000);
  a.tick();
  await relay.run();
  assert.equal(relay.pings, 1);
  clock.advance(10_000);
  a.tick();
  assert.ok(a.connected);
  clock.advance(10_000);
  a.tick();
  await relay.run();
  assert.equal(relay.pings, 2);
  first.halfOpen = true;
  clock.advance(20_000);
  a.tick();
  await relay.run();
  clock.advance(9000);
  a.tick();
  assert.ok(a.connected);
  clock.advance(1000);
  a.tick();
  assert.ok(!a.connected);
  await relay.run();
  assert.ok(!relay.sockets.includes(first));
  clock.advance(1000);
  await relay.run();
  assert.ok(a.connected && relay.opened === 3);
});

test("a closed layer holds nothing", async () => {
  const { relay, clock, a, b } = await two();
  a.hold(["c1"]);
  a.sendLive("B1", moved, null);
  await relay.run();
  a.close();
  await relay.run();
  assert.equal(a.mine.size, 0);
  a.connect();
  await relay.run();
  clock.advance(5000);
  a.tick();
  await relay.run();
  assert.ok(a.connected);
  assert.equal(b.taken().size, 0);
  assert.equal(b.overlay("B1").size, 0);
});

test("what this device holds is not overlaid", async () => {
  const { relay, a, b } = await two();
  a.hold(["c1"]);
  a.sendLive("B1", moved, null);
  await relay.run();
  a.sendPushed({ version: 7 });
  a.release();
  await relay.run();
  assert.deepEqual(Object.fromEntries(b.overlay("B1")), moved);
  b.hold(["c1"]);
  await relay.run();
  assert.equal(b.overlay("B1").size, 0);
});

test("cursors and live fields go only when someone is there", async () => {
  const relay = new FakeRelay(), clock = new Clock();
  const a = live(relay, clock);
  a.connect();
  await relay.run();
  a.setPresence({ board: "B1", selection: [] });
  await relay.run();
  const me = relay.sockets[0].id;
  const bodies = () => relay.frames.filter((f) => f.from === me && f.text.includes('"body"')).length;
  const start = bodies();
  a.sendCursor("B1", 1, 1);
  a.hold(["c1"]);
  a.sendLive("B1", moved, null);
  clock.advance(1000);
  await relay.run();
  assert.equal(bodies(), start);
  const b = live(relay, clock, { name: "Bo" });
  b.connect();
  await relay.run();
  assert.deepEqual(b.cursors("B1").map((c) => c.x), [1]);
  clock.advance(5000);
  a.tick();
  await relay.run();
  assert.deepEqual(Object.fromEntries(b.overlay("B1")), moved);
});

const opened = async (text) => JSON.parse(new TextDecoder().decode(await keys.openLive(decode(JSON.parse(text).body))));

test("cursors and live edits carry the sender's time and a sequence number", async () => {
  const { relay, clock, a } = await two();
  a.sendCursor("B1", 1, 1);
  await relay.run();
  clock.advance(50);
  a.hold(["c1"]);
  a.sendLive("B1", moved, null);
  await relay.run();
  const bodies = await Promise.all(relay.frames.filter((f) => f.text.includes('"body"')).slice(-2).map((f) => opened(f.text)));
  assert.deepEqual(bodies.map((b) => [b.t, b.seq]), [["cursor", 1], ["live", 2]]);
  assert.equal(bodies[1].at - bodies[0].at, 50);
});

test("cursors play back smoothly between updates", async () => {
  const { relay, clock, a, b } = await two();
  for (const x of [0, 10, 20]) {
    a.sendCursor("B1", x, 0);
    await relay.run();
    clock.advance(50);
  }
  // the buffer is one 50 ms interval: 50 ms after the last arrived, playback is halfway between the last two
  clock.advance(-25);
  assert.deepEqual(b.cursors("B1").map((c) => c.x), [15]);
  assert.ok(b.animating("B1"));
  assert.ok(!b.animating("B2"));
  clock.advance(100);
  assert.deepEqual(b.cursors("B1").map((c) => c.x), [20]);
  assert.ok(!b.animating("B1"));
});

test("a cursor on another board jumps there", async () => {
  const { relay, clock, a, b } = await two();
  for (const x of [0, 10]) {
    a.sendCursor("B1", x, 0);
    await relay.run();
    clock.advance(50);
  }
  a.sendCursor("B2", 500, 500);
  await relay.run();
  assert.deepEqual(b.cursors("B2").map((c) => [c.x, c.y]), [[500, 500]]);
});

test("dragged positions play back; text shows on arrival", async () => {
  const { relay, clock, a, b } = await two();
  a.hold(["c1"]);
  for (const [x, text] of [[0, "a"], [10, "ab"], [20, "abc"]]) {
    a.sendLive("B1", { c1: { pos: [x, 0], text } }, null);
    await relay.run();
    clock.advance(50);
  }
  clock.advance(-25);
  assert.deepEqual(b.overlay("B1").get("c1"), { pos: [15, 0], text: "abc" });
});

test("coordinates far out are clamped, so that playing back between them stays finite", async () => {
  const { relay, clock, a, b } = await two();
  a.hold(["c1"]);
  a.sendCursor("B1", 1e308, 0);
  a.sendLive("B1", { c1: { pos: [1e308, -1e308] } }, null);
  await relay.run();
  assert.deepEqual(b.cursors("B1").map((c) => c.x), [1e7]);
  assert.deepEqual(b.overlay("B1").get("c1").pos, [1e7, -1e7]);
  clock.advance(50);
  a.sendCursor("B1", -1e308, 0);
  a.sendLive("B1", { c1: { pos: [-1e308, 1e308] } }, null);
  await relay.run();
  clock.advance(25);
  assert.deepEqual(b.cursors("B1").map((c) => c.x), [0]);
  assert.deepEqual(b.overlay("B1").get("c1").pos, [0, 0]);
});

test("duplicates and late bodies are dropped; bodies without seq or at are taken", async () => {
  const { relay, clock, a, b } = await two();
  a.sendCursor("B1", 5, 5);
  await relay.run();
  const late = relay.frames.at(-1);
  clock.advance(200);
  a.sendCursor("B1", 9, 9);
  await relay.run();
  // the first cursor again, as an unordered channel may deliver it late
  relay.received(relay.sockets.find((s) => s.id === late.from), late.text);
  await relay.run();
  clock.advance(200);
  assert.deepEqual(b.cursors("B1").map((c) => c.x), [9]);
  // as a client from before this design sends it
  await a.send({ t: "cursor", board: "B1", x: 3, y: 3 });
  await relay.run();
  clock.advance(200);
  assert.deepEqual(b.cursors("B1").map((c) => c.x), [3]);
});

test("numbers a peer sends that cannot be played back or read exactly are ignored", async () => {
  const { relay, clock, a, b } = await two();
  const pushes = [];
  b.onPushed = (v) => pushes.push(v);
  a.hold(["c1", "c2"]);
  await relay.run();
  await a.send({ t: "live", board: "B1", items: { c1: { w: 100, pos: [0, 0] }, c2: { w: [] } }, caret: { id: "c1", back: false, at: 1e300 } });
  await relay.run();
  clock.advance(50);
  await a.send({ t: "live", board: "B1", items: { c1: { w: [], pos: [10, 0, 5] } }, caret: null });
  await relay.run();
  clock.advance(200);
  assert.deepEqual(Object.fromEntries(b.overlay("B1")), { c1: { w: 100, pos: [0, 0] }, c2: { w: [] } });
  assert.deepEqual(b.carets("B1"), []);
  await a.send({ t: "live", board: "B1", items: {}, caret: { id: "c1", back: false, at: 1e300 } });
  await relay.run();
  assert.deepEqual(b.carets("B1"), []);
  await a.send({ t: "pushed", version: 1e300 });
  await relay.run();
  assert.deepEqual(pushes, []);
  // a seq too big to read exactly is no seq at all, so later bodies still arrive
  await a.send({ t: "cursor", board: "B1", x: 1, y: 1, seq: 1e300 });
  await relay.run();
  clock.advance(50);
  a.sendCursor("B1", 2, 2);
  await relay.run();
  clock.advance(200);
  assert.deepEqual(b.cursors("B1").map((c) => c.x), [2]);
});

/** `n` devices with fake transports, all on board B1, the last one the newcomer. */
async function direct(n = 2) {
  const relay = new FakeRelay(), clock = new Clock();
  const ts = [], ls = [];
  for (let i = 0; i < n; i++) {
    const t = new FakeTransport();
    const l = new Live({ relay: "wss://relay.example/", space: SPACE, keys, me: { device: device(), name: `P${i}` }, socket: () => relay.connect(), now: clock.now, clock: clock.now, schedule: clock.schedule, peerTransport: () => t });
    l.connect();
    await relay.run();
    l.setPresence({ board: "B1", selection: [] });
    await relay.run();
    ts.push(t);
    ls.push(l);
  }
  /** Opens the channel between devices i and j, both ways. */
  const open = (i, j) => {
    ts[i].onState(ls[j].id, "open");
    ts[j].onState(ls[i].id, "open");
  };
  const bodyFrames = () => relay.frames.filter((f) => f.text.includes('"body"') && !f.text.includes('"to"')).length;
  return { relay, clock, ts, ls, open, bodyFrames };
}

test("the newcomer offers through the relay and the others answer", async () => {
  const { ts, ls } = await direct();
  assert.deepEqual(ts[1].log.slice(0, 2), [`create ${ls[0].id}`, `offer ${ls[0].id}`]);
  assert.deepEqual(ts[0].log.slice(0, 2), [`create ${ls[1].id}`, `answer ${ls[1].id} offer-sdp ${ls[0].id}`]);
  assert.ok(ts[1].log.includes(`accept ${ls[0].id} answer-sdp ${ls[1].id}`));
});

test("with every channel open, cursors go only direct and every frame", async () => {
  const { relay, clock, ts, ls, open, bodyFrames } = await direct();
  open(0, 1);
  assert.equal(ls[0].sendMs, 8);
  const before = bodyFrames();
  ls[0].sendCursor("B1", 1, 1);
  await relay.run();
  clock.advance(8);
  ls[0].sendCursor("B1", 2, 2);
  await relay.run();
  assert.equal(bodyFrames(), before);
  assert.equal(ts[0].sent.length, 2);
  for (const { data } of ts[0].sent) ts[1].onMessage(ls[0].id, data);
  await relay.run();
  clock.advance(200);
  assert.deepEqual(ls[1].cursors("B1").map((c) => c.x), [2]);
});

test("with a channel short, cursors go to the relay too", async () => {
  const { relay, ts, ls, open, bodyFrames } = await direct(3);
  open(0, 1);
  assert.equal(ls[0].sendMs, 50);
  const before = bodyFrames();
  ls[0].sendCursor("B1", 1, 1);
  await relay.run();
  assert.equal(bodyFrames(), before + 1);
  assert.deepEqual(ts[0].sent.map((s) => s.id), [ls[1].id]);
});

test("while holding, the heartbeat goes to the relay even with every channel open", async () => {
  const { relay, clock, ls, open, bodyFrames } = await direct();
  open(0, 1);
  ls[0].hold(["c1"]);
  ls[0].sendLive("B1", moved, null);
  await relay.run();
  const before = bodyFrames();
  clock.advance(5000);
  ls[0].tick();
  await relay.run();
  assert.equal(bodyFrames(), before + 1);
});

test("a long gesture with every channel open still reaches the relay every 5 s", async () => {
  const { relay, clock, ls, open, bodyFrames } = await direct();
  open(0, 1);
  ls[0].hold(["c1"]);
  await relay.run();
  const before = bodyFrames();
  for (let t = 0; t < 12_000; t += 8) {
    ls[0].sendLive("B1", { c1: { pos: [t, 0] } }, null);
    await relay.run();
    clock.advance(8);
    if (t % 1000 === 0) ls[0].tick();
  }
  await relay.run();
  assert.ok(bodyFrames() - before >= 2);
});

test("a live edit that comes direct before its hold is shown and keeps its track; one never held goes after a second", async () => {
  const { relay, clock, ts, ls, open } = await direct();
  open(0, 1);
  const deliver = async () => {
    await ls[0].out;
    for (const { data } of ts[0].sent.splice(0)) ts[1].onMessage(ls[0].id, data);
    await ls[1].in;
  };
  ls[0].hold(["c1"]);
  ls[0].sendLive("B1", { c1: { pos: [0, 0] } }, null);
  await deliver();
  assert.deepEqual(Object.fromEntries(ls[1].overlay("B1")), { c1: { pos: [0, 0] } });
  await relay.run();
  assert.deepEqual([...ls[1].taken()], ["c1"]);
  clock.advance(50);
  ls[0].sendLive("B1", { c1: { pos: [10, 0] } }, null);
  await deliver();
  clock.advance(25);
  assert.deepEqual(ls[1].overlay("B1").get("c1"), { pos: [5, 0] });

  ls[0].sendLive("B1", { c2: { pos: [1, 1] } }, null);
  await deliver();
  await relay.run();
  clock.advance(999);
  ls[1].tick();
  assert.ok(ls[1].overlay("B1").has("c2"));
  clock.advance(1);
  ls[1].tick();
  assert.deepEqual([...ls[1].overlay("B1").keys()], ["c1"]);
});

test("a connection that never speaks leaves the roster after 30 s, and the status line counts the roster", async () => {
  const { relay, clock, ls, open } = await direct();
  open(0, 1);
  const stranger = live(relay, clock, { k: await SpaceKeys.create(randomBytes(16), decode("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")) });
  stranger.connect();
  await relay.run();
  assert.ok(!ls[0].allDirect);
  assert.equal(ls[0].directStatus(), "Direct with 1 of 2 people");
  for (let i = 0; i < 29; i++) {
    clock.advance(1000);
    for (const l of [...ls, stranger]) l.tick();
    await relay.run();
  }
  assert.ok(!ls[0].allDirect);
  clock.advance(1000);
  for (const l of [...ls, stranger]) l.tick();
  await relay.run();
  assert.ok(ls[0].allDirect);
  assert.equal(ls[0].sendMs, 8);
  assert.equal(ls[0].directStatus(), "Direct with 1 of 1 person");
});

test("with every channel open, the last cursor goes once more 100 ms later, as a channel may lose it", async () => {
  const { relay, clock, ts, ls, open } = await direct();
  open(0, 1);
  const seqOf = async (bytes) => JSON.parse(new TextDecoder().decode(await keys.openLive(bytes))).seq;
  ls[0].sendCursor("B1", 1, 1);
  await relay.run();
  clock.advance(8);
  ls[0].sendCursor("B1", null, null);
  await relay.run();
  ts[1].onMessage(ls[0].id, ts[0].sent[0].data);
  clock.advance(99);
  await relay.run();
  assert.equal(ts[0].sent.length, 2);
  clock.advance(1);
  await relay.run();
  assert.equal(ts[0].sent.length, 3);
  assert.ok((await seqOf(ts[0].sent[2].data)) > (await seqOf(ts[0].sent[1].data)));
  ts[1].onMessage(ls[0].id, ts[0].sent[2].data);
  await relay.run();
  assert.deepEqual(ls[1].cursors("B1"), []);
  clock.advance(1000);
  await relay.run();
  assert.equal(ts[0].sent.length, 3);
});

test("only cursors and live edits are taken from a channel", async () => {
  const { relay, ts, ls, open } = await direct();
  open(0, 1);
  const pushes = [];
  ls[1].onPushed = (v) => pushes.push(v);
  const sealed = await keys.sealLive(new TextEncoder().encode(JSON.stringify({ t: "pushed", version: 9 })));
  ts[1].onMessage(ls[0].id, sealed);
  await relay.run();
  assert.deepEqual(pushes, []);
});

test("a peer leaving closes its connection; the status line counts open channels", async () => {
  const { relay, ts, ls, open } = await direct();
  assert.equal(ls[0].directStatus(), "Direct with 0 of 1 person");
  open(0, 1);
  assert.equal(ls[0].directStatus(), "Direct with 1 of 1 person");
  const gone = ls[1].id;
  ls[1].close();
  await relay.run();
  assert.ok(ts[0].log.includes(`close ${gone}`));
  assert.equal(ls[0].directStatus(), null);
});

test("pushed carries its records to the others, unless they would not fit a frame", async () => {
  const { relay, a, b } = await two();
  const got = [];
  b.onPushed = (v, extra) => got.push([v, extra]);
  const records = [{ id: "AAAA", version: 5, blob: "BBBB" }];
  await a.sendPushed({ version: 5, epoch: "e", records });
  await relay.run();
  await a.sendPushed({ version: 6, epoch: "e", records: [{ id: "AAAA", version: 6, blob: "x".repeat(61_000) }] });
  await relay.run();
  await a.send({ t: "pushed", version: 7, epoch: "e", records: [{ id: 1, version: 7, blob: "x" }] });
  await relay.run();
  assert.deepEqual(got, [[5, { epoch: "e", records }], [6, null], [7, null]]);
});
