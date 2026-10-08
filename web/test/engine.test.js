import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeServer, SERVER, device, pair, mulberry } from "./helpers/fake-server.js";
import { statusLines, TransportError } from "../sync/engine.js";
import { SpaceKeys } from "../sync/crypto.js";
import { encode, decode } from "../sync/base64.js";
import { newID } from "../rules.js";
import * as R from "../rules.js";

test("a joining device gets the boards", async () => {
  const { a, b, id } = await pair(newID);
  assert.deepEqual(b.store.boards().map((x) => x.title), ["Plans"]);
  assert.deepEqual(b.store.board(id), a.store.board(id));
  assert.equal(a.engine.status.state, "synced");
  assert.deepEqual(a.store.pending(), []);
});

test("edits to different fields of a card combine", async () => {
  const { a, b, id } = await pair(newID);
  a.edit(id, (x) => (x.cards[0].color = 3));
  b.edit(id, (x) => (x.cards[0].text = "y"));
  await a.engine.sync();
  await b.engine.sync();
  await a.engine.sync();
  for (const d of [a, b]) assert.deepEqual(d.store.board(id).cards.map((c) => [c.color, c.text]), [[3, "y"]]);
});

test("text edited on both sides ends as two cards", async () => {
  const { a, b, id } = await pair(newID);
  a.edit(id, (x) => (x.cards[0].text = "from a"));
  b.edit(id, (x) => (x.cards[0].text = "from b"));
  await a.engine.sync();
  await b.engine.sync();
  await a.engine.sync();
  for (const d of [a, b]) assert.deepEqual(d.store.board(id).cards.map((c) => c.text).sort(), ["from a", "from b"]);
});

test("offline changes wait and are counted", async () => {
  const { a, id } = await pair(newID);
  a.transport.online = false;
  a.edit(id, (x) => R.addCard(x, 0, 0));
  await a.engine.sync();
  assert.deepEqual(statusLines(a.engine.status), ["Offline — 1 change waiting"]);
  a.transport.online = true;
  const calls = a.transport.calls;
  await a.engine.sync();
  assert.equal(a.transport.calls, calls);
  a.engine.reset();
  await a.engine.sync();
  assert.deepEqual(statusLines(a.engine.status), ["Synced just now"]);
  assert.deepEqual(a.store.pending(), []);
});

test("a refused token stops syncing", async () => {
  const { a } = await pair(newID);
  a.transport.failure = "unauthorized";
  await a.engine.sync();
  assert.deepEqual(statusLines(a.engine.status), ["Not in this space any more"]);
  const calls = a.transport.calls;
  await a.engine.sync();
  assert.equal(a.transport.calls, calls);
});

test("an unreadable record is skipped and counted", async () => {
  const { server, a } = await pair(newID);
  server.put(newID(), "AAAA");
  await a.engine.sync();
  assert.equal(a.store.state.unreadable, 1);
  assert.equal(a.store.state.cursor, server.version);
  assert.ok(statusLines(a.engine.status).includes("1 unreadable change"));
});

test("a record from a newer Breezy waits", async () => {
  const { server, a } = await pair(newID);
  const keys = await SpaceKeys.create(decode(a.store.state.space), decode(a.store.state.secret));
  const id = newID();
  const plain = new TextEncoder().encode(JSON.stringify({ format: 2, kind: "board", title: "Later" }));
  server.put(id, encode(await keys.seal(plain, decode(id))));
  await a.engine.sync();
  assert.ok(a.store.state.held[id]);
  assert.ok(!a.store.boards().some((x) => x.title === "Later"));
  assert.ok(statusLines(a.engine.status).includes("Update Breezy to see all changes"));
});

test("a card too long to sync stays here", async () => {
  const { a, id } = await pair(newID);
  const c = a.store.board(id).cards[0].id;
  a.edit(id, (x) => (x.cards[0].text = "x".repeat(70_000)));
  await a.engine.sync();
  assert.ok(statusLines(a.engine.status).includes("Card too long to sync"));
  assert.deepEqual(a.store.pending().map((p) => p.id), [c]);
});

test("pulls come in pages", async () => {
  const server = new FakeServer();
  const a = device(server);
  const invite = a.store.startSyncing(SERVER);
  const cards = Array.from({ length: 600 }, (_, i) => ({ id: newID(), x: 0, y: i * 24, w: 240, text: "t", color: 1 }));
  const id = a.store.createBoard("Big", { cards, lanes: [] });
  await a.engine.sync();
  const b = device(server, invite);
  await b.engine.sync();
  assert.equal(b.store.board(id).cards.length, 600);
});

test("four devices end the same", async () => {
  const server = new FakeServer();
  const first = device(server);
  const invite = first.store.startSyncing(SERVER);
  const id = first.store.createBoard("Plans");
  await first.engine.sync();
  const devices = [first, device(server, invite), device(server, invite), device(server, invite)];
  const rnd = mulberry(42);
  const int = (n) => Math.floor(rnd() * n);
  for (let step = 0; step < 300; step++) {
    const d = devices[int(4)];
    const roll = int(10);
    if (roll === 0) d.transport.online = !d.transport.online;
    else if (roll <= 3) {
      d.engine.reset();
      await d.engine.sync();
    } else {
      const pick = int(6), n = int(1000);
      d.edit(id, (b) => {
        const i = b.cards.length ? n % b.cards.length : -1;
        if (pick === 0) R.addCard(b, (n % 20) * 24, 0);
        else if (i < 0) return;
        else if (pick === 1) b.cards[i].text = `t${n}`;
        else if (pick === 2) b.cards[i].color = (n % 5) + 1;
        else if (pick === 3) Object.assign(b.cards[i], { x: b.cards[i].x + 24, y: b.cards[i].y + 24 });
        else if (pick === 4) b.cards.splice(i, 1);
        else b.cards.push(...b.cards.splice(i, 1));
      });
    }
  }
  for (const d of devices) {
    d.transport.online = true;
    d.engine.reset();
  }
  for (let round = 0; round < 3; round++) for (const d of devices) await d.engine.sync();
  const expected = devices[0].store.board(id);
  for (const d of devices) {
    assert.deepEqual(d.store.pending(), []);
    assert.deepEqual(d.store.board(id), expected);
  }
});

test("a refusal we cannot read leaves the edit waiting", async () => {
  const { server, a, id } = await pair(newID);
  const c = a.store.board(id).cards[0].id;
  a.edit(id, (x) => (x.cards[0].text = "mine"));
  const keys = await SpaceKeys.create(decode(a.store.state.space), decode(a.store.state.secret));
  const plain = new TextEncoder().encode(JSON.stringify({ format: 2, kind: "card" }));
  server.put(c, encode(await keys.seal(plain, decode(c))));
  await a.engine.sync();
  const unreadable = a.store.state.unreadable;
  await a.engine.sync();
  assert.equal(a.engine.status.state, "synced");
  assert.ok(statusLines(a.engine.status).includes("Update Breezy to see all changes"));
  assert.deepEqual(a.store.pending().map((p) => p.id), [c]);
  assert.equal(a.store.state.unreadable, unreadable);
});

test("a space joined mid-cycle gets nothing from the old one", async () => {
  const other = new FakeServer();
  const o = device(other);
  const invite = o.store.startSyncing(SERVER);
  o.store.createBoard("New space board");
  await o.engine.sync();
  const server = new FakeServer();
  const a = device(server);
  const old = a.store.startSyncing(SERVER);
  a.store.createBoard("Old space board");
  await a.engine.sync();
  const joiner = device(server, old);
  let calls = 0;
  joiner.engine.flushLocal = () => {
    if (++calls === 2) joiner.store.join(invite);
  };
  await joiner.engine.sync();
  assert.equal(joiner.store.state.cursor, 0);
  assert.deepEqual(joiner.store.boards(), []);
});

test("a failure in the old space leaves the new one free to sync", async () => {
  const other = new FakeServer();
  const o = device(other);
  const invite = o.store.startSyncing(SERVER);
  const a = device(new FakeServer());
  a.store.startSyncing(SERVER);
  a.transport.pull = async () => {
    a.store.join(invite);
    throw new TransportError("unreachable");
  };
  await a.engine.sync();
  assert.equal(a.engine.failures, 0);
  assert.equal(a.engine.retryAt, 0);
  assert.notEqual(a.engine.status.state, "unreachable");
  let pulled = false;
  a.transport.pull = async () => {
    pulled = true;
    return { records: [], cursor: 0 };
  };
  await a.engine.sync();
  assert.ok(pulled);
});
