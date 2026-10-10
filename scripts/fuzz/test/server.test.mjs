import { test } from "node:test";
import assert from "node:assert/strict";
import { Server } from "../server.mjs";

test("a pull from a new space answers with the relay, and a restore gives a new epoch", async () => {
  const s = await Server.start("ws://127.0.0.1:9/");
  try {
    const space = "A".repeat(22), token = "B".repeat(43);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const pull = () => s.send({ method: "GET", url: `${s.url}?space=${space}&since=0`, headers, body: null });
    const empty = await pull();
    assert.equal(empty.status, 200, empty.body.toString());
    assert.equal(JSON.parse(empty.body).relay, "ws://127.0.0.1:9/");
    const write = { id: "C".repeat(22), base: 0, blob: "D".repeat(40) };
    const pushed = await s.send({ method: "POST", url: `${s.url}?space=${space}`, headers, body: Buffer.from(JSON.stringify({ writes: [write] })) });
    assert.equal(pushed.status, 200, pushed.body.toString());
    const before = JSON.parse((await pull()).body).epoch;
    s.backup();
    s.restore();
    const after = JSON.parse((await pull()).body);
    assert.notEqual(after.epoch, before);
    assert.equal(after.records.length, 1);
  } finally {
    s.stop();
  }
});
