// diag.php: what a device's app recorded, sent by a device of the space and read back with the space's own token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { deflateRawSync } from "node:zlib";

const SYNC = process.env.BREEZY_URL;
const DIAG = SYNC.replace(/sync\.php$/, "diag.php");
const rand = (n) => Buffer.from(randomBytes(n)).toString("base64url");

async function call(url, space, token, method = "GET", query = {}, body, headers = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries({ space, ...query })) u.searchParams.set(k, v);
  const res = await fetch(u, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body });
  const text = await res.text();
  return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
}

/** A space sync.php knows, made by its first write. */
async function space() {
  const s = rand(16), token = rand(32);
  assert.equal((await call(SYNC, s, token, "POST", {}, JSON.stringify({ writes: [{ id: rand(16), base: 0, blob: rand(40) }] }))).status, 200);
  const send = (why, recording = { schema: 1, entries: [[1, "input", "tap"]] }, t = token) => call(DIAG, s, t, "POST", {}, JSON.stringify({ why, recording }));
  return { s, token, send, get: (query = {}, t = token) => call(DIAG, s, t, "GET", query) };
}

test("a recording sent by a device of the space is listed and read back as sent", async () => {
  const sp = await space();
  const recording = { schema: 1, origin: 5, entries: [[1, "decision", "reveal", { path: "card", why: "no caret" }]] };
  const sent = await sp.send("asked", recording);
  assert.equal(sent.status, 200);
  const list = (await sp.get()).body.recordings;
  assert.equal(list.length, 1);
  assert.equal(list[0].id, sent.body.id);
  assert.equal(list[0].why, "asked");
  assert.deepEqual((await sp.get({ id: sent.body.id })).body, recording);
});

test("a deflated recording is taken as sync.php takes a deflated push", async () => {
  const sp = await space();
  const body = deflateRawSync(JSON.stringify({ why: "error", recording: { schema: 1, entries: [] } }));
  assert.equal((await call(DIAG, sp.s, sp.token, "POST", {}, body, { "Content-Encoding": "deflate" })).status, 200);
});

test("a wrong token can neither send nor read, and a space nobody made takes nothing", async () => {
  const sp = await space();
  assert.equal((await sp.send("asked", undefined, rand(32))).status, 401);
  assert.equal((await sp.get({}, rand(32))).status, 401);
  assert.equal((await call(DIAG, rand(16), rand(32), "POST", {}, JSON.stringify({ why: "asked", recording: {} }))).status, 401);
});

test("only the reasons an app sends for, and only a recording, are taken", async () => {
  const sp = await space();
  assert.equal((await sp.send("because")).status, 400);
  assert.equal((await call(DIAG, sp.s, sp.token, "POST", {}, JSON.stringify({ why: "asked", recording: "x" }))).status, 400);
});

test("a recording over 512 KB is refused", async () => {
  const sp = await space();
  assert.equal((await sp.send("asked", { schema: 1, pad: "x".repeat(512 * 1024) })).status, 413);
});

test("a space sends at most 20 in an hour", async () => {
  const sp = await space();
  for (let i = 0; i < 20; i++) assert.equal((await sp.send("error")).status, 200, `send ${i + 1}`);
  assert.equal((await sp.send("error")).status, 429);
});

test("a space keeps its newest 100 recordings, none older than 30 days", async () => {
  const sp = await space();
  // 120 sent over the past 20 days and 5 sent 40 days ago, put straight into the database as the hourly bound would
  // refuse them
  execFileSync("php", ["-r", `
    $c = require getenv("BREEZY_CONFIG");
    $db = new PDO($c["dsn"], $c["user"] ?? null, $c["password"] ?? null);
    $st = $db->prepare("INSERT INTO diagnostics (space, id, at, why, data) VALUES (?, ?, ?, 'error', '{}')");
    $ats = array_merge(array_map(fn($i) => time() - 7200 - $i * 4 * 3600, range(0, 119)), array_fill(0, 5, time() - 40 * 86400));
    foreach ($ats as $at) {
      $st->bindValue(1, base64_decode(strtr($argv[1], "-_", "+/") . "=="), PDO::PARAM_LOB);
      $st->bindValue(2, random_bytes(16), PDO::PARAM_LOB);
      $st->bindValue(3, $at, PDO::PARAM_INT);
      $st->execute();
    }`, "--", sp.s]);
  assert.equal((await sp.send("asked")).status, 200);
  const list = (await sp.get()).body.recordings;
  assert.equal(list.length, 100);
  assert.equal(list[0].why, "asked", "the one just sent is kept");
  assert.ok(list.every((r) => r.at > Date.now() / 1000 - 30 * 86400));
});

test("a space lists its own recordings, not another's", async () => {
  const a = await space(), b = await space();
  await a.send("asked");
  assert.deepEqual((await b.get()).body.recordings, []);
  assert.equal((await b.get({ id: (await a.get()).body.recordings[0].id })).status, 404);
});
