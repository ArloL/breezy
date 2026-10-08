import { test } from "node:test";
import assert from "node:assert/strict";
import { Saver } from "../sync/saver.js";

test("schedule waits for the delay, once", async () => {
  let saves = 0;
  const s = new Saver(async () => saves++, 20);
  s.schedule();
  s.schedule();
  assert.equal(saves, 0);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(saves, 1);
});

test("flush writes at once what is waiting", async () => {
  let saves = 0;
  const s = new Saver(async () => saves++, 10_000);
  s.schedule();
  await s.flush();
  assert.equal(saves, 1);
  await s.flush();
  assert.equal(saves, 1);
});

test("a disabled saver writes nothing", async () => {
  let saves = 0;
  const s = new Saver(async () => saves++, 10);
  s.enabled = false;
  s.schedule();
  await s.flush();
  assert.equal(saves, 0);
});
