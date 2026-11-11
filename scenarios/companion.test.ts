// idb's companions an iPhone's boot outlived: a companion stays alive when its iPhone goes down, holding the dtuhidd
// connection of the boot it met, and idb reused it after the next boot, so every touch failed with `IdbException: The
// dtuhidd connection … has been invalidated`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropStaleCompanions, staleCompanions } from "./ios.ts";

setTimeout(() => process.exit(1), 30_000).unref();

const U = "C2D47311-0264-4C5C-9878-C5D6E427BCCE", OTHER = "008EBF68-B1C0-4D29-B3D7-77846D174CD8";
const companion = (pid: number, at: string, udid = U) =>
  `${String(pid).padStart(5)} ${at}     /opt/homebrew/bin/idb_companion --udid ${udid} --grpc-domain-sock /tmp/idb/${udid}_companion.sock --only simulator`;
const launchd = (at: string, udid = U) => ` 2362 ${at}     launchd_sim /Users/a/Library/Developer/CoreSimulator/Devices/${udid}/data/var/run/launchd_bootstrap.plist`;

test("a companion started before its iPhone's boot is stale; one after it, another iPhone's, or one with its iPhone down is not", () => {
  // as `ps -axo pid=,lstart=,command=` showed them after the iPhone was shut down and booted again behind the harness
  const ps = [
    companion(1974, "Wed Nov 11 11:45:36 2026"),
    companion(2500, "Wed Nov 11 11:46:20 2026"),
    companion(71155, "Wed Nov 11 11:23:00 2026", OTHER),
    launchd("Wed Nov 11 11:45:56 2026"),
    "  900 Wed Nov 11 09:00:00 2026     grep idb_companion --udid " + U,
  ].join("\n");
  assert.deepEqual(staleCompanions(ps, U), [1974]);
  assert.deepEqual(staleCompanions(ps, OTHER), []);
  assert.deepEqual(staleCompanions(ps.split("\n").filter((l) => !l.includes("launchd_sim")).join("\n"), U), []);
  // a day of the month padded, as ps pads it
  assert.deepEqual(staleCompanions([companion(1, "Thu Nov  5 09:59:59 2026"), launchd("Thu Nov  5 10:00:00 2026")].join("\n"), U), [1]);
});

test("a stale companion is ended and forgotten, and other iPhones' companions are kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "breezy-idb-")), state = join(dir, "state"), sock = join(dir, "sock");
  const old = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const ended = new Promise((r) => old.on("exit", r));
  try {
    writeFileSync(sock, "");
    const other = { udid: OTHER, is_local: true, pid: process.pid, path: sock };
    writeFileSync(state, JSON.stringify([{ udid: U, is_local: true, pid: old.pid, path: sock }, other]));
    const ps = [companion(old.pid!, "Wed Nov 11 11:45:36 2026"), launchd("Wed Nov 11 11:45:56 2026")].join("\n");
    assert.deepEqual(await dropStaleCompanions(U, { state, ps: () => ps }), [old.pid]);
    await ended;
    assert.deepEqual(JSON.parse(readFileSync(state, "utf8")), [other]);
  } finally {
    old.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a companion that has ended is forgotten, as before", async () => {
  const dir = mkdtempSync(join(tmpdir(), "breezy-idb-")), state = join(dir, "state");
  try {
    writeFileSync(state, JSON.stringify([{ udid: U, is_local: true, pid: 2 ** 22 + 1, path: "/nowhere" }]));
    assert.deepEqual(await dropStaleCompanions(U, { state, ps: () => "" }), []);
    assert.deepEqual(JSON.parse(readFileSync(state, "utf8")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
