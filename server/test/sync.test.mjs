import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

const URL_ = process.env.BREEZY_URL;
const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const rand = (n) => b64(randomBytes(n));

/** Gives `space` a new epoch, as the README says to after restoring a backup; needs BREEZY_CONFIG. */
function renewEpoch(space) {
  execFileSync("php", ["-r", `
    $c = require getenv("BREEZY_CONFIG");
    $db = new PDO($c["dsn"], $c["user"] ?? null, $c["password"] ?? null);
    $st = $db->prepare("UPDATE spaces SET epoch = ? WHERE id = ?");
    $st->bindValue(1, random_bytes(16), PDO::PARAM_LOB);
    $st->bindValue(2, base64_decode(strtr($argv[1], "-_", "+/") . "=="), PDO::PARAM_LOB);
    $st->execute();`, space]);
}

function client(space = rand(16), token = rand(32)) {
  const call = async (method, query = {}, body, headers = {}) => {
    const url = new URL(URL_);
    for (const [k, v] of Object.entries({ space, ...query })) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body && (typeof body === "string" ? body : JSON.stringify(body)),
    });
    const json = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
    return { status: res.status, body: json, headers: res.headers };
  };
  return { space, token, call, pull: (since = 0) => call("GET", { since }), push: (writes) => call("POST", {}, { writes }) };
}

test("the first write makes the space, and a pull gets it back", async () => {
  const c = client();
  const w = { id: rand(16), base: 0, blob: rand(40) };
  const pushed = await c.push([w]);
  assert.equal(pushed.status, 200);
  const { epoch } = pushed.body;
  assert.match(epoch, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(pushed.body, { accepted: [{ id: w.id, version: 1 }], refused: [], epoch });
  assert.deepEqual((await c.pull()).body, { records: [{ id: w.id, version: 1, blob: w.blob }], cursor: 1, epoch });
  assert.deepEqual((await c.pull(1)).body, { records: [], cursor: 1, epoch });
});

test("a write on a stale base is refused with what is stored", async () => {
  const c = client();
  const id = rand(16), first = rand(40);
  await c.push([{ id, base: 0, blob: first }]);
  await c.push([{ id, base: 1, blob: rand(40) }]);
  const r = await c.push([{ id, base: 1, blob: rand(40) }]);
  assert.deepEqual(r.body.accepted, []);
  assert.equal(r.body.refused[0].version, 2);
});

test("a wrong token can neither read nor write", async () => {
  const c = client();
  await c.push([{ id: rand(16), base: 0, blob: rand(40) }]);
  const other = client(c.space);
  assert.equal((await other.pull()).status, 401);
  assert.equal((await other.push([{ id: rand(16), base: 0, blob: rand(40) }])).status, 401);
  assert.equal((await c.call("GET", {}, undefined, { Authorization: "Bearer nope" })).status, 401);
});

test("an unknown space reads as empty", async () => {
  assert.deepEqual((await client().pull(7)).body, { records: [], cursor: 7, epoch: null });
});

test("a space keeps its epoch, which no other space has", async () => {
  const c = client(), d = client();
  const epoch = (await c.push([{ id: rand(16), base: 0, blob: rand(40) }])).body.epoch;
  assert.equal((await c.push([{ id: rand(16), base: 0, blob: rand(40) }])).body.epoch, epoch);
  assert.equal((await c.pull()).body.epoch, epoch);
  assert.notEqual((await d.push([{ id: rand(16), base: 0, blob: rand(40) }])).body.epoch, epoch);
});

test("records written before the epoch changed are stale", { skip: !process.env.BREEZY_CONFIG && "needs BREEZY_CONFIG" }, async () => {
  const c = client();
  const old = { id: rand(16), base: 0, blob: rand(40) };
  await c.push([old]);
  renewEpoch(c.space);
  const fresh = { id: rand(16), base: 0, blob: rand(40) };
  await c.push([fresh]);
  assert.deepEqual((await c.pull()).body.records, [
    { id: old.id, version: 1, blob: old.blob, stale: true },
    { id: fresh.id, version: 2, blob: fresh.blob },
  ]);
  assert.deepEqual((await c.push([{ id: old.id, base: 0, blob: rand(40) }])).body.refused, [{ id: old.id, version: 1, blob: old.blob, stale: true }]);
  assert.deepEqual((await c.push([{ id: fresh.id, base: 0, blob: rand(40) }])).body.refused, [{ id: fresh.id, version: 2, blob: fresh.blob }]);
});

test("pulls come in pages of 500", async () => {
  const c = client();
  await c.push(Array.from({ length: 501 }, () => ({ id: rand(16), base: 0, blob: rand(40) })));
  const first = await c.pull();
  assert.equal(first.body.records.length, 500);
  assert.equal(first.body.cursor, 500);
  assert.equal((await c.pull(500)).body.records.length, 1);
});

test("a record the server lost is written again", async () => {
  const c = client();
  const id = rand(16);
  assert.deepEqual((await c.push([{ id, base: 5, blob: rand(40) }])).body.accepted, [{ id, version: 1 }]);
});

test("what is too big is refused", async () => {
  const c = client();
  assert.equal((await c.push([{ id: rand(16), base: 0, blob: rand(65_537) }])).status, 413);
  const writes = Array.from({ length: 20 }, () => ({ id: rand(16), base: 0, blob: rand(60_000) }));
  assert.equal((await c.push(writes)).status, 413);
});

test("malformed requests are refused", async () => {
  const c = client();
  assert.equal((await client("short").pull()).status, 400);
  assert.equal((await c.push([{ id: "short", base: 0, blob: rand(40) }])).status, 400);
  assert.equal((await c.push([{ id: rand(16), base: -1, blob: rand(40) }])).status, 400);
  assert.equal((await c.push([{ id: rand(16), base: 0, blob: rand(8) }])).status, 400);
  assert.equal((await c.call("POST", {}, "not json")).status, 400);
  assert.equal((await c.call("GET", { since: "x" })).status, 400);
});

test("only the app's pages may call from a browser", async () => {
  const c = client();
  const ok = await c.call("OPTIONS", {}, undefined, { Origin: "https://arlol.github.io" });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://arlol.github.io");
  const other = await c.call("OPTIONS", {}, undefined, { Origin: "https://example.com" });
  assert.equal(other.headers.get("access-control-allow-origin"), null);
});

test("the web app's engine syncs through the server", async () => {
  const { Store } = await import("../../web/sync/store.js");
  const { SyncEngine } = await import("../../web/sync/engine.js");
  const a = new Store();
  const invite = a.startSyncing(URL_);
  const id = a.createBoard("Over HTTP");
  const ea = new SyncEngine(a);
  await ea.sync();
  assert.equal(ea.status.state, "synced");
  const b = new Store();
  b.join(invite);
  await new SyncEngine(b).sync();
  assert.equal(b.title(id), "Over HTTP");
});
