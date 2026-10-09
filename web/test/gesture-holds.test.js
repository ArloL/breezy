import { test } from "node:test";
import assert from "node:assert/strict";
import { GestureHolds } from "../sync/gesture-holds.js";

/** Syncs that end when the test says. */
function syncs() {
  const waiting = [];
  return { waiting, sync: () => new Promise((r) => waiting.push(r)), end: (i) => waiting[i]() };
}

test("a finish lets go only after its push", async () => {
  const holds = new GestureHolds(), s = syncs();
  const log = [];
  const done = holds.finish("S", { flush: () => log.push("flush"), sync: s.sync, busy: () => false, release: () => log.push("release") });
  assert.deepEqual(log, ["flush"]);
  s.end(0);
  await done;
  assert.deepEqual(log, ["flush", "release"]);
});

test("a gesture ending while an earlier finish syncs is pushed, and only the latest lets go", async () => {
  const holds = new GestureHolds(), s = syncs();
  let flushed = 0, released = 0;
  const finish = () => holds.finish("S", { flush: () => flushed++, sync: s.sync, busy: () => false, release: () => released++ });
  const first = finish();
  const second = finish();
  assert.equal(flushed, 2);
  assert.equal(s.waiting.length, 2);
  s.end(0);
  await first;
  assert.equal(released, 0);
  s.end(1);
  await second;
  assert.equal(released, 1);
});

test("a gesture cancelled before any change still lets go", async () => {
  const holds = new GestureHolds();
  let released = false;
  await holds.finish("S", { flush: () => {}, sync: async () => {}, busy: () => false, release: () => (released = true) });
  assert.ok(released);
});

test("a finish keeps the holds while another board of the space is in a gesture", async () => {
  const holds = new GestureHolds();
  let busy = true, released = 0;
  const release = () => released++;
  await holds.finish("S", { flush: () => {}, sync: async () => {}, busy: () => busy, release });
  assert.equal(released, 0);
  holds.sweep("S", { holding: true, busy, release });
  holds.sweep("S", { holding: true, busy, release });
  assert.equal(released, 0);
  busy = false;
  holds.sweep("S", { holding: true, busy, release });
  holds.sweep("S", { holding: true, busy, release });
  assert.equal(released, 1);
});

test("holds no gesture or finish explains go on the second tick", async () => {
  const holds = new GestureHolds(), s = syncs();
  let released = 0;
  const release = () => released++;
  holds.sweep("S", { holding: true, busy: false, release });
  assert.equal(released, 0);
  holds.sweep("S", { holding: true, busy: false, release });
  assert.equal(released, 1);
  holds.sweep("S", { holding: false, busy: false, release });
  holds.sweep("S", { holding: false, busy: false, release });
  assert.equal(released, 1);

  const done = holds.finish("S", { flush: () => {}, sync: s.sync, busy: () => true, release: () => {} });
  for (let i = 0; i < 3; i++) holds.sweep("S", { holding: true, busy: false, release });
  assert.equal(released, 1);
  s.end(0);
  await done;
  holds.sweep("S", { holding: true, busy: false, release });
  holds.sweep("S", { holding: true, busy: false, release });
  assert.equal(released, 2);
});
