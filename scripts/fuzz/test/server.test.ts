import { test } from "node:test";
import assert from "node:assert/strict";
import { freePort, Server } from "../server.ts";

test("a pull from a new space answers with the relay, and a restore gives a new epoch", async () => {
  const s = await Server.start("ws://127.0.0.1:9/");
  try {
    const space = "A".repeat(22), token = "B".repeat(43);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const pull = () => s.send({ method: "GET", url: `${s.url}?space=${space}&since=0`, headers, body: null });
    const empty = await pull();
    assert.equal(empty.status, 200, empty.body.toString());
    assert.equal(JSON.parse(empty.body.toString()).relay, "ws://127.0.0.1:9/");
    const write = { id: "C".repeat(22), base: 0, blob: "D".repeat(40) };
    const pushed = await s.send({ method: "POST", url: `${s.url}?space=${space}`, headers, body: Buffer.from(JSON.stringify({ writes: [write] })) });
    assert.equal(pushed.status, 200, pushed.body.toString());
    const before = JSON.parse((await pull()).body.toString()).epoch;
    s.backup();
    s.restore();
    const after = JSON.parse((await pull()).body.toString());
    assert.notEqual(after.epoch, before);
    assert.equal(after.records.length, 1);
  } finally {
    s.stop();
  }
});

test("a port another PHP took before this one bound is left for a free one, and this PHP answers", async () => {
  const other = await Server.start("ws://127.0.0.1:9/");
  let drawn = 0;
  const s = await Server.start("ws://127.0.0.1:9/", () => (drawn++ ? freePort() : Promise.resolve(other.port)));
  try {
    assert.equal(drawn, 2);
    assert.notEqual(s.port, other.port);
    other.stop();
    const answer = await s.send({ method: "GET", url: `${s.url}?space=${"A".repeat(22)}&since=0`, headers: { authorization: `Bearer ${"B".repeat(43)}` }, body: null });
    assert.equal(answer.status, 200, answer.body.toString());
  } finally {
    other.stop();
    s.stop();
  }
});

test("a request PHP did not take says how PHP ended and what it logged", async () => {
  const s = await Server.start("ws://127.0.0.1:9/");
  const ended = new Promise((r) => s.php.once("exit", r));
  s.stop();
  await ended;
  await assert.rejects(s.send({ method: "GET", url: s.url, headers: {}, body: null }), /ECONNREFUSED.*php ended by SIGTERM.*Development Server/s);
});
