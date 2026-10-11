// Mirrored in BreezyKit's CollabTests.swift: the same cases, so that both apps' glue behaves alike.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Collab } from "../sync/collab.js";
import { GestureHolds } from "../sync/gesture-holds.js";
import { Live } from "../sync/live.js";
import { Store } from "../sync/store.js";
import { SyncEngine } from "../sync/engine.js";
import { encode, decode } from "../sync/base64.js";
import { randomBytes } from "../sync/crypto.js";
import { Model } from "../model.js";
import { Binding } from "../binding.js";
import * as R from "../rules.js";
import { FakeRelay, Clock } from "./helpers/fake-relay.js";
import { FakeServer, FakeTransport, SERVER } from "./helpers/fake-server.js";

const id = (n) => encode(new Uint8Array(16).fill(n));
const [C1, C2, C3] = [0xc1, 0xc2, 0xc3].map(id);
const card = (cid, x) => ({ id: cid, x, y: 0, w: 240, text: "t", color: 0 });

/** A device in a space with boards `b1` (cards C1, C2) and `b2` (C3), its Collab, and another device watching `b1`. */
async function setup() {
  const clock = new Clock(), relay = new FakeRelay({ now: clock.now }), server = new FakeServer();
  const store = new Store();
  store.startSyncing(SERVER);
  const b1 = store.createBoard("One", { cards: [card(C1, 0), card(C2, 480)], lanes: [] });
  const b2 = store.createBoard("Two", { cards: [card(C3, 0)], lanes: [] });
  const transport = new FakeTransport(server);
  const engine = new SyncEngine(store, { transport: () => transport, now: clock.now });
  await engine.sync();
  const keys = await engine.keysOf(store.state);
  const live = (name) =>
    new Live({ relay: "wss://relay.example/", space: store.state.space, keys, me: { device: encode(randomBytes(16)), name }, socket: () => relay.connect(), now: clock.now, clock: clock.now, schedule: clock.schedule });
  const mine = live("Ana"), other = live("Bo");
  engine.onPushing = () => mine.pushing();
  engine.onPushed = (p) => mine.sendPushed(p);
  for (const l of [mine, other]) {
    l.connect();
    await relay.run();
  }
  mine.setPresence({ board: b1, selection: [] });
  other.setPresence({ board: b1, selection: [] });
  await relay.run();
  const group = { space: store.state.space, store, engine, live: mine };
  const collab = new Collab(group, new GestureHolds());
  /** Board `b` open, as the apps open it. */
  const open = (b) => {
    const model = new Model(store.board(b));
    const binding = new Binding(store, model, b, () => {});
    const session = collab.open(b, model, binding);
    model.onChange = () => {
      binding.changed();
      session.edited();
    };
    return { model, binding, session };
  };
  const pushes = () => transport.log.filter((x) => x === "push").length;
  /** Lets syncs, finishes and the relay run. */
  const settle = async () => {
    await engine.running;
    await relay.run();
  };
  return { clock, relay, store, transport, engine, live: mine, other, collab, b1, b2, open, pushes, settle };
}

const colorOf = (store, b, cid) => store.board(b).cards.find((c) => c.id === cid).color;
const xOf = (store, b, cid) => store.board(b).cards.find((c) => c.id === cid).x;
const move = (cid, x) => (b) => (R.card(b, cid).x = x);

test("a recolour outside a gesture flushes, pushes at once and sends one keyframe when the push goes now, and none behind a back-off", async () => {
  const d = await setup();
  const { model } = d.open(d.b1);
  const before = d.pushes();
  model.perform("Color", (b) => R.setColor(b, new Set([C1]), 3));
  assert.equal(colorOf(d.store, d.b1, C1), 3);
  await d.settle();
  assert.equal(d.pushes(), before + 1);
  assert.deepEqual(Object.fromEntries(d.other.overlay(d.b1)), { [C1]: { color: 3 } });
  d.transport.online = false;
  await d.engine.sync();
  d.transport.online = true;
  model.perform("Color", (b) => R.setColor(b, new Set([C2]), 4));
  assert.equal(colorOf(d.store, d.b1, C2), 4);
  await d.settle();
  assert.equal(d.pushes(), before + 1);
  assert.equal(d.other.overlay(d.b1).has(C2), false);
});

test("a press holds; moves send live bodies; nothing is pushed until the end; the end flushes, pushes, then releases", async () => {
  const d = await setup();
  const { model, session } = d.open(d.b1);
  const held = [];
  d.transport.beforePush = async () => held.push(d.live.mine.size);
  const before = d.pushes();
  model.begin();
  session.hold(new Set([C1]));
  await d.relay.run();
  assert.deepEqual([...d.other.taken()], [C1]);
  for (const x of [24, 48, 72]) {
    d.clock.advance(30);
    model.update(move(C1, x));
    await d.relay.run();
  }
  d.clock.advance(200);
  assert.deepEqual(d.other.overlay(d.b1).get(C1), { pos: [72, 0] });
  assert.equal(d.pushes(), before);
  model.end("Move");
  await d.settle();
  assert.equal(xOf(d.store, d.b1, C1), 72);
  assert.equal(d.pushes(), before + 1);
  assert.deepEqual(held, [1]);
  assert.equal(d.live.mine.size, 0);
  assert.equal(d.other.taken().size, 0);
});

test("a gesture's end while another started on the same space does not release", async () => {
  const d = await setup();
  const one = d.open(d.b1), two = d.open(d.b2);
  one.model.begin();
  one.session.hold(new Set([C1]));
  one.model.update(move(C1, 24));
  two.model.begin();
  two.session.hold(new Set([C3]));
  one.model.end("Move");
  await d.settle();
  assert.deepEqual([...d.live.mine].sort(), [C1, C3].sort());
  two.model.end("Move");
  await d.settle();
  assert.equal(d.live.mine.size, 0);
});

test("tick releases holds that no gesture or finish explains, on the second idle tick", async () => {
  const d = await setup();
  const { model, session } = d.open(d.b1);
  model.begin();
  session.hold(new Set([C1]));
  for (let i = 0; i < 3; i++) d.collab.tick();
  assert.equal(d.live.mine.size, 1);
  model.cancel();
  await d.settle();
  d.live.hold(new Set([C2]));
  d.collab.tick();
  assert.equal(d.live.mine.size, 1);
  d.collab.tick();
  assert.equal(d.live.mine.size, 0);
});

test("holdBack is true only during a gesture with the relay connected and something held", async () => {
  const d = await setup();
  const { model, session } = d.open(d.b1);
  assert.equal(d.engine.holdBack(), false);
  d.live.hold(new Set([C2]));
  assert.equal(d.engine.holdBack(), false);
  d.live.release();
  model.begin();
  assert.equal(d.engine.holdBack(), false);
  session.hold(new Set([C1]));
  assert.equal(d.engine.holdBack(), true);
  d.relay.kick(d.relay.sockets[0], 1006);
  await d.relay.run();
  assert.equal(d.engine.holdBack(), false);
  model.end("Move");
  assert.equal(d.engine.holdBack(), false);
});

test("an edit ending a gesture that held nothing counts as an edit outside a gesture", async () => {
  const d = await setup();
  const { model } = d.open(d.b1);
  const before = d.pushes();
  model.begin();
  model.update((b) => R.setColor(b, new Set([C1]), 5));
  model.end("Color");
  await d.settle();
  assert.equal(colorOf(d.store, d.b1, C1), 5);
  assert.equal(d.pushes(), before + 1);
  assert.deepEqual(Object.fromEntries(d.other.overlay(d.b1)), { [C1]: { color: 5 } });
});
