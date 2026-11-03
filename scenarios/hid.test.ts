// scripts/sim-hid.py's start as a case's timeline reads it, as a start past its limit said nothing of where it stood, and
// its child ran on: on CI's runner the first start of a job takes 14 to 39 s, and once took over 60.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hidLog, SimHid } from "./ios.ts";

const node = (script: string): [string, string[]] => [process.execPath, ["--eval", script]];
const until = async (ok: () => boolean) => {
  for (const end = Date.now() + 5000; !ok() && Date.now() < end; await new Promise((r) => setTimeout(r, 20)));
  assert.ok(ok(), JSON.stringify(hidLog));
};

test("a start's phases join the timeline as they happen, each on the wall clock", async () => {
  hidLog.length = 0;
  const t0 = Date.now();
  const h = await SimHid.start("U", { ms: 5000, command: node(`console.error("python started"); console.error("idb imported"); console.log('{"ok":true,"ms":0}'); setInterval(() => {}, 1000)`) });
  await until(() => hidLog.some(([, , what]) => what === "idb imported"));
  h.stop();
  assert.deepEqual(hidLog.slice(0, 3).map(([, source, what]) => [source, what]), [["sim-hid", "started"], ["sim-hid", "python started"], ["sim-hid", "idb imported"]]);
  assert.ok(hidLog.every(([at]) => at >= t0 && at <= Date.now()));
});

test("a start past its limit fails naming the limit, and its child does not run on", async () => {
  hidLog.length = 0;
  await assert.rejects(SimHid.start("U", { ms: 200, command: node("setInterval(() => {}, 1000)") }), /did not answer in 0\.2 s/);
  await until(() => hidLog.some(([, , what]) => /^exited/.test(what)));
});

test("a long line is cut, as idb's state of its companions runs on", async () => {
  hidLog.length = 0;
  const h = await SimHid.start("U", { ms: 5000, command: node(`console.error("x".repeat(5000)); console.log('{"ok":true,"ms":0}'); setInterval(() => {}, 1000)`) });
  await until(() => hidLog.some(([, , what]) => what.startsWith("xxx")));
  h.stop();
  assert.ok(hidLog.every(([, , what]) => what.length <= 300));
});
