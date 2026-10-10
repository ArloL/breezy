import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeServer, SERVER, device, pair, mulberry, seededIDs } from "./helpers/fake-server.js";
import { statusLines, TransportError, validRelay, HttpTransport, SyncEngine } from "../sync/engine.js";
import { SpaceKeys } from "../sync/crypto.js";
import { encode, decode } from "../sync/base64.js";
import { inflateRawSync } from "node:zlib";
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

/**
 * Two synced devices, a backup, edits on both, the backup restored, more edits on both, then syncs in `order`
 * ("ab" or "ba"). When `behind`, a edits the card before the backup and b sees nothing after pairing until the restore.
 */
async function restored(order, { behind = false, ids = newID } = {}) {
  const { server, a, b, id } = await pair(ids);
  const c = a.store.board(id).cards[0].id;
  if (behind) {
    a.edit(id, (x) => (R.card(x, c).text = "seen by backup"));
    await a.engine.sync();
  }
  const backup = server.snapshot();
  const added = [ids(), ids()];
  const add = (n, y) => (x) => x.cards.push({ id: added[n], x: 0, y, w: 240, text: "", color: 1 });
  a.edit(id, (x) => (x.cards[0].color = 3));
  b.edit(id, add(0, 100));
  for (const d of behind ? [a] : [a, b, a]) await d.engine.sync();
  server.restore(backup);
  a.edit(id, (x) => (R.card(x, c).text = "after"));
  b.edit(id, add(1, 200));
  for (let round = 0; round < 3; round++) for (const d of order === "ab" ? [a, b] : [b, a]) await d.engine.sync();
  return { a, b, id, c, added };
}

for (const order of ["ab", "ba"]) {
  test(`devices recover from a restored server (${order})`, async () => {
    const { a, b, id, c, added } = await restored(order);
    const expected = a.store.board(id);
    assert.deepEqual(b.store.board(id), expected);
    assert.equal(expected.cards.length, 3);
    assert.equal(R.card(expected, c).color, 3);
    assert.equal(R.card(expected, c).text, "after");
    for (const card of added) assert.ok(R.card(expected, card));
    for (const d of [a, b]) {
      assert.deepEqual(d.store.pending(), []);
      assert.equal(d.engine.status.state, "synced");
      assert.equal(d.store.state.resync, false);
    }
  });
}

test("a late resync keeps what others did since", async () => {
  const { server, a, b, id } = await pair(newID);
  const c = a.store.board(id).cards[0].id;
  let d;
  a.edit(id, (x) => (d = R.addCard(x, 0, 100)));
  for (const x of [a, b]) await x.engine.sync();
  const backup = server.snapshot();
  a.edit(id, (x) => (R.card(x, c).color = 3));
  for (const x of [a, b]) await x.engine.sync();
  server.restore(backup);
  for (let i = 0; i < 5; i++) await a.engine.sync();
  a.edit(id, (x) => {
    R.card(x, c).text = "after";
    x.cards = x.cards.filter((k) => k.id !== d);
  });
  await a.engine.sync();
  for (let round = 0; round < 2; round++) for (const x of [b, a]) await x.engine.sync();
  for (const x of [a, b]) {
    assert.deepEqual(x.store.board(id).cards.map((k) => [k.text, k.color]), [["after", 3]]);
    assert.deepEqual(x.store.pending(), []);
    assert.equal(x.engine.status.state, "synced");
  }
});

test("a device behind the backup keeps what it has", async () => {
  const { server, a, b, id } = await pair(newID);
  const c = a.store.board(id).cards[0].id;
  let d;
  a.edit(id, (x) => (d = R.addCard(x, 0, 100)));
  for (const x of [a, b]) await x.engine.sync();
  a.edit(id, (x) => {
    R.card(x, c).text = "seen by backup";
    x.cards = x.cards.filter((k) => k.id !== d);
  });
  await a.engine.sync();
  server.restore(server.snapshot());
  await a.engine.sync();
  for (let round = 0; round < 2; round++) for (const x of [b, a]) await x.engine.sync();
  for (const x of [a, b]) {
    assert.deepEqual(x.store.board(id).cards.map((k) => k.text), ["seen by backup"]);
    assert.deepEqual(x.store.pending(), []);
    assert.equal(x.engine.status.state, "synced");
  }
});

test("overlapping resyncs make no copies", async () => {
  const { server, a, b, id } = await pair(newID);
  const backup = server.snapshot();
  a.edit(id, (x) => (x.cards[0].text = "only a"));
  await a.engine.sync();
  server.restore(backup);
  let once = true;
  a.transport.beforePush = async () => {
    if (!once) return;
    once = false;
    await b.engine.sync();
  };
  await a.engine.sync();
  for (let round = 0; round < 2; round++) for (const x of [b, a]) await x.engine.sync();
  for (const x of [a, b]) {
    assert.deepEqual(x.store.board(id).cards.map((k) => k.text), ["only a"]);
    assert.deepEqual(x.store.pending(), []);
    assert.equal(x.engine.status.state, "synced");
  }
});

test("devices refill a lost space", async () => {
  const { server, a, b, id } = await pair(newID);
  server.wipe();
  b.edit(id, (x) => R.addCard(x, 0, 100));
  await b.engine.sync();
  assert.equal(server.records.size, 3);
  assert.equal(server.epoch, b.store.state.epoch);
  a.edit(id, (x) => R.addCard(x, 0, 200));
  for (let round = 0; round < 2; round++) for (const d of [a, b]) await d.engine.sync();
  assert.equal(a.store.board(id).cards.length, 3);
  assert.deepEqual(b.store.board(id), a.store.board(id));
  for (const d of [a, b]) {
    assert.deepEqual(d.store.pending(), []);
    assert.equal(d.engine.status.state, "synced");
  }
});

test("restores end the same whatever the ids", async () => {
  for (let run = 0; run < 200; run++) {
    const { a, b, id, c, added } = await restored(run % 2 ? "ba" : "ab", { behind: run % 4 >= 2, ids: seededIDs(run) });
    const expected = a.store.board(id);
    assert.deepEqual(b.store.board(id), expected, `run ${run}`);
    assert.equal(R.card(expected, c).text, "after", `run ${run}`);
    for (const card of added) assert.ok(R.card(expected, card), `run ${run}`);
    for (const d of [a, b]) {
      assert.deepEqual(d.store.pending(), [], `run ${run}`);
      assert.equal(d.engine.status.state, "synced", `run ${run}`);
      assert.equal(d.store.state.resync, false, `run ${run}`);
    }
  }
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

test("the engine learns the relay and reports pushes and pulls", async () => {
  const { server, a, b, id } = await pair(newID);
  const relays = [], pushed = [], pulled = [];
  a.engine.onRelay = (r) => relays.push(r);
  a.engine.onPushed = (p) => pushed.push(p.version);
  a.engine.onPulled = (c) => pulled.push(c);
  server.relay = "wss://relay.example/";
  a.edit(id, (x) => (x.cards[0].color = 2));
  await a.engine.sync();
  assert.equal(a.engine.relay, "wss://relay.example/");
  assert.deepEqual(relays, ["wss://relay.example/"]);
  assert.deepEqual(pushed, [server.version]);
  assert.deepEqual(pulled, [server.version]);
  assert.ok(a.engine.lastCycle > 0);
  server.relay = "http://not-a-relay";
  await b.engine.sync();
  assert.equal(b.engine.relay, null);
});

test("only WebSockets over TLS, or to this computer, are relays", async () => {
  for (const r of ["wss://relay.example/", "ws://127.0.0.1:58568/", "ws://localhost:58568/"]) assert.ok(validRelay(r), r);
  for (const r of ["ws://relay.example/", "https://relay.example/", "wss:", ""]) assert.ok(!validRelay(r), r);
  const { server, a, id } = await pair(newID);
  server.relay = "ws://relay.example/";
  a.edit(id, (x) => (x.cards[0].color = 2));
  await a.engine.sync();
  assert.equal(a.engine.relay, null);
});

test("an edit syncs in one request", async () => {
  const { a, b, id } = await pair(newID);
  a.edit(id, (x) => (x.cards[0].color = 3));
  a.transport.calls = 0;
  await a.engine.sync();
  assert.equal(a.transport.calls, 1);
  await b.engine.sync();
  assert.equal(b.store.board(id).cards[0].color, 3);
});

test("a device never pulls back what it pushed", async () => {
  const { a, b, id } = await pair(newID);
  const mine = new Set(), got = [];
  for (const m of ["pull", "push"]) {
    const f = a.transport[m].bind(a.transport);
    a.transport[m] = async (...args) => {
      const r = await f(...args);
      for (const x of r.accepted ?? []) mine.add(x.version);
      for (const p of r.records ?? []) got.push(p.version);
      return r;
    };
  }
  a.edit(id, (x) => (x.cards[0].color = 3));
  await a.engine.sync();
  b.edit(id, (x) => (x.cards[0].text = "y"));
  await b.engine.sync();
  a.edit(id, (x) => (x.cards[0].color = 4));
  await a.engine.sync();
  await a.engine.sync();
  assert.ok(mine.size > 0);
  assert.ok(got.length > 0);
  assert.deepEqual(got.filter((v) => mine.has(v)), []);
});

test("what becomes pending during the pull is pushed in the same sync", async () => {
  const { server, a, b, id } = await pair(newID);
  b.edit(id, (x) => (x.cards[0].text = "y"));
  await b.engine.sync();
  let pulled = false, edited = false;
  const pull = a.transport.pull.bind(a.transport);
  a.transport.pull = async (since) => {
    pulled = true;
    return pull(since);
  };
  a.engine.flushLocal = () => {
    if (!pulled || edited) return;
    edited = true;
    a.edit(id, (x) => (x.cards[0].color = 3));
  };
  await a.engine.sync();
  assert.ok(edited);
  assert.deepEqual(a.store.pending(), []);
  a.engine.flushLocal = () => {};
  await b.engine.sync();
  assert.equal(b.store.board(id).cards[0].color, 3);
});

test("a device with an edit pending writes nothing to a restored server", async () => {
  const { server, a, b, id } = await pair(newID);
  const backup = server.snapshot();
  b.edit(id, (x) => (x.cards[0].text = "later"));
  await b.engine.sync();
  server.restore(backup);
  a.edit(id, (x) => (x.cards[0].color = 3));
  const before = server.version;
  const push = a.transport.push.bind(a.transport);
  let first = true;
  a.transport.push = async (...args) => {
    const r = await push(...args);
    if (first) assert.equal(server.version, before);
    first = false;
    return r;
  };
  await a.engine.sync();
  for (const x of [b, a, b, a]) await x.engine.sync();
  for (const x of [a, b]) {
    assert.equal(x.store.board(id).cards[0].color, 3);
    assert.deepEqual(x.store.pending(), []);
  }
});

test("a combined push that brings a full page goes on pulling", async () => {
  const { server, a, b, id } = await pair(newID);
  const other = b.store.createBoard("Big", { cards: Array.from({ length: 600 }, (_, i) => ({ id: newID(), x: 0, y: i * 24, w: 240, text: "t", color: 1 })), lanes: [] });
  await b.engine.sync();
  a.edit(id, (x) => (x.cards[0].color = 3));
  await a.engine.sync();
  assert.equal(a.store.board(other).cards.length, 600);
  assert.equal(a.store.state.cursor, server.version);
});

test("a resync does not combine", async () => {
  const { server, a, id } = await pair(newID);
  const backup = server.snapshot();
  a.edit(id, (x) => (x.cards[0].color = 3));
  await a.engine.sync();
  server.restore(backup);
  a.edit(id, (x) => (x.cards[0].color = 2));
  a.transport.log = [];
  const sinces = [];
  const push = a.transport.push.bind(a.transport);
  a.transport.push = (w, since, epoch) => (sinces.push(since), push(w, since, epoch));
  await a.engine.sync();
  assert.deepEqual(a.transport.log.slice(0, 2), ["push", "pull"]);
  assert.equal(sinces[1], undefined);
  assert.deepEqual(a.store.pending(), []);
});

test("big requests go deflated and small ones plain", async () => {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push(init);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    const t = new HttpTransport("https://example.com/s.php", "sp", "tok");
    const big = [{ id: "a", base: 0, blob: "x".repeat(3000) }];
    await t.push(big, 7);
    await t.push([{ id: "a", base: 0, blob: "y" }]);
    const [first, second] = sent;
    assert.equal(first.headers["Content-Encoding"], "deflate");
    assert.deepEqual(JSON.parse(inflateRawSync(Buffer.from(first.body)).toString()), { writes: big, since: 7 });
    assert.equal(second.headers["Content-Encoding"], undefined);
    assert.equal(second.body, JSON.stringify({ writes: [{ id: "a", base: 0, blob: "y" }] }));
  } finally {
    globalThis.fetch = real;
  }
});

test("a full page that held this push's own write goes on pulling", async () => {
  const { server, a, id } = await pair(newID);
  server.afterWrites = () => {
    server.afterWrites = () => {};
    for (let i = 0; i < 500; i++) server.put(encode(Uint8Array.from({ length: 16 }, (_, j) => (j ? i >> ((j - 1) * 8) : 7))), "AAAA");
  };
  a.edit(id, (x) => (x.cards[0].color = 3));
  await a.engine.sync();
  assert.equal(a.store.state.cursor, server.version);
});

/** What `a` pushes for an edit, as `onPushed` reports it. */
async function pushedBy(a, id, color = 3) {
  let out;
  a.engine.onPushed = (p) => (out = p);
  a.edit(id, (x) => (x.cards[0].color = color));
  await a.engine.sync();
  return out;
}

test("records another device just pushed are applied without a pull", async () => {
  const { server, a, b, id } = await pair(newID);
  const p = await pushedBy(a, id);
  assert.equal(p.epoch, server.epoch);
  assert.deepEqual(p.records.map((r) => r.version), [server.version]);
  const pulled = [];
  b.engine.onPulled = (c) => pulled.push(c);
  const calls = b.transport.calls;
  assert.equal(await b.engine.receivePushed(p), true);
  assert.equal(b.transport.calls, calls);
  assert.equal(b.store.state.cursor, server.version);
  assert.deepEqual(pulled, [server.version]);
  assert.equal(b.store.board(id).cards[0].color, 3);
});

test("pushed records that do not follow on are not applied", async () => {
  const { a, b, id } = await pair(newID);
  const p = await pushedBy(a, id);
  const cursor = b.store.state.cursor, calls = b.transport.log.length;
  const color = b.store.board(id).cards[0].color;
  const second = await pushedBy(a, id, 4);
  for (const bad of [
    { ...p, epoch: "other" },
    { ...second, records: second.records.map((r) => ({ ...r, version: r.version + 5 })) },
    { ...second, records: [...p.records, ...second.records].map((r, i) => ({ ...r, version: r.version + i * 2 })) },
    second,
    { epoch: p.epoch, records: [] },
    { epoch: p.epoch },
  ]) {
    assert.equal(await b.engine.receivePushed(bad), false);
    assert.equal(b.store.state.cursor, cursor);
    assert.equal(b.store.board(id).cards[0].color, color);
  }
  assert.equal(b.transport.log.length, calls);
});

test("an unreadable pushed record is counted as in a pull", async () => {
  const { a, b, id } = await pair(newID);
  const p = await pushedBy(a, id);
  const bad = { ...p, records: [{ ...p.records[0], blob: "AAAA" }] };
  assert.equal(await b.engine.receivePushed(bad), true);
  assert.equal(b.store.state.unreadable, 1);
  assert.equal(b.store.state.cursor, p.version);
});

test("pushed records this device already has still report its cursor", async () => {
  const { a, b, id } = await pair(newID);
  const p = await pushedBy(a, id);
  await b.engine.sync();
  const pulled = [];
  b.engine.onPulled = (c) => pulled.push(c);
  assert.equal(await b.engine.receivePushed(p), true);
  assert.deepEqual(pulled, [b.store.state.cursor]);
});

test("a combined cycle reports the cursor of the page it took before a later round fails", async () => {
  const { server, a, id } = await pair(newID);
  const pulled = [];
  a.engine.onPulled = (c) => pulled.push(c);
  const push = a.transport.push.bind(a.transport);
  let n = 0;
  a.transport.push = async (...args) => {
    if (n++) throw new TransportError("unreachable");
    const r = await push(...args);
    a.edit(id, (x) => (x.cards[0].color = 5));
    return r;
  };
  a.edit(id, (x) => (x.cards[0].color = 3));
  await a.engine.sync();
  assert.equal(n, 2);
  assert.equal(a.engine.status.state, "unreachable");
  assert.deepEqual(pulled, [server.version]);
});

test("big requests go plain where deflate-raw is missing", async () => {
  const sent = [];
  const [realFetch, realStream] = [globalThis.fetch, globalThis.CompressionStream];
  globalThis.fetch = async (url, init) => {
    sent.push(init);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const big = [{ id: "a", base: 0, blob: "x".repeat(3000) }];
  try {
    const t = new HttpTransport("https://example.com/s.php", "sp", "tok");
    delete globalThis.CompressionStream;
    await t.push(big, 7);
    globalThis.CompressionStream = class {
      constructor(format) {
        throw new TypeError(`unsupported ${format}`);
      }
    };
    await t.push(big, 7);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.CompressionStream = realStream;
  }
  assert.equal(sent.length, 2);
  for (const s of sent) {
    assert.equal(s.headers["Content-Encoding"], undefined);
    assert.equal(s.body, JSON.stringify({ writes: big, since: 7 }));
  }
});

test("nothing is pushed while a gesture others follow is under way, and its changes wait for its end", async () => {
  const { a, b, id } = await pair(newID);
  let busy = true;
  a.engine.holdBack = () => busy;
  a.edit(id, (x) => (x.cards[0].color = 3));
  a.transport.log = [];
  await a.engine.sync();
  assert.ok(!a.transport.log.includes("push"));
  busy = false;
  await a.engine.sync();
  assert.deepEqual(a.transport.log.slice(-1), ["push"]);
  await b.engine.sync();
  assert.equal(b.store.board(id).cards[0].color, 3);
});

test("a stalled request is sent again at once, twice, then backs off", async () => {
  const { a, id } = await pair(newID);
  a.edit(id, (x) => (x.cards[0].color = 3));
  a.transport.failure = "stalled";
  a.transport.calls = 0;
  await a.engine.sync();
  assert.equal(a.transport.calls, 3);
  assert.equal(a.engine.status.state, "unreachable");
  a.transport.failure = null;
  await a.engine.sync();
  assert.equal(a.transport.calls, 3);
  // the network came back: no waiting out the back-off
  await a.engine.retryNow();
  assert.equal(a.engine.status.state, "synced");
  assert.deepEqual(a.store.pending(), []);
});

test("a back-off waits on the steady clock: a wall clock set back holds back no retry", async () => {
  const { a, id } = await pair(newID);
  let wall = 1_000_000, steady = 0;
  const engine = new SyncEngine(a.store, { transport: () => a.transport, now: () => wall, clock: () => steady });
  a.transport.online = false;
  a.edit(id, (x) => R.addCard(x, 0, 0));
  await engine.sync();
  assert.equal(engine.status.state, "offline");
  a.transport.online = true;
  wall -= 3_600_000;
  steady += 6_000;
  await engine.sync();
  assert.deepEqual(a.store.pending(), []);
});
