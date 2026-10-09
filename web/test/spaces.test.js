import { test } from "node:test";
import assert from "node:assert/strict";
import { Spaces } from "../sync/spaces.js";
import { Store } from "../sync/store.js";
import { MemoryStorage } from "./helpers/storage.js";
import { FakeServer, FakeTransport, SERVER, device, mulberry } from "./helpers/fake-server.js";
import { FakeRelay } from "./helpers/fake-relay.js";
import { newID } from "../rules.js";
import * as R from "../rules.js";

const SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const card = (id, text) => ({ id, x: 0, y: 0, w: 240, text, color: 1 });

/** A fake server per space, made on first use. */
function servers() {
  const all = new Map();
  const server = (space) => all.get(space) ?? all.set(space, new FakeServer()).get(space);
  return { server, transport: (state) => new FakeTransport(server(state.space)) };
}

test("a store from before spaces becomes its space", async () => {
  const old = new Store();
  old.startSyncing(SERVER);
  const id = old.createBoard("Plans");
  old.advance(7);
  const storage = new MemoryStorage({ space: old.state });
  const spaces = await Spaces.open(storage);
  assert.equal(storage.data.has("space"), false);
  assert.deepEqual(storage.data.get(`space:${old.state.space}`), old.state);
  assert.equal(spaces.spaces.length, 1);
  assert.equal(spaces.spaces[0].store.state.cursor, 7);
  assert.equal(spaces.groupOf(id), spaces.spaces[0]);
  assert.deepEqual(spaces.local.store.boards(), []);
  assert.equal(spaces.fresh, false);
});

test("a store that never synced becomes On this device", async () => {
  const old = new Store();
  old.createBoard("Plans");
  const spaces = await Spaces.open(new MemoryStorage({ space: old.state }));
  assert.deepEqual(spaces.spaces, []);
  assert.deepEqual(spaces.local.store.boards().map((b) => b.title), ["Plans"]);
  assert.equal(spaces.local.name, "On this device");
});

test("an interrupted migration runs again", async () => {
  const old = new Store();
  old.startSyncing(SERVER);
  old.createBoard("Plans");
  const spaces = await Spaces.open(new MemoryStorage({ space: old.state, [`space:${old.state.space}`]: old.state }));
  assert.equal(spaces.spaces.length, 1);
  assert.deepEqual(spaces.spaces[0].store.boards().map((b) => b.title), ["Plans"]);
});

test("an old store reappearing does not overwrite the migrated group", async () => {
  const old = new Store();
  old.createBoard("Old");
  const now = new Store();
  now.createBoard("New");
  const storage = new MemoryStorage({ space: old.state, local: now.state });
  const spaces = await Spaces.open(storage);
  assert.deepEqual(spaces.local.store.boards().map((b) => b.title), ["New"]);
  assert.equal((await storage.loadAll()).space, undefined);
});

test("spaces number-aware sort by name", async () => {
  const spaces = await Spaces.open(new MemoryStorage());
  spaces.newSpace(SERVER, "Space 10");
  spaces.newSpace(SERVER, "Space 2");
  assert.deepEqual(spaces.groups().map((g) => g.name), ["On this device", "Space 2", "Space 10"]);
});

test("a device with nothing stored is fresh", async () => {
  assert.equal((await Spaces.open(new MemoryStorage())).fresh, true);
});

test("groups come On this device first, then spaces by name", async () => {
  const storage = new MemoryStorage();
  const spaces = await Spaces.open(storage);
  const zed = spaces.newSpace(SERVER, "Zed");
  const abe = spaces.newSpace(SERVER, "Abe");
  assert.deepEqual(spaces.groups().map((g) => g.name), ["On this device", "Abe", "Zed"]);
  const id = zed.store.createBoard("Plans");
  assert.equal(spaces.groupOf(id), zed);
  assert.equal(spaces.groupFor(abe.space), abe);
  await spaces.flushAll();
  const again = await Spaces.open(storage);
  assert.deepEqual(again.groups().map((g) => g.name), ["On this device", "Abe", "Zed"]);
  assert.equal(again.lastServer, SERVER);
});

test("joining a space already joined gives its group", async () => {
  const spaces = await Spaces.open(new MemoryStorage());
  const invite = { server: SERVER, space: newID(), secret: SECRET, name: "Ours" };
  const g = spaces.join(invite);
  assert.equal(g.name, "Ours");
  assert.equal(spaces.join(invite), g);
  assert.equal(spaces.spaces.length, 1);
});

test("leaving removes the space's key for good", async () => {
  const storage = new MemoryStorage();
  const spaces = await Spaces.open(storage);
  const g = spaces.newSpace(SERVER, "Work");
  g.store.createBoard("Plans");
  await spaces.leave(g);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(storage.data.has(g.key), false);
  assert.deepEqual(spaces.spaces, []);
  assert.deepEqual((await Spaces.open(storage)).spaces, []);
});

test("moving a board copies it with new ids and deletes it where it was", async () => {
  const storage = new MemoryStorage();
  const spaces = await Spaces.open(storage);
  const work = spaces.newSpace(SERVER, "Work");
  const lane = { id: "l", x: 0, y: 0, w: 480, h: 720, title: "Doing" };
  const id = work.store.createBoard("Plans", { cards: [card("a", "first"), card("b", "second")], lanes: [lane] });
  for (const p of work.store.pending()) work.store.accepted(p.id, 1, p.record);
  const moved = await spaces.move(id, spaces.local);
  const b = spaces.local.store.board(moved);
  assert.equal(spaces.local.store.title(moved), "Plans");
  assert.deepEqual(b.cards.map((c) => c.text), ["first", "second"]);
  assert.deepEqual(b.lanes.map((l) => l.title), ["Doing"]);
  for (const x of [moved, ...b.cards.map((c) => c.id), ...b.lanes.map((l) => l.id)]) assert.ok(!["a", "b", "l", id].includes(x));
  assert.equal(work.store.title(id), null);
  assert.deepEqual(work.store.pending().map((p) => p.id).sort(), [id, "a", "b", "l"].sort());
  assert.ok(storage.data.get("local").records[moved]);
});

test("a move whose copy can't be saved leaves the board where it was", async () => {
  const storage = new MemoryStorage();
  const spaces = await Spaces.open(storage);
  const work = spaces.newSpace(SERVER, "Work");
  const id = spaces.local.store.createBoard("Plans");
  await spaces.flushAll();
  storage.failing = true;
  assert.equal(await spaces.move(id, work), null);
  assert.equal(spaces.local.store.title(id), "Plans");
  assert.equal(spaces.saveFailed, true);
});

test("a device in two spaces moving boards ends like each space", async () => {
  const { server, transport } = servers();
  const a = await Spaces.open(new MemoryStorage(), { transport });
  const x = a.newSpace(SERVER, "X");
  const y = a.newSpace(SERVER, "Y");
  for (const [g, t] of [[x, "x"], [y, "y"]]) for (let n = 0; n < 3; n++) g.store.createBoard(`${t}${n}`, { cards: [card(newID(), t)], lanes: [] });
  await x.engine.sync();
  await y.engine.sync();
  const b = device(server(x.space), x.store.invite);
  const c = device(server(y.space), y.store.invite);
  await b.engine.sync();
  await c.engine.sync();
  const rnd = mulberry(7);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  for (let step = 0; step < 200; step++) {
    const roll = Math.floor(rnd() * 6);
    if (roll === 0) {
      const from = rnd() < 0.5 ? x : y;
      const board = pick(from.store.boards());
      if (board) await a.move(board.id, from === x ? y : x);
    } else if (roll <= 4) {
      await [x.engine, y.engine, b.engine, c.engine][roll - 1].sync();
    } else {
      const d = rnd() < 0.5 ? b : c;
      const row = Math.floor(rnd() * 20) * 24;
      const board = pick(d.store.boards());
      if (board) d.edit(board.id, (bd) => R.addCard(bd, 0, row));
    }
  }
  for (let i = 0; i < 3; i++) for (const e of [x.engine, y.engine, b.engine, c.engine]) await e.sync();
  for (const [g, d] of [[x, b], [y, c]]) {
    assert.deepEqual(g.store.pending(), []);
    assert.deepEqual(d.store.pending(), []);
    assert.deepEqual(g.store.boards(), d.store.boards());
    for (const { id } of g.store.boards()) assert.deepEqual(g.store.board(id), d.store.board(id));
  }
});

test("a move while read-only leaves the board where it was", async () => {
  const old = new Store();
  const id = old.createBoard("Plans");
  const spaces = new Spaces(new MemoryStorage(), { local: old.state }, { readOnly: true });
  const work = spaces.newSpace(SERVER, "Work");
  assert.equal(await spaces.move(id, work), null);
  assert.equal(spaces.local.store.title(id), "Plans");
  assert.deepEqual(work.store.boards(), []);
});

async function liveSpaces(srv, relay, storage = new MemoryStorage()) {
  return Spaces.open(storage, { transport: srv.transport, socket: () => relay.connect() });
}

/** Lets the live layer appear: it needs the space's keys, which take a moment. */
const settleLive = () => new Promise((r) => setTimeout(r, 20));

test("a device has a name and an id, kept", async () => {
  const storage = new MemoryStorage();
  const spaces = await Spaces.open(storage);
  assert.equal(spaces.me.name, "");
  assert.equal(storage.data.get("me").device, spaces.me.device);
  await spaces.setName("Ana");
  const again = await Spaces.open(storage);
  assert.deepEqual(again.me, { device: spaces.me.device, name: "Ana" });
});

test("a relay gives the space a live layer", async () => {
  const srv = servers(), relay = new FakeRelay();
  const spaces = await liveSpaces(srv, relay);
  await spaces.setName("Ana");
  let heard = 0;
  spaces.onLive = () => heard++;
  const g = spaces.newSpace(SERVER, "Work");
  srv.server(g.space).relay = "wss://relay.example/";
  await g.engine.sync();
  await settleLive();
  assert.equal(g.live.relay, "wss://relay.example/");
  assert.equal(g.live.me.name, "Ana");
  assert.ok(heard >= 1);
  await spaces.setName("Ana Lima");
  assert.equal(g.live.me.name, "Ana Lima");
  srv.server(g.space).relay = null;
  await g.engine.sync();
  await settleLive();
  assert.equal(g.live, null);
});

test("without a relay there is no live layer", async () => {
  const srv = servers(), relay = new FakeRelay();
  const spaces = await liveSpaces(srv, relay);
  const g = spaces.newSpace(SERVER, "Work");
  await g.engine.sync();
  await settleLive();
  assert.equal(g.live, null);
  const before = g.engine.lastCycle;
  await new Promise((r) => setTimeout(r, 5));
  spaces.syncAll({ polling: true });
  await g.engine.running;
  assert.ok(g.engine.lastCycle > before);
});

test("while live is connected, polling waits 30 s", async () => {
  const srv = servers(), relay = new FakeRelay();
  let now = 1_000_000;
  const spaces = await Spaces.open(new MemoryStorage(), { transport: srv.transport, socket: () => relay.connect(), now: () => now });
  const g = spaces.newSpace(SERVER, "Work");
  srv.server(g.space).relay = "wss://relay.example/";
  await g.engine.sync();
  await settleLive();
  g.live.connect();
  await relay.run();
  assert.ok(g.live.connected);
  const before = g.engine.lastCycle;
  now += 10_000;
  spaces.syncAll({ polling: true });
  assert.equal(g.engine.running, null);
  now += 21_000;
  spaces.syncAll({ polling: true });
  await g.engine.running;
  assert.ok(g.engine.lastCycle > before);
});

test("a push is announced, and an announced push is pulled at once", async () => {
  const srv = servers(), relay = new FakeRelay();
  const a = await liveSpaces(srv, relay), b = await liveSpaces(srv, relay);
  const ga = a.newSpace(SERVER, "Work");
  srv.server(ga.space).relay = "wss://relay.example/";
  await ga.engine.sync();
  const gb = b.join(ga.store.invite);
  await gb.engine.sync();
  await settleLive();
  ga.live.connect();
  gb.live.connect();
  await relay.run();
  const id = ga.store.createBoard("Plans");
  await ga.engine.sync();
  await relay.run();
  await gb.engine.running;
  assert.equal(gb.store.title(id), "Plans");
});

test("leaving a space closes its live layer", async () => {
  const srv = servers(), relay = new FakeRelay();
  const spaces = await liveSpaces(srv, relay);
  const g = spaces.newSpace(SERVER, "Work");
  srv.server(g.space).relay = "wss://relay.example/";
  await g.engine.sync();
  await settleLive();
  g.live.connect();
  await relay.run();
  await spaces.leave(g);
  await relay.run();
  assert.equal(relay.sockets.length, 0);
});
