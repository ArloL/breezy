import { test } from "node:test";
import assert from "node:assert/strict";
import { Saver } from "../sync/saver.ts";

test("what a task schedules is written once, as the task ends rather than on a timer", async () => {
  let saves = 0;
  const s = new Saver(async () => saves++);
  s.schedule();
  s.schedule();
  assert.equal(saves, 0);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(saves, 1);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(saves, 1);
});

test("what is scheduled during a write is written once that write is done", async () => {
  const done: (() => void)[] = [];
  let saves = 0;
  const s = new Saver(() => {
    saves++;
    return new Promise<void>((r) => done.push(r));
  });
  s.schedule();
  await new Promise((r) => setTimeout(r, 0));
  s.schedule();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(saves, 1);
  done[0]();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(saves, 2);
});

test("flush writes at once what is waiting", async () => {
  let saves = 0;
  const s = new Saver(async () => saves++);
  s.schedule();
  await s.flush();
  assert.equal(saves, 1);
  await s.flush();
  assert.equal(saves, 1);
});

test("a disabled saver writes nothing", async () => {
  let saves = 0;
  const s = new Saver(async () => saves++);
  s.enabled = false;
  s.schedule();
  await s.flush();
  assert.equal(saves, 0);
});

test("a failed save is reported, and tried again on the next flush", async () => {
  let fail = true;
  const errors: string[] = [];
  const s = new Saver(async () => {
    if (fail) throw new Error("closed");
  });
  s.onError = (error) => errors.push((error as Error).message);
  s.schedule();
  await s.flush();
  assert.deepEqual(errors, ["closed"]);
  assert.equal(s.failed, true);
  fail = false;
  await s.flush();
  assert.equal(s.failed, false);
  assert.deepEqual(errors, ["closed"]);
});
