import { test } from "node:test";
import assert from "node:assert/strict";
import { Live, initials, colourOf, PALETTE } from "../sync/live.js";
import { SpaceKeys, randomBytes } from "../sync/crypto.js";
import { encode, decode } from "../sync/base64.js";
import { LiveDecoder, LiveEncoder, isCompact } from "../sync/compact.js";
import { unpack } from "../sync/msgpack.js";
import { parseFrame } from "../../relay/src/frames.js";
import { FakeRelay, Clock } from "./helpers/fake-relay.js";
import { FakeTransport } from "./helpers/fake-transport.js";
import { OldDevice } from "./helpers/old-device.js";

const SPACE = "QEFCQ0RFRkdISUpLTE1OTw";
const keys = await SpaceKeys.create(decode(SPACE), decode("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"));
const device = () => encode(randomBytes(16));
const id = (n) => encode(new Uint8Array(16).fill(n));
const [B1, B2, C1, C2, C3] = [0xb1, 0xb2, 0xc1, 0xc2, 0xc3].map(id);
const moved = { [C1]: { pos: [48, 0] } };

/** What connection `from` sent through the relay, opened, compact bodies decoded: { to, size, body }. */
async function sentBy(relay, from) {
  const decoder = new LiveDecoder();
  const out = [];
  for (const f of relay.frames) {
    if (f.from !== from || !f.bytes) continue;
    const { to, body } = parseFrame(f.bytes);
    const plain = await keys.openLive(body);
    out.push({ to, size: f.bytes.length, body: isCompact(plain) ? decoder.decode(plain) : JSON.parse(new TextDecoder().decode(plain)) });
  }
  return out;
}
const fast = (sent) => sent.filter((s) => s.body?.t === "cursor" || s.body?.t === "live");
const alives = (relay, from) => relay.frames.filter((f) => f.from === from && f.text === '{"t":"alive"}').length;

function live(relay, clock, { name = "Ana", dev = device(), k = keys } = {}) {
  return new Live({ relay: "wss://relay.example/", space: SPACE, keys: k, me: { device: dev, name }, socket: () => relay.connect(), now: clock.now, clock: clock.now, schedule: clock.schedule });
}

/** Two connected devices, both showing board B1; through a relay from before the lean sync design when `old`. */
async function two({ old = false } = {}) {
  const clock = new Clock(), relay = new FakeRelay({ old, now: clock.now });
  const a = live(relay, clock, { name: "Ana Lima" }), b = live(relay, clock, { name: "Bo" });
  a.connect();
  await relay.run();
  b.connect();
  await relay.run();
  a.setPresence({ board: B1, selection: [] });
  b.setPresence({ board: B1, selection: [] });
  await relay.run();
  return { relay, clock, a, b };
}

test("people see each other and what they have selected", async () => {
  const { relay, a, b } = await two();
  assert.ok(a.connected && b.connected);
  a.setPresence({ board: B1, selection: [C1] });
  await relay.run();
  assert.deepEqual(b.people(B1).map((p) => p.name), ["Ana Lima"]);
  assert.equal(initials(b.people(B1)[0].name), "AL");
  assert.equal(b.people(B1)[0].colour, colourOf(a.me.device));
  assert.equal(b.selections(B1).get(C1).name, "Ana Lima");
  assert.deepEqual(a.people(B1).map((p) => p.name), ["Bo"]);
  assert.deepEqual(a.people(B2), []);
  assert.equal(initials(" "), "?");
  assert.ok(PALETTE.includes(colourOf(device())));
});

test("cursors go at most forty times a second", async () => {
  const { relay, clock, a, b } = await two();
  const sent = async () => fast(await sentBy(relay, a.id)).length;
  a.sendCursor(B1, 1, 1);
  await relay.run();
  assert.equal(await sent(), 1);
  assert.deepEqual(b.cursors(B1).map((c) => c.x), [1]);
  a.sendCursor(B1, 2, 2);
  a.sendCursor(B1, 3, 3);
  await relay.run();
  assert.equal(await sent(), 1);
  clock.advance(24);
  await relay.run();
  assert.equal(await sent(), 1);
  clock.advance(1);
  await relay.run();
  assert.equal(await sent(), 2);
  clock.advance(200);
  assert.deepEqual(b.cursors(B1).map((c) => c.x), [3]);
  a.sendCursor(B1, null, null);
  clock.advance(50);
  await relay.run();
  assert.deepEqual(b.cursors(B1), []);
});

test("a still cursor fades after a minute", async () => {
  const { relay, clock, a, b } = await two();
  a.sendCursor(B1, 1, 1);
  await relay.run();
  for (let i = 0; i < 2; i++) {
    clock.advance(29_000);
    a.tick();
    await relay.run();
  }
  b.tick();
  assert.equal(b.cursors(B1).length, 1);
  clock.advance(3000);
  b.tick();
  assert.deepEqual(b.cursors(B1), []);
  assert.equal(b.people(B1).length, 1);
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
  a.hold([C1]);
  a.sendLive(B1, moved, { id: C1, back: false, at: 3 });
  await relay.run();
  assert.deepEqual(Object.fromEntries(b.overlay(B1)), moved);
  assert.equal(b.overlay(B2).size, 0);
  assert.deepEqual(b.carets(B1).map(({ id, back, at }) => ({ id, back, at })), [{ id: C1, back: false, at: 3 }]);
});

test("the overlay stays until the pull reaches the pushed version", async () => {
  const { relay, a, b } = await two();
  const pushes = [];
  b.onPushed = (v) => pushes.push(v);
  a.hold([C1]);
  a.sendLive(B1, moved, null);
  await relay.run();
  a.sendPushed({ version: 7 });
  a.release();
  await relay.run();
  assert.deepEqual(pushes, [7]);
  assert.deepEqual(Object.fromEntries(b.overlay(B1)), moved);
  b.noteCursor(6);
  assert.equal(b.overlay(B1).size, 1);
  b.noteCursor(7);
  assert.equal(b.overlay(B1).size, 0);
});

test("an edit outside a gesture shows at once, holding nothing, until its push is in", async () => {
  const { relay, clock, a, b } = await two();
  const recoloured = { [C1]: { color: 3 } };
  a.sendEdit(B1, recoloured);
  await relay.run();
  assert.deepEqual(Object.fromEntries(b.overlay(B1)), recoloured);
  assert.equal(b.taken().size, 0);
  // the next body, of a gesture, starts on a keyframe and does not repeat the edit
  a.hold([C2]);
  a.sendLive(B1, { [C2]: { pos: [1, 2] } }, null);
  clock.advance(25);
  await relay.run();
  assert.deepEqual([...b.overlay(B1).keys()].sort(), [C1, C2].sort());
  a.release();
  a.sendPushed({ version: 7 });
  await relay.run();
  b.noteCursor(7);
  assert.equal(b.overlay(B1).size, 0);
});

test("a hold that ends without a push drops the overlay", async () => {
  const { relay, a, b } = await two();
  a.hold([C1]);
  a.sendLive(B1, moved, { id: C1, back: false, at: 0 });
  await relay.run();
  relay.lapse(relay.sockets[0]);
  await relay.run();
  assert.equal(b.taken().size, 0);
  assert.equal(b.overlay(B1).size, 0);
  assert.deepEqual(b.carets(B1), []);
});

test("another connection of the same device still holds", async () => {
  const relay = new FakeRelay(), clock = new Clock();
  const dev = device();
  const a = live(relay, clock, { dev }), a2 = live(relay, clock, { dev });
  a.connect();
  a2.connect();
  await relay.run();
  a.setPresence({ board: B1, selection: [] });
  a.hold([C1]);
  await relay.run();
  assert.deepEqual([...a2.taken()], [C1]);
  assert.deepEqual(a2.people(B1), []);
});

test("a peer that leaves or falls silent is gone", async () => {
  const { relay, clock, a, b } = await two();
  a.hold([C1]);
  await relay.run();
  a.close();
  await relay.run();
  assert.deepEqual(b.people(B1), []);
  assert.equal(b.taken().size, 0);
  const c = live(relay, clock, { name: "Cy" });
  c.connect();
  await relay.run();
  c.setPresence({ board: B1, selection: [] });
  await relay.run();
  assert.deepEqual(b.people(B1).map((p) => p.name), ["Cy"]);
  clock.advance(31_000);
  b.tick();
  assert.deepEqual(b.people(B1), []);
});

test("presence repeats and a holder tells the relay it is alive", async () => {
  const { relay, clock, a } = await two();
  const presences = async () => (await sentBy(relay, a.id)).filter((s) => s.body.t === "presence").length;
  a.hold([C1]);
  a.sendLive(B1, moved, null);
  await relay.run();
  const start = await presences();
  clock.advance(5000);
  a.tick();
  await relay.run();
  assert.equal(alives(relay, a.id), 1);
  clock.advance(10_000);
  a.tick();
  await relay.run();
  assert.equal(alives(relay, a.id), 2);
  assert.equal(await presences(), start + 1);
  a.release();
  clock.advance(5000);
  a.tick();
  await relay.run();
  assert.equal(alives(relay, a.id), 2);
});

test("a reconnect asks for its holds again", async () => {
  const { relay, clock, a, b } = await two();
  let refused = null;
  a.onRefused = (ids) => (refused = ids);
  a.hold([C1]);
  await relay.run();
  relay.kick(relay.sockets[0], 1006);
  await relay.run();
  assert.ok(!a.connected);
  assert.equal(b.taken().size, 0);
  assert.deepEqual([...a.mine], [C1]);
  b.hold([C1]);
  await relay.run();
  clock.advance(1000);
  await relay.run();
  assert.ok(a.connected);
  assert.deepEqual([...refused], [C1]);
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
  stranger.setPresence({ board: B1, selection: [] });
  await relay.run();
  assert.ok(stranger.connected && b.connected);
  assert.deepEqual(b.people(B1), []);
});

test("a holder with nothing live yet still keeps its hold", async () => {
  const { relay, clock, a } = await two();
  a.hold([C1]);
  await relay.run();
  clock.advance(5000);
  a.tick();
  await relay.run();
  assert.equal(alives(relay, a.id), 1);
  a.release();
  clock.advance(5000);
  a.tick();
  await relay.run();
  assert.equal(alives(relay, a.id), 1);
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
  clock.advance(4000);
  a.tick();
  await relay.run();
  assert.equal(relay.pings, 0);
  clock.advance(1000);
  a.tick();
  await relay.run();
  assert.ok(relay.pings === 1 && a.pingWaiting === null);
  first.halfOpen = true;
  clock.advance(5000);
  a.tick();
  await relay.run();
  assert.notEqual(a.pingWaiting, null);
  clock.advance(2900);
  assert.ok(a.connected);
  clock.advance(100);
  assert.ok(!a.connected);
  await relay.run();
  assert.ok(!relay.sockets.includes(first));
  clock.advance(1000);
  await relay.run();
  assert.ok(a.connected && relay.opened === 3);
});

test("sending after the relay was quiet a while asks it to answer", async () => {
  const { relay, clock, a } = await two();
  a.sendCursor(B1, 1, 1);
  await relay.run();
  assert.equal(a.pingWaiting, null);
  clock.advance(2000);
  relay.sockets[0].halfOpen = true;
  a.sendCursor(B1, 2, 2);
  await relay.run();
  assert.notEqual(a.pingWaiting, null);
  clock.advance(2900);
  assert.ok(a.connected);
  clock.advance(100);
  assert.ok(!a.connected);
});

test("a check opens at once, without waiting out a back-off, and makes an open socket answer", async () => {
  const relay = new FakeRelay(), clock = new Clock();
  const a = live(relay, clock);
  a.connect();
  await relay.run();
  for (let i = 0; i < 3; i++) {
    relay.kick(relay.sockets.at(-1), 1006);
    await relay.run();
    clock.advance(2 ** i * 1000);
    await relay.run();
  }
  relay.kick(relay.sockets.at(-1), 1006);
  await relay.run();
  assert.ok(!a.connected && relay.opened === 4);
  a.check();
  await relay.run();
  assert.ok(a.connected && relay.opened === 5);
  // the back-off that was waiting opens nothing more
  clock.advance(8000);
  await relay.run();
  assert.equal(relay.opened, 5);
  a.check();
  await relay.run();
  assert.equal(relay.pings, 1);
  a.close();
  a.check();
  await relay.run();
  assert.equal(relay.opened, 5);
});

test("a socket the relay never welcomes is given up on", async () => {
  const relay = new FakeRelay(), clock = new Clock();
  const a = live(relay, clock);
  relay.silent = true;
  a.connect();
  await relay.run();
  clock.advance(4900);
  a.tick();
  assert.equal(relay.opened, 1);
  relay.silent = false;
  clock.advance(100);
  a.tick();
  clock.advance(1000);
  await relay.run();
  assert.ok(a.connected && relay.opened === 2);
});

test("a connection back after its network went replaces the one it had: the others stop showing it, and its holds come back", async () => {
  const { relay, clock, a, b } = await two();
  a.hold([C1]);
  a.sendCursor(B1, 5, 5);
  await relay.run();
  const first = relay.sockets.find((s) => s.id === a.id);
  assert.equal(b.cursors(B1).length, 1);
  first.halfOpen = true;
  a.sendCursor(B1, 6, 6);
  clock.advance(2000);
  a.sendCursor(B1, 7, 7);
  await relay.run();
  clock.advance(3000);
  // at once, as the connection had worked a while
  await relay.run();
  assert.ok(a.connected && a.id !== first.id);
  a.sendCursor(B1, 8, 8);
  clock.advance(200);
  await relay.run();
  clock.advance(200);
  assert.deepEqual(b.cursors(B1).map((c) => c.x), [8]);
  assert.deepEqual([...b.taken()], [C1]);
  assert.equal(b.holderOf(C1).name, "Ana Lima");
});

test("a closed layer holds nothing", async () => {
  const { relay, clock, a, b } = await two();
  a.hold([C1]);
  a.sendLive(B1, moved, null);
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
  assert.equal(b.overlay(B1).size, 0);
});

test("what this device holds is not overlaid", async () => {
  const { relay, a, b } = await two();
  a.hold([C1]);
  a.sendLive(B1, moved, null);
  await relay.run();
  a.sendPushed({ version: 7 });
  a.release();
  await relay.run();
  assert.deepEqual(Object.fromEntries(b.overlay(B1)), moved);
  b.hold([C1]);
  await relay.run();
  assert.equal(b.overlay(B1).size, 0);
});

test("cursors and live fields go only when someone is there", async () => {
  const relay = new FakeRelay(), clock = new Clock();
  const a = live(relay, clock);
  a.connect();
  await relay.run();
  a.setPresence({ board: B1, selection: [] });
  await relay.run();
  a.sendCursor(B1, 1, 1);
  a.hold([C1]);
  a.sendLive(B1, moved, null);
  clock.advance(1000);
  await relay.run();
  assert.deepEqual(fast(await sentBy(relay, a.id)), []);
  const b = live(relay, clock, { name: "Bo" });
  b.connect();
  await relay.run();
  assert.deepEqual(b.cursors(B1).map((c) => c.x), [1]);
  b.setPresence({ board: B1, selection: [] });
  await relay.run();
  a.sendLive(B1, moved, null);
  await relay.run();
  assert.deepEqual(Object.fromEntries(b.overlay(B1)), moved);
});

test("cursors and live edits carry the sender's time and a sequence number", async () => {
  const { relay, clock, a } = await two();
  a.sendCursor(B1, 1, 1);
  await relay.run();
  clock.advance(50);
  a.hold([C1]);
  a.sendLive(B1, moved, null);
  await relay.run();
  const bodies = fast(await sentBy(relay, a.id)).map((s) => s.body);
  assert.deepEqual(bodies.map((b) => [b.t, b.seq]), [["cursor", 1], ["live", 2]]);
  assert.equal(bodies[1].at - bodies[0].at, 50);
});

test("cursors play back smoothly between updates", async () => {
  const { relay, clock, a, b } = await two();
  for (const x of [0, 10, 20]) {
    a.sendCursor(B1, x, 0);
    await relay.run();
    clock.advance(50);
  }
  // the buffer is one 50 ms interval: 50 ms after the last arrived, playback is halfway between the last two
  clock.advance(-25);
  assert.deepEqual(b.cursors(B1).map((c) => c.x), [15]);
  assert.ok(b.animating(B1));
  assert.ok(!b.animating(B2));
  clock.advance(100);
  assert.deepEqual(b.cursors(B1).map((c) => c.x), [20]);
  assert.ok(!b.animating(B1));
});

test("a cursor on another board jumps there", async () => {
  const { relay, clock, a, b } = await two();
  for (const x of [0, 10]) {
    a.sendCursor(B1, x, 0);
    await relay.run();
    clock.advance(50);
  }
  a.sendCursor(B2, 500, 500);
  await relay.run();
  assert.deepEqual(b.cursors(B2).map((c) => [c.x, c.y]), [[500, 500]]);
});

test("dragged positions play back; text shows on arrival", async () => {
  const { relay, clock, a, b } = await two();
  a.hold([C1]);
  for (const [x, text] of [[0, "a"], [10, "ab"], [20, "abc"]]) {
    a.sendLive(B1, { [C1]: { pos: [x, 0], text } }, null);
    await relay.run();
    clock.advance(50);
  }
  clock.advance(-25);
  assert.deepEqual(b.overlay(B1).get(C1), { pos: [15, 0], text: "abc" });
});

test("coordinates far out are clamped, so that playing back between them stays finite", async () => {
  const { relay, clock, a, b } = await two();
  a.hold([C1]);
  a.sendCursor(B1, 1e308, 0);
  a.sendLive(B1, { [C1]: { pos: [1e308, -1e308] } }, null);
  await relay.run();
  assert.deepEqual(b.cursors(B1).map((c) => c.x), [1e7]);
  assert.deepEqual(b.overlay(B1).get(C1).pos, [1e7, -1e7]);
  clock.advance(50);
  a.sendCursor(B1, -1e308, 0);
  a.sendLive(B1, { [C1]: { pos: [-1e308, 1e308] } }, null);
  await relay.run();
  clock.advance(25);
  assert.deepEqual(b.cursors(B1).map((c) => c.x), [0]);
  assert.deepEqual(b.overlay(B1).get(C1).pos, [0, 0]);
});

test("duplicates and late bodies are dropped; bodies without seq or at are taken", async () => {
  const { relay, clock, a, b } = await two();
  a.sendCursor(B1, 5, 5);
  await relay.run();
  const late = relay.frames.at(-1);
  clock.advance(200);
  a.sendCursor(B1, 9, 9);
  await relay.run();
  // the first cursor again, as an unordered channel may deliver it late
  relay.received(relay.sockets.find((s) => s.id === late.from), late.bytes);
  await relay.run();
  clock.advance(200);
  assert.deepEqual(b.cursors(B1).map((c) => c.x), [9]);
  // as a client from before this design sends it
  await a.send({ t: "cursor", board: B1, x: 3, y: 3 });
  await relay.run();
  clock.advance(200);
  assert.deepEqual(b.cursors(B1).map((c) => c.x), [3]);
});

test("numbers a peer sends that cannot be played back or read exactly are ignored", async () => {
  const { relay, clock, a, b } = await two();
  const pushes = [];
  b.onPushed = (v) => pushes.push(v);
  a.hold([C1, C2]);
  await relay.run();
  await a.send({ t: "live", board: B1, items: { [C1]: { w: 100, pos: [0, 0] }, [C2]: { w: [] } }, caret: { id: C1, back: false, at: 1e300 } });
  await relay.run();
  clock.advance(50);
  await a.send({ t: "live", board: B1, items: { [C1]: { w: [], pos: [10, 0, 5] } }, caret: null });
  await relay.run();
  clock.advance(200);
  assert.deepEqual(Object.fromEntries(b.overlay(B1)), { [C1]: { w: 100, pos: [0, 0] }, [C2]: { w: [] } });
  assert.deepEqual(b.carets(B1), []);
  await a.send({ t: "live", board: B1, items: {}, caret: { id: C1, back: false, at: 1e300 } });
  await relay.run();
  assert.deepEqual(b.carets(B1), []);
  await a.send({ t: "pushed", version: 1e300 });
  await relay.run();
  assert.deepEqual(pushes, []);
  // a seq too big to read exactly is no seq at all, so later bodies still arrive
  await a.send({ t: "cursor", board: B1, x: 1, y: 1, seq: 1e300, at: 0 });
  await relay.run();
  clock.advance(50);
  a.sendCursor(B1, 2, 2);
  await relay.run();
  clock.advance(200);
  assert.deepEqual(b.cursors(B1).map((c) => c.x), [2]);
});

/** `l`'s channels as an older device's: its offers and answers say no version, and it reads none in the other side's. */
function oldChannels(l) {
  const { relay, heard } = l.direct;
  l.direct.relay = (to, { v, ...b }) => relay(to, b);
  l.direct.heard = (from, { v, ...b }) => heard.call(l.direct, from, b);
}

/** `n` devices with fake transports, all on board B1, the last one the newcomer; those in `old` have older channels.
 * `oldRelay` is a relay from before the lean sync design. */
async function direct(n = 2, { old = [], oldRelay = false } = {}) {
  const clock = new Clock(), relay = new FakeRelay({ old: oldRelay, now: clock.now });
  const ts = [], ls = [];
  for (let i = 0; i < n; i++) {
    const t = new FakeTransport();
    const l = new Live({ relay: "wss://relay.example/", space: SPACE, keys, me: { device: device(), name: `P${i}` }, socket: () => relay.connect(), now: clock.now, clock: clock.now, schedule: clock.schedule, peerTransport: () => t });
    if (old.includes(i)) oldChannels(l);
    l.connect();
    await relay.run();
    l.setPresence({ board: B1, selection: [] });
    await relay.run();
    ts.push(t);
    ls.push(l);
  }
  /** Opens the channel between devices i and j, both ways. */
  const open = (i, j) => {
    ts[i].onState(ls[j].id, "open");
    ts[j].onState(ls[i].id, "open");
  };
  /** Cursors and live edits device i sent through the relay. */
  const relayed = async (i = 0) => fast(await sentBy(relay, ls[i].id));
  return { relay, clock, ts, ls, open, relayed };
}

test("the newcomer offers through the relay and the others answer", async () => {
  const { ts, ls } = await direct();
  assert.deepEqual(ts[1].log.slice(0, 2), [`create ${ls[0].id}`, `offer ${ls[0].id}`]);
  assert.deepEqual(ts[0].log.slice(0, 2), [`create ${ls[1].id}`, `answer ${ls[1].id} offer-sdp ${ls[0].id}`]);
  assert.ok(ts[1].log.includes(`accept ${ls[0].id} answer-sdp ${ls[1].id}`));
});

test("with every channel open, cursors go only direct and every frame", async () => {
  const { relay, clock, ts, ls, open, relayed } = await direct();
  open(0, 1);
  ls[0].sendCursor(B1, 1, 1);
  await relay.run();
  clock.advance(8);
  ls[0].sendCursor(B1, 2, 2);
  await relay.run();
  assert.deepEqual(await relayed(), []);
  assert.equal(ts[0].sent.length, 2);
  assert.ok(ts[0].sent.every((s) => s.data instanceof Uint8Array));
  for (const { data } of ts[0].sent) ts[1].onMessage(ls[0].id, data);
  await relay.run();
  clock.advance(200);
  assert.deepEqual(ls[1].cursors(B1).map((c) => c.x), [2]);
});

test("with a channel short, cursors go to the relay too", async () => {
  const { relay, ts, ls, open, relayed } = await direct(3);
  open(0, 1);
  ls[0].sendCursor(B1, 1, 1);
  await relay.run();
  assert.deepEqual((await relayed()).map((s) => s.to), [Number(ls[2].id)]);
  assert.deepEqual(ts[0].sent.map((s) => s.id), [ls[1].id]);
});

test("while holding, the heartbeat goes to the relay even with every channel open", async () => {
  const { relay, clock, ls, open } = await direct();
  open(0, 1);
  ls[0].hold([C1]);
  ls[0].sendLive(B1, moved, null);
  await relay.run();
  clock.advance(5000);
  ls[0].tick();
  await relay.run();
  assert.equal(alives(relay, ls[0].id), 1);
});

test("a long gesture with every channel open still reaches the relay every 5 s", async () => {
  const { relay, clock, ls, open } = await direct();
  open(0, 1);
  ls[0].hold([C1]);
  await relay.run();
  for (let t = 0; t < 12_000; t += 8) {
    ls[0].sendLive(B1, { [C1]: { pos: [t, 0] } }, null);
    await relay.run();
    clock.advance(8);
    if (t % 1000 === 0) ls[0].tick();
  }
  await relay.run();
  assert.ok(alives(relay, ls[0].id) >= 2);
});

test("a live edit that comes direct before its hold is shown and keeps its track; one never held goes after a second", async () => {
  const { relay, clock, ts, ls, open } = await direct();
  open(0, 1);
  const deliver = async () => {
    await ls[0].out;
    for (const { data } of ts[0].sent.splice(0)) ts[1].onMessage(ls[0].id, data);
    await ls[1].in;
  };
  ls[0].hold([C1]);
  ls[0].sendLive(B1, { [C1]: { pos: [0, 0] } }, null);
  await deliver();
  assert.deepEqual(Object.fromEntries(ls[1].overlay(B1)), { [C1]: { pos: [0, 0] } });
  await relay.run();
  assert.deepEqual([...ls[1].taken()], [C1]);
  clock.advance(50);
  ls[0].sendLive(B1, { [C1]: { pos: [10, 0] } }, null);
  await deliver();
  clock.advance(25);
  assert.deepEqual(ls[1].overlay(B1).get(C1), { pos: [5, 0] });

  ls[0].sendLive(B1, { [C2]: { pos: [1, 1] } }, null);
  await deliver();
  await relay.run();
  clock.advance(999);
  ls[1].tick();
  assert.ok(ls[1].overlay(B1).has(C2));
  clock.advance(1);
  ls[1].tick();
  assert.deepEqual([...ls[1].overlay(B1).keys()], [C1]);
});

test("a connection that never speaks leaves the roster after 30 s, and the status line counts the roster", async () => {
  const { relay, clock, ls, open } = await direct();
  open(0, 1);
  const stranger = live(relay, clock, { k: await SpaceKeys.create(randomBytes(16), decode("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")) });
  stranger.connect();
  await relay.run();
  assert.equal(ls[0].directStatus(), "Direct with 1 of 2 people");
  for (let i = 0; i < 29; i++) {
    clock.advance(1000);
    for (const l of [...ls, stranger]) l.tick();
    await relay.run();
  }
  assert.equal(ls[0].directStatus(), "Direct with 1 of 2 people");
  clock.advance(1000);
  for (const l of [...ls, stranger]) l.tick();
  await relay.run();
  assert.equal(ls[0].directStatus(), "Direct with 1 of 1 person");
});

test("with every channel open, the last cursor goes once more 100 ms later, as a channel may lose it", async () => {
  const { relay, clock, ts, ls, open } = await direct();
  open(0, 1);
  const seqOf = (bytes) => unpack(bytes)[1];
  ls[0].sendCursor(B1, 1, 1);
  await relay.run();
  clock.advance(8);
  ls[0].sendCursor(B1, null, null);
  await relay.run();
  ts[1].onMessage(ls[0].id, ts[0].sent[0].data);
  clock.advance(99);
  await relay.run();
  assert.equal(ts[0].sent.length, 2);
  clock.advance(1);
  await relay.run();
  assert.equal(ts[0].sent.length, 3);
  assert.ok(seqOf(ts[0].sent[2].data) > seqOf(ts[0].sent[1].data));
  ts[1].onMessage(ls[0].id, ts[0].sent[2].data);
  await relay.run();
  assert.deepEqual(ls[1].cursors(B1), []);
  clock.advance(1000);
  await relay.run();
  assert.equal(ts[0].sent.length, 3);
});

test("only cursors and live edits are taken from a channel, and only compact ones from a version 2 channel", async () => {
  const sealed = (b) => keys.sealLive(new TextEncoder().encode(JSON.stringify(b)), new Uint8Array(12));
  const old = await direct(2, { old: [1] });
  old.open(0, 1);
  const pushes = [];
  old.ls[1].onPushed = (v) => pushes.push(v);
  old.ts[1].onMessage(old.ls[0].id, encode(await sealed({ t: "pushed", version: 9 })));
  await old.relay.run();
  assert.deepEqual(pushes, []);
  const now = await direct();
  now.open(0, 1);
  const cursor = { t: "cursor", board: B1, x: 1, y: 1 };
  now.ts[1].onMessage(now.ls[0].id, new TextEncoder().encode(JSON.stringify(cursor)));
  now.ts[1].onMessage(now.ls[0].id, await sealed(cursor));
  await now.relay.run();
  assert.deepEqual(now.ls[1].cursors(B1), []);
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

test("presence says the version and boards, without a colour; people still have theirs", async () => {
  const { relay, a, b } = await two();
  const presence = (await sentBy(relay, a.id)).filter((s) => s.body.t === "presence").at(-1).body;
  assert.ok(!("colour" in presence));
  assert.equal(presence.v, 2);
  assert.deepEqual(presence.boards, [B1]);
  assert.equal(b.people(B1)[0].colour, colourOf(a.me.device));
});

test("an older device gets JSON cursors and live edits and sees them; a current one gets compact; both see the same", async () => {
  const { relay, clock, ts, ls, open } = await direct();
  open(0, 1);
  const old = new OldDevice(relay, keys, { name: "Olga", device: device() });
  old.connect();
  await relay.run();
  await old.presence(B1);
  await relay.run();
  ls[0].hold([C1]);
  ls[0].sendCursor(B1, 10.5, 20.25);
  await relay.run();
  clock.advance(50);
  ls[0].sendCursor(B1, 11.5, 21.25);
  ls[0].sendLive(B1, { [C1]: { pos: [30.5, 40.75] } }, null);
  await relay.run();
  assert.ok(ts[0].sent.every((s) => s.data instanceof Uint8Array && isCompact(s.data)));
  for (const { data } of ts[0].sent.splice(0)) ts[1].onMessage(ls[0].id, data);
  await relay.run();
  clock.advance(200);
  assert.equal(old.unreadable, 0);
  assert.ok(!("colour" in old.last("presence")));
  assert.deepEqual([old.last("cursor").x, old.last("cursor").y], [11.5, 21.25]);
  assert.deepEqual(old.last("live").items, { [C1]: { pos: [30.5, 40.75] } });
  assert.deepEqual(ls[1].cursors(B1).map((c) => [c.x, c.y]), [[11.5, 21.25]]);
  assert.deepEqual(ls[1].overlay(B1).get(C1), { pos: [30.5, 40.75] });

  await old.send({ t: "cursor", board: B1, x: 7, y: 8, seq: 1, at: 1 });
  await relay.run();
  assert.deepEqual(ls[0].cursors(B1).map((c) => [c.x, c.y]), [[7, 8]]);
  assert.equal(ls[0].people(B1).find((p) => p.name === "Olga").colour, colourOf(old.device));
});

test("JSON bodies carry coordinates to 0.01 and times to 0.1 ms", async () => {
  const { relay, clock, ls: [a] } = await direct(1);
  const old = new OldDevice(relay, keys, { device: device() });
  old.connect();
  await relay.run();
  await old.presence(B1);
  await relay.run();
  clock.advance(1.23456);
  a.hold([C1]);
  a.sendCursor(B1, 1.23456, 2.34567);
  a.sendLive(B1, { [C1]: { pos: [3.45678, 4.56789], w: 5.67891 } }, null);
  await relay.run();
  const cursor = old.last("cursor"), body = old.last("live");
  assert.deepEqual([cursor.x, cursor.y], [1.23, 2.35]);
  assert.deepEqual(body.items[C1], { pos: [3.46, 4.57], w: 5.68 });
  assert.equal(cursor.at, Math.round((clock.now() - a.started) * 10) / 10);
});

test("a channel to an older device carries sealed JSON text both ways", async () => {
  const { relay, clock, ts, ls, open } = await direct(2, { old: [1] });
  open(0, 1);
  assert.equal(ls[0].direct.version(ls[1].id), 1);
  ls[0].sendCursor(B1, 1, 2);
  ls[1].sendCursor(B1, 3, 4);
  await relay.run();
  assert.ok(ts[0].sent.length && ts[1].sent.length);
  assert.ok([...ts[0].sent, ...ts[1].sent].every((s) => typeof s.data === "string"));
  for (const { data } of ts[0].sent) ts[1].onMessage(ls[0].id, data);
  for (const { data } of ts[1].sent) ts[0].onMessage(ls[1].id, data);
  await relay.run();
  clock.advance(200);
  assert.deepEqual(ls[1].cursors(B1).map((c) => [c.x, c.y]), [[1, 2]]);
  assert.deepEqual(ls[0].cursors(B1).map((c) => [c.x, c.y]), [[3, 4]]);
});

test("relay frames are binary, and a compact cursor is at most 60 B from the relay and 24 B on a channel", async () => {
  const { relay, clock, a } = await two();
  for (const x of [1, 2]) {
    a.sendCursor(B1, x, x);
    await relay.run();
    clock.advance(50);
  }
  assert.ok(relay.frames.filter((f) => f.from === a.id && f.text).every((f) => !f.text.includes('"body"')));
  const cursors = fast(await sentBy(relay, a.id));
  assert.equal(cursors.length, 2);
  assert.ok(cursors[1].size <= 60, `${cursors[1].size} B`);

  const d = await direct();
  d.open(0, 1);
  for (const x of [1, 2]) {
    d.ls[0].sendCursor(B1, x, x);
    await d.relay.run();
    d.clock.advance(8);
  }
  assert.ok(d.ts[0].sent[1].data.length <= 24, `${d.ts[0].sent[1].data.length} B`);
});

test("with one peer on a channel and one on the relay, the channel gets a body every 8 ms and the relay every 25 ms", async () => {
  const { relay, clock, ts, ls, open, relayed } = await direct(3);
  open(0, 1);
  for (let t = 0; t < 100; t += 8) {
    ls[0].sendCursor(B1, t, 0);
    await relay.run();
    clock.advance(8);
  }
  await relay.run();
  assert.equal(ts[0].sent.filter((s) => s.id === ls[1].id).length, 13);
  assert.deepEqual((await relayed()).map((s) => s.to), [2, 2, 2, 2, 2].map(() => Number(ls[2].id)));
});

test("cursors go to those on their board; the first on another board goes to everyone, and one showing both gets both", async () => {
  const { relay, clock, ts, ls, open, relayed } = await direct(4);
  for (const j of [1, 2, 3]) open(0, j);
  ls[2].setPresence({ board: B2, selection: [] });
  ls[3].setPresence({ board: B1, boards: [B1, B2], selection: [] });
  await relay.run();
  const all = [1, 2, 3];
  for (const [board, to] of [[B1, all], [B1, [1, 3]], [B2, all], [B2, [2, 3]]]) {
    ls[0].sendCursor(board, 1, 1);
    await relay.run();
    clock.advance(8);
    assert.deepEqual(ts[0].sent.splice(0).map((s) => s.id).sort(), to.map((i) => ls[i].id).sort());
  }
  assert.deepEqual(await relayed(), []);
});

test("through the relay, nobody on the board gets nothing, one gets a frame with to, more get a broadcast", async () => {
  const { relay, clock, a, b } = await two();
  b.setPresence({ board: B2, selection: [] });
  await relay.run();
  a.sendCursor(B1, 1, 1);
  await relay.run();
  clock.advance(50);
  a.sendCursor(B1, 2, 2);
  a.hold([C1]);
  a.sendLive(B1, moved, null);
  await relay.run();
  clock.advance(50);
  // the first cursor on B1 tells everyone this device's cursor left where it was
  assert.deepEqual((await sentBy(relay, a.id)).filter((s) => s.body.t !== "presence").map((s) => s.to), [Number(b.id)]);
  b.setPresence({ board: B1, selection: [] });
  const c = live(relay, clock, { name: "Cy" });
  c.connect();
  await relay.run();
  c.setPresence({ board: B1, selection: [] });
  await relay.run();
  a.sendCursor(B1, 3, 3);
  await relay.run();
  assert.equal(fast(await sentBy(relay, a.id)).at(-1).to, null);
  c.setPresence({ board: B2, selection: [] });
  await relay.run();
  clock.advance(50);
  a.sendCursor(B1, 5, 5);
  await relay.run();
  assert.equal(fast(await sentBy(relay, a.id)).at(-1).to, Number(b.id));
});

test("during a gesture over a channel, one body a frame carries the live edit and the cursor, and the cursor follows", async () => {
  const { relay, clock, ts, ls, open } = await direct();
  open(0, 1);
  const deliver = async () => {
    const sent = ts[0].sent.splice(0);
    for (const { data } of sent) ts[1].onMessage(ls[0].id, data);
    await relay.run();
    return sent;
  };
  ls[0].hold([C1]);
  ls[0].sendCursor(B1, 100, 50);
  await relay.run();
  await deliver();
  for (let i = 1; i <= 5; i++) {
    clock.advance(8);
    ls[0].sendCursor(B1, 100 + i * 10, 50);
    ls[0].sendLive(B1, { [C1]: { pos: [i * 10, 0] } }, null, { [C1]: [0, 0] });
    await relay.run();
    const sent = await deliver();
    assert.equal(sent.length, 1);
    const v = unpack(sent[0].data);
    assert.equal(v[0], 2);
    assert.deepEqual(v[7], [100 + i * 10, 50]);
  }
  clock.advance(200);
  assert.deepEqual(ls[1].cursors(B1).map((c) => [c.x, c.y]), [[150, 50]]);
  assert.deepEqual(ls[1].overlay(B1).get(C1), { pos: [50, 0] });
  // the folded cursors left the cursor stream as it was: the next cursor body is no keyframe
  ls[0].release();
  ls[0].sendCursor(B1, 1, 1);
  await relay.run();
  assert.ok(ts[0].sent.at(-1).data.length <= 24, `${ts[0].sent.at(-1).data.length} B`);
});

test("dragging a card on the grid, as the apps call it, sends one body a move: its offset when it reaches a grid line, else the cursor alone", async () => {
  const { relay, clock, ts, ls, open } = await direct();
  open(0, 1);
  const deliver = async () => {
    const sent = ts[0].sent.splice(0);
    for (const { data } of sent) ts[1].onMessage(ls[0].id, data);
    await relay.run();
    return sent;
  };
  ls[0].hold([C1]);
  ls[0].sendCursor(B1, 100, 50);
  await relay.run();
  await deliver();
  const snap = (v) => Math.round(v / 24) * 24;
  const kinds = [];
  for (let i = 1; i <= 6; i++) {
    clock.advance(30);
    // the pointer event, then the edit it makes, in one turn
    ls[0].sendCursor(B1, 100 + i * 13, 50);
    ls[0].sendLive(B1, { [C1]: { pos: [snap(i * 13), 0] } }, null, { [C1]: [0, 0] });
    await relay.run();
    const sent = await deliver();
    assert.equal(sent.length, 1);
    const v = unpack(sent[0].data);
    assert.equal(v[0], 2);
    assert.deepEqual(v[7], [100 + i * 13, 50]);
    assert.equal(v[5].size, 0);
    kinds.push(v[6] ? "card" : "cursor");
    if (i > 1) assert.ok(sent[0].data.length <= (v[6] ? 32 : 24), `${sent[0].data.length} B`);
  }
  assert.deepEqual(kinds, ["card", "cursor", "card", "cursor", "card", "cursor"]);
  clock.advance(200);
  assert.deepEqual(ls[1].cursors(B1).map((c) => [c.x, c.y]), [[178, 50]]);
  assert.deepEqual(ls[1].overlay(B1).get(C1), { pos: [72, 0] });
});

test("typing into a long card sends splices; one lost leaves the text as it was until the next keyframe", async () => {
  const { relay, clock, ts, ls, open } = await direct();
  open(0, 1);
  ls[0].hold([C1]);
  await relay.run();
  const base = "x".repeat(560);
  let text = base;
  const sizes = [], seen = [];
  const type = async (deliver = true) => {
    ls[0].sendLive(B1, { [C1]: { text } }, { id: C1, back: false, at: text.length });
    await relay.run();
    const [body] = ts[0].sent.splice(0);
    sizes.push(body.data.length);
    if (deliver) ts[1].onMessage(ls[0].id, body.data);
    await relay.run();
    seen.push(ls[1].overlay(B1).get(C1).text);
    clock.advance(8);
  };
  for (let i = 0; i < 20; i++) {
    text += "y";
    await type(i !== 10);
  }
  assert.ok(sizes.slice(1).every((n) => n <= 60), `${sizes}`);
  assert.equal(seen[9], base + "y".repeat(10));
  assert.ok(seen.slice(10).every((t) => t === seen[9]));
  clock.advance(1000);
  await type();
  assert.equal(seen.at(-1), text);
});

test("dragging three cards sends the offset only, and the receiver puts all three", async () => {
  const { relay, clock, ts, ls, open } = await direct();
  open(0, 1);
  const starts = { [C1]: [0, 0], [C2]: [0, 100], [C3]: [0, 200] };
  ls[0].hold([C1, C2, C3]);
  ls[0].sendCursor(B1, 0, 0);
  await relay.run();
  ts[0].sent.splice(0);
  const sizes = [];
  for (let i = 1; i <= 10; i++) {
    clock.advance(8);
    const dx = i * 5;
    ls[0].sendCursor(B1, dx, 10);
    ls[0].sendLive(B1, Object.fromEntries(Object.entries(starts).map(([id, [x, y]]) => [id, { pos: [x + dx, y] }])), null, starts);
    await relay.run();
    const [body] = ts[0].sent.splice(0);
    sizes.push(body.data.length);
    if (i > 1) assert.equal(unpack(body.data)[5].size, 0);
    ts[1].onMessage(ls[0].id, body.data);
    await relay.run();
  }
  assert.ok(sizes.slice(1).every((n) => n <= 40), `${sizes}`);
  clock.advance(200);
  assert.deepEqual(Object.fromEntries([...ls[1].overlay(B1)].map(([id, f]) => [id, f.pos])), { [C1]: [50, 0], [C2]: [50, 100], [C3]: [50, 200] });
});

test("dragging one card sends its offset only: at most 32 B on a channel and 64 B from the relay", async () => {
  const d = await direct();
  d.open(0, 1);
  d.ls[0].hold([C1]);
  d.ls[0].sendCursor(B1, 0, 0);
  await d.relay.run();
  d.ts[0].sent.splice(0);
  const sizes = [];
  for (let i = 1; i <= 10; i++) {
    d.clock.advance(8);
    d.ls[0].sendCursor(B1, i * 5, 10);
    d.ls[0].sendLive(B1, { [C1]: { pos: [i * 5, 0] } }, null, { [C1]: [0, 0] });
    await d.relay.run();
    const [body] = d.ts[0].sent.splice(0);
    sizes.push(body.data.length);
    assert.equal(unpack(body.data)[5].size, 0);
    d.ts[1].onMessage(d.ls[0].id, body.data);
    await d.relay.run();
  }
  assert.ok(sizes.slice(1).every((n) => n <= 32), `${sizes}`);
  d.clock.advance(200);
  assert.deepEqual(d.ls[1].overlay(B1).get(C1), { pos: [50, 0] });

  const { relay, clock, a, b } = await two();
  a.hold([C1]);
  for (let i = 1; i <= 10; i++) {
    clock.advance(50);
    a.sendCursor(B1, i * 5, 10);
    a.sendLive(B1, { [C1]: { pos: [i * 5, 0] } }, null, { [C1]: [0, 0] });
    await relay.run();
  }
  const bodies = fast(await sentBy(relay, a.id)).filter((s) => s.body.t === "live");
  assert.equal(bodies.length, 10);
  assert.ok(bodies.slice(1).every((s) => s.size <= 64), `${bodies.map((s) => s.size)}`);
  clock.advance(200);
  assert.deepEqual(b.overlay(B1).get(C1), { pos: [50, 0] });
});

test("a body that cannot be put compactly is not sent", async () => {
  const { relay, ts, ls, open, relayed } = await direct(3);
  open(0, 1);
  ls[0].sendCursor("not an id", 1, 1);
  await relay.run();
  assert.deepEqual(ts[0].sent, []);
  assert.deepEqual(await relayed(), []);
});

test("a peer that comes back to the board gets the cursor as it is now, hidden too", async () => {
  const { relay, clock, a, b } = await two();
  b.setPresence({ board: B2, selection: [] });
  await relay.run();
  a.sendCursor(B1, 1, 1);
  await relay.run();
  clock.advance(50);
  assert.deepEqual(b.cursors(B1).map((c) => [c.x, c.y]), [[1, 1]]);
  a.sendCursor(B1, 50, 50);
  await relay.run();
  clock.advance(50);
  a.sendCursor(B1, null, null);
  await relay.run();
  clock.advance(50);
  b.setPresence({ board: B1, selection: [] });
  await relay.run();
  clock.advance(200);
  assert.deepEqual(b.cursors(B1), []);
});

test("a peer that comes onto the board mid-drag gets the overlay without the holder moving", async () => {
  const { relay, clock, a, b } = await two();
  b.setPresence({ board: B2, selection: [] });
  await relay.run();
  a.hold([C1]);
  a.sendLive(B1, { [C1]: { pos: [10, 0], text: "hi" } }, null);
  await relay.run();
  assert.equal(b.overlay(B1).size, 0);
  b.setPresence({ board: B1, selection: [] });
  await relay.run();
  clock.advance(50);
  await relay.run();
  clock.advance(200);
  assert.deepEqual(b.overlay(B1).get(C1), { pos: [10, 0], text: "hi" });
});

test("a peer whose boards gain the board gets the cursor and the live edit", async () => {
  const { relay, clock, a, b } = await two();
  b.setPresence({ board: B2, boards: [B2], selection: [] });
  await relay.run();
  a.sendCursor(B2, 0, 0);
  await relay.run();
  clock.advance(50);
  a.sendCursor(B1, 5, 5);
  a.hold([C1]);
  a.sendLive(B1, moved, null);
  await relay.run();
  clock.advance(50);
  a.sendCursor(B1, 6, 6);
  await relay.run();
  clock.advance(50);
  b.setPresence({ board: B2, boards: [B2, B1], selection: [] });
  await relay.run();
  clock.advance(200);
  assert.deepEqual(b.cursors(B1).map((c) => [c.x, c.y]), [[6, 6]]);
  assert.deepEqual(Object.fromEntries(b.overlay(B1)), moved);
});

test("an older device and a current one both on the relay get one JSON broadcast that both read", async () => {
  const { relay, clock, a, b } = await two();
  const old = new OldDevice(relay, keys, { device: device() });
  old.connect();
  await relay.run();
  await old.presence(B1);
  await relay.run();
  a.sendCursor(B1, 3, 4);
  await relay.run();
  clock.advance(200);
  const [sent] = fast(await sentBy(relay, a.id));
  assert.equal(sent.to, null);
  assert.equal(sent.body.t, "cursor");
  assert.equal(sent.body.x, 3);
  assert.deepEqual([old.last("cursor").x, old.last("cursor").y], [3, 4]);
  assert.deepEqual(b.cursors(B1).map((c) => [c.x, c.y]), [[3, 4]]);
});

test("a channel opening or closing mid-gesture starts that peer on a keyframe, and its overlay stays right", async () => {
  const { relay, clock, ts, ls, open } = await direct();
  const lastRelayed = async () => {
    const f = relay.frames.filter((x) => x.from === ls[0].id && x.bytes).at(-1);
    return unpack(await keys.openLive(parseFrame(f.bytes).body));
  };
  ls[0].hold([C1]);
  const drag = async (x) => {
    clock.advance(50);
    ls[0].sendLive(B1, { [C1]: { pos: [x, 0], text: "hello" } }, null);
    await relay.run();
  };
  await drag(0);
  await drag(10);
  assert.equal((await lastRelayed())[3], null);
  open(0, 1);
  await drag(20);
  const [body] = ts[0].sent.splice(0);
  const v = unpack(body.data);
  assert.ok(v[3] instanceof Uint8Array);
  assert.equal([...v[5].values()][0].get(3), "hello");
  ts[1].onMessage(ls[0].id, body.data);
  await relay.run();
  ts[0].onState(ls[1].id, "closed");
  ts[1].onState(ls[0].id, "closed");
  await drag(30);
  const r = await lastRelayed();
  assert.ok(r[3] instanceof Uint8Array);
  assert.equal([...r[5].values()][0].get(3), "hello");
  clock.advance(200);
  assert.deepEqual(ls[1].overlay(B1).get(C1), { pos: [30, 0], text: "hello" });
});

test("a cursor inside a live body that is not newer than the last cursor is ignored", async () => {
  const { relay, clock, ts, ls, open } = await direct();
  open(0, 1);
  for (const x of [1, 2, 3]) {
    ls[0].sendCursor(B1, x, x);
    await relay.run();
    clock.advance(8);
  }
  for (const { data } of ts[0].sent.splice(0)) ts[1].onMessage(ls[0].id, data);
  await relay.run();
  const stale = new LiveEncoder().encode({ board: B1, items: {}, cursor: [999, 999] }, { seq: 1, at: 0, now: 0 });
  ts[1].onMessage(ls[0].id, stale);
  await relay.run();
  clock.advance(200);
  assert.deepEqual(ls[1].cursors(B1).map((c) => [c.x, c.y]), [[3, 3]]);
});

test("a channel that opens and closes between two relay bodies starts the relay over on a keyframe", async () => {
  const { relay, clock, ts, ls, open } = await direct();
  ls[0].hold([C1]);
  await relay.run();
  let text = "x".repeat(100);
  const type = async () => {
    text += "y";
    ls[0].sendLive(B1, { [C1]: { text } }, null);
    await relay.run();
  };
  await type();
  clock.advance(50);
  await type();
  open(0, 1);
  clock.advance(8);
  await type();
  for (const { data } of ts[0].sent.splice(0)) ts[1].onMessage(ls[0].id, data);
  await relay.run();
  ts[0].onState(ls[1].id, "closed");
  ts[1].onState(ls[0].id, "closed");
  await type();
  clock.advance(50);
  await relay.run();
  assert.equal(ls[1].overlay(B1).get(C1).text, text);
});

test("on a relay from before the lean sync design, current devices send JSON frames and see presence, cursors, live edits and pushes", async () => {
  const { relay, clock, a, b } = await two({ old: true });
  assert.doesNotMatch(a.id, /^\d+$/);
  assert.deepEqual(b.people(B1).map((p) => p.name), ["Ana Lima"]);
  a.sendCursor(B1, 1, 1);
  await relay.run();
  clock.advance(200);
  assert.deepEqual(b.cursors(B1).map((c) => c.x), [1]);
  a.hold([C1]);
  a.sendLive(B1, moved, null);
  await relay.run();
  assert.deepEqual(Object.fromEntries(b.overlay(B1)), moved);
  const got = [];
  b.onPushed = (v, extra) => got.push([v, extra]);
  const records = [{ id: "AAAA", version: 5, blob: "BBBB" }];
  await a.sendPushed({ version: 5, epoch: "e", records });
  await relay.run();
  assert.deepEqual(got, [[5, { epoch: "e", records }]]);
  assert.deepEqual(relay.frames.filter((f) => f.bytes), []);
});

test("on a relay from before the lean sync design, a holder's holds last through a long gesture to others there", async () => {
  const { relay, clock, a, b } = await two({ old: true });
  const c = live(relay, clock, { name: "Cy" });
  c.connect();
  await relay.run();
  c.setPresence({ board: B1, selection: [] });
  a.hold([C1]);
  await relay.run();
  for (let t = 0; t < 12_000; t += 50) {
    a.sendLive(B1, { [C1]: { pos: [t, 0] } }, null);
    await relay.run();
    clock.advance(50);
    if (t % 1000 === 0) {
      a.tick();
      relay.sweep();
      await relay.run();
    }
  }
  assert.deepEqual([...b.taken()], [C1]);
  assert.deepEqual(c.overlay(B1).get(C1), { pos: [11_950, 0] });
});

test("on a relay from before the lean sync design, current devices open a direct channel", async () => {
  const { relay, clock, ts, ls, open } = await direct(2, { oldRelay: true });
  assert.ok(ts[1].log.includes(`accept ${ls[0].id} answer-sdp ${ls[1].id}`));
  open(0, 1);
  ls[0].sendCursor(B1, 1, 1);
  await relay.run();
  assert.ok(ts[0].sent.length && ts[0].sent.every((s) => s.id === ls[1].id && s.data instanceof Uint8Array));
  for (const { data } of ts[0].sent) ts[1].onMessage(ls[0].id, data);
  await relay.run();
  clock.advance(200);
  assert.deepEqual(ls[1].cursors(B1).map((c) => c.x), [1]);
});

test("holding again, as when dragging the card just edited before the edit's push releases it, starts on a keyframe", async () => {
  const { relay, clock, a } = await two();
  const last = async () => unpack(await keys.openLive(parseFrame(relay.frames.filter((f) => f.from === a.id && f.bytes).at(-1).bytes).body));
  a.hold([C1]);
  a.sendLive(B1, { [C1]: { text: "hello" } }, null);
  await relay.run();
  clock.advance(50);
  a.sendLive(B1, { [C1]: { text: "hello!" } }, null);
  await relay.run();
  assert.equal((await last())[3], null);
  clock.advance(50);
  a.hold([C1]);
  a.sendLive(B1, { [C1]: { pos: [48, 0] } }, null);
  await relay.run();
  assert.ok((await last())[3] instanceof Uint8Array);
});

test("the channels' repeat of the first cursor on another board goes to everyone too", async () => {
  const { relay, clock, ts, ls, open } = await direct(3);
  for (const j of [1, 2]) open(0, j);
  ls[2].setPresence({ board: B2, selection: [] });
  await relay.run();
  ls[0].sendCursor(B1, 1, 1);
  await relay.run();
  clock.advance(200);
  await relay.run();
  ts[0].sent.splice(0);
  ls[0].sendCursor(B2, 1, 1);
  clock.advance(8);
  await relay.run();
  const everyone = [ls[1].id, ls[2].id].sort();
  assert.deepEqual(ts[0].sent.splice(0).map((s) => s.id).sort(), everyone);
  clock.advance(100);
  await relay.run();
  assert.deepEqual(ts[0].sent.splice(0).map((s) => s.id).sort(), everyone);
});
