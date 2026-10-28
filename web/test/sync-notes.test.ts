// What the sync engine decided, noted for the app's recorder: each push and what came of it, each failure and how long
// it backs off, each cycle it skipped and why, and what was left waiting, for a sync that never settled to say why.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pair } from "./helpers/fake-server.ts";
import type { SyncEngine } from "../sync/engine.ts";
import { newID } from "../rules.ts";
import * as R from "../rules.ts";

const noting = (engine: SyncEngine) => {
  const notes: [string, Record<string, unknown> | undefined][] = [];
  engine.note = (what, data) => notes.push([what, data]);
  return notes;
};

test("a push is noted with what it sent and what came of it, and the cycle with what is left waiting", async () => {
  const { a, id } = await pair(newID);
  const notes = noting(a.engine);
  a.edit(id, (x) => R.addCard(x, 0, 0));
  await a.engine.sync();
  const push = notes.find(([w]) => w === "push");
  assert.deepEqual(push?.[1], { writes: 1, combined: true });
  const pushed = notes.find(([w]) => w === "pushed");
  assert.equal(pushed?.[1]?.accepted, 1);
  assert.equal(pushed?.[1]?.refused, 0);
  assert.equal(typeof pushed?.[1]?.ms, "number");
  assert.deepEqual(notes.at(-1), ["synced", { waiting: 0 }]);
});

test("a cycle that changed nothing is noted once, not on every poll", async () => {
  const { a, id } = await pair(newID);
  const notes = noting(a.engine);
  a.edit(id, (x) => R.addCard(x, 0, 0));
  for (let i = 0; i < 5; i++) await a.engine.sync();
  assert.deepEqual(notes.map(([w]) => w), ["push", "pushed", "synced"]);
});

test("a failure is noted with its kind and how long it backs off, and a cycle it then skips with why", async () => {
  const { a, id } = await pair(newID);
  const notes = noting(a.engine);
  // a clock that moves on each read, as a busy runner's did between two reads: the note said 4998
  let t = 0;
  a.engine.clock = () => (t += 1);
  a.transport.online = false;
  a.edit(id, (x) => R.addCard(x, 0, 0));
  await a.engine.sync();
  assert.deepEqual(notes.find(([w]) => w === "failed")?.[1], { kind: "offline", failures: 1, backoff: 5000, waiting: 1 });
  await a.engine.sync();
  assert.equal(notes.at(-1)?.[0], "skipped");
  assert.equal(notes.at(-1)?.[1]?.why, "backing off");
});

test("a change held back by a gesture under way is noted, as its push waits for the gesture's end", async () => {
  const { a, id } = await pair(newID);
  const notes = noting(a.engine);
  a.engine.holdBack = () => true;
  a.edit(id, (x) => R.addCard(x, 0, 0));
  a.engine.changed();
  assert.deepEqual(notes.at(-1), ["held back", { why: "gesture" }]);
});
