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

test("a failed save is reported, and tried again on the next flush", async () => {
  let fail = true;
  const errors = [];
  const s = new Saver(async () => {
    if (fail) throw new Error("closed");
  }, 10_000);
  s.onError = (error) => errors.push(error.message);
  s.schedule();
  await s.flush();
  assert.deepEqual(errors, ["closed"]);
  assert.equal(s.failed, true);
  fail = false;
  await s.flush();
  assert.equal(s.failed, false);
  assert.deepEqual(errors, ["closed"]);
});
