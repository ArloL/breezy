import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { deflateRawSync } from "node:zlib";

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
      body: body && (typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)),
    });
    const json = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
    return { status: res.status, body: json, headers: res.headers };
  };
  return { space, token, call, pull: (since = 0) => call("GET", { since }), push: (writes) => call("POST", {}, { writes }), pushSince: (writes, since) => call("POST", {}, { writes, since }) };
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
  const ok = await c.call("OPTIONS", {}, undefined, { Origin: "https://breezy.k5d.de" });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://breezy.k5d.de");
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

const write = (base = 0) => ({ id: rand(16), base, blob: rand(40) });

test("a push with since answers with what others wrote", async () => {
  const a = client(), b = client(a.space, a.token);
  const first = [write(), write()];
  await a.push(first);
  const r = await b.pushSince([write()], 0);
  assert.deepEqual(r.body.records.map((x) => x.version), [1, 2]);
  assert.deepEqual(r.body.records.map((x) => x.id), first.map((x) => x.id));
  assert.equal(r.body.cursor, 3);
});

test("a push with since answers in pages of 500", async () => {
  const a = client(), b = client(a.space, a.token);
  await a.push(Array.from({ length: 300 }, () => write()));
  await a.push(Array.from({ length: 300 }, () => write()));
  const r = await b.pushSince([write()], 0);
  assert.equal(r.body.records.length, 500);
  assert.equal(r.body.cursor, r.body.records[499].version);
});

test("a refused write comes back once as the stored record", async () => {
  const c = client();
  const w = write();
  await c.push([w]);
  const r = await c.pushSince([{ ...w, base: 0, blob: rand(40) }], 0);
  assert.equal(r.body.refused.length, 1);
  assert.deepEqual(r.body.records, [{ id: w.id, version: 1, blob: w.blob }]);
  assert.equal(r.body.cursor, 1);
});

test("a push without since answers as before", async () => {
  const r = await client().push([write()]);
  assert.deepEqual(Object.keys(r.body).sort(), ["accepted", "epoch", "refused"]);
});

test("a bad since is refused", async () => {
  const c = client();
  assert.deepEqual((await c.pushSince([write()], -1)).body, { error: "since" });
  assert.equal((await c.pushSince([write()], "x")).status, 400);
});

test("a push naming another epoch writes nothing and names the current one", async () => {
  const c = client();
  const { epoch } = (await c.push([write()])).body;
  const r = await c.call("POST", {}, { writes: [write()], since: 0, epoch: rand(16) });
  assert.deepEqual(r.body, { accepted: [], refused: [], epoch });
  assert.equal((await c.pull()).body.records.length, 1);
  const ok = await c.call("POST", {}, { writes: [write()], since: 0, epoch });
  assert.equal(ok.body.accepted.length, 1);
});

test("a push naming an epoch does not create a space", async () => {
  const c = client();
  const r = await c.call("POST", {}, { writes: [write()], since: 0, epoch: rand(16) });
  assert.deepEqual(r.body, { accepted: [], refused: [], epoch: null });
  assert.deepEqual((await c.pull()).body, { records: [], cursor: 0, epoch: null });
});

test("a malformed epoch is refused", async () => {
  const r = await client().call("POST", {}, { writes: [write()], epoch: "x" });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { error: "epoch" });
});

test("answers are gzipped for clients that ask", async () => {
  const c = client();
  await c.push([write()]);
  const url = new URL(URL_);
  url.searchParams.set("space", c.space);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${c.token}`, "Accept-Encoding": "gzip" } });
  assert.equal(res.headers.get("content-encoding"), "gzip");
  assert.deepEqual(await res.json(), (await c.pull()).body);
});

test("deflated requests are inflated", async () => {
  const c = client();
  const deflate = { "Content-Encoding": "deflate" };
  const w = write();
  const ok = await c.call("POST", {}, deflateRawSync(JSON.stringify({ writes: [w] })), deflate);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.accepted, [{ id: w.id, version: 1 }]);
  const big = JSON.stringify({ writes: [], pad: "a".repeat(1_048_577) });
  assert.equal((await c.call("POST", {}, deflateRawSync(big), deflate)).status, 413);
  assert.equal((await c.call("POST", {}, Buffer.from("garbage in, garbage out"), deflate)).status, 400);
});

test("a deflate bomb is refused before it fills memory", async () => {
  const bomb = deflateRawSync(Buffer.alloc(200_000_000));
  assert.ok(bomb.length < 250_000, `${bomb.length} B`);
  assert.equal((await client().call("POST", {}, bomb, { "Content-Encoding": "deflate" })).status, 413);
});
