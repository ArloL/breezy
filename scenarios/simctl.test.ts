// Each simctl call noted for a case's timeline: how long it took, and how it failed, as an iPhone's harness failure is
// read from the call that timed out and the slow ones before it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { bootsWithout, bootWithout, iosLogLines, simctl, simctlAsync, simctlFailures, simctlLog, stopPush } from "./ios.ts";

setTimeout(() => process.exit(1), 60_000).unref();

/** Runs body with `xcrun` on PATH being this shell script. */
async function withXcrun(script: string, body: () => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "breezy-xcrun-")), path = process.env.PATH;
  writeFileSync(join(dir, "xcrun"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(dir, "xcrun"), 0o755);
  process.env.PATH = `${dir}${delimiter}${path}`;
  try {
    await body();
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the simulator's errors and faults join the timeline on the wall clock, the rest stays in its file", () => {
  const log = [
    "Timestamp               Ty Process[PID:TID]",
    "2026-10-28 11:53:20.123 Df SpringBoard[101:202] [com.apple.SpringBoard:Launch] launching com.apple.mobilesafari",
    "2026-10-28 11:53:21.456 E  SpringBoard[101:202] (FrontBoard) openURL timed out for com.apple.mobilesafari",
    "2026-10-28 11:53:22.789 F  MobileSafari[303:404] crashed",
  ].join("\n");
  const lines = iosLogLines(log, "iPhone");
  assert.equal(lines.length, 2);
  assert.equal(lines[0]![0], new Date(2026, 9, 28, 11, 53, 21, 456).getTime());
  assert.equal(lines[0]![1], "iPhone log");
  assert.equal(lines[0]![2], "E SpringBoard: (FrontBoard) openURL timed out for com.apple.mobilesafari");
  assert.match(lines[1]![2], /^F MobileSafari: crashed$/);
});

test("a call is noted with how long it took", () => {
  simctlLog.length = 0;
  const out = simctl(["list", "devices"], { timeout: 1000 }, () => "{}");
  assert.equal(out, "{}");
  assert.equal(simctlLog.length, 1);
  assert.match(simctlLog[0]![2], /^simctl list devices: \d+ ms$/);
  assert.equal(simctlLog[0]![1], "simctl");
});

test("a call that fails is noted with its exit and what it said, and still throws", () => {
  simctlLog.length = 0;
  const fail = () => {
    throw Object.assign(new Error("Command failed"), { status: 60, stderr: "Simulator device failed to open http://x.\nOperation timed out\n" });
  };
  assert.throws(() => simctl(["openurl", "U", "http://x"], { timeout: 1000 }, fail), /Command failed/);
  assert.match(simctlLog[0]![2], /^simctl openurl U http:\/\/x: failed after \d+ ms, exit 60: Simulator device failed to open http:\/\/x\. Operation timed out$/);
});

test("a busy iPhone's log of 5 minutes, past Node's 1 MiB, is kept", () => {
  // as execFileSync fails a call whose output passes its maxBuffer: a failing case's `log show` did, with ENOBUFS
  const run = (_f: string, _a: string[], o: { maxBuffer?: number }) => {
    const out = "x".repeat(8 * 2 ** 20);
    if (out.length > (o.maxBuffer ?? 2 ** 20)) throw Object.assign(new Error("spawnSync xcrun ENOBUFS"), { code: "ENOBUFS" });
    return out;
  };
  assert.equal(simctl(["spawn", "U", "log", "show"], { timeout: 1000 }, run).length, 8 * 2 ** 20);
});

test("an awaited call leaves this process free, as the iPhone's page loads from this process's server", { timeout: 30_000 }, async () => {
  await withXcrun("sleep 0.3; echo out", async () => {
    simctlLog.length = 0;
    let ticks = 0;
    const ticking = setInterval(() => ticks++, 10);
    try {
      assert.equal(await simctlAsync(["openurl", "U", "http://x"], { timeout: 20_000 }), "out\n");
    } finally {
      clearInterval(ticking);
    }
    assert.ok(ticks > 0);
    assert.match(simctlLog[0]![2], /^simctl openurl U http:\/\/x: \d+ ms$/);
  });
});

test("an awaited call that fails is noted with its exit and what it said, and still throws", { timeout: 30_000 }, async () => {
  await withXcrun("echo 'Operation timed out' >&2; exit 60", async () => {
    simctlLog.length = 0;
    await assert.rejects(simctlAsync(["openurl", "U", "http://x"], { timeout: 20_000 }));
    assert.match(simctlLog[0]![2], /^simctl openurl U http:\/\/x: failed after \d+ ms, exit 60: Operation timed out$/);
  });
});

test("an awaited call past its limit is killed and noted so", { timeout: 30_000 }, async () => {
  await withXcrun("exec sleep 20", async () => {
    simctlLog.length = 0;
    await assert.rejects(simctlAsync(["openurl", "U", "http://x"], { timeout: 100 }));
    assert.match(simctlLog[0]![2], /^simctl openurl U http:\/\/x: failed after \d+ ms, killed by SIGTERM$/);
  });
});

test("a call that failed since a case began is found, though the case went on past it", () => {
  // as the launch opens Safari's first URL again when simctl gives up on it, and the case then passes
  simctlLog.length = 0;
  simctlLog.push([1, "simctl", "simctl openurl U http://x: failed after 51000 ms, exit 60: Operation timed out"],
    [5, "simctl", "simctl openurl U http://x: 1200 ms"],
    [9, "simctl", "simctl openurl U http://y: failed after 33000 ms, exit 60: Operation timed out"]);
  assert.deepEqual(simctlFailures(5), ["simctl openurl U http://y: failed after 33000 ms, exit 60: Operation timed out"]);
});

test("iOS's push daemon is disabled for good, then stopped, as it loops on a server CI cannot reach and starves the runner", () => {
  const calls: string[] = [];
  stopPush("U", (args) => {
    calls.push(args.join(" "));
    return "";
  });
  assert.deepEqual(calls, ["spawn U launchctl disable system/com.apple.apsd", "spawn U launchctl bootout system/com.apple.apsd"]);
});

test("a push daemon already stopped is no failure, and an iPhone not yet answering costs only a warning", () => {
  const said: string[] = [];
  stopPush("U", (args) => {
    if (args.includes("bootout")) throw new Error("Boot-out failed: 3: No such process");
    return "";
  }, (m) => said.push(m));
  assert.equal(said.length, 0);
  stopPush("U", () => {
    throw new Error("Unable to lookup in current state: Shutdown");
  }, (m) => said.push(m));
  assert.equal(said.length, 1);
  assert.match(said[0]!, /push daemon stays on: Unable to lookup/);
});

test("an iPhone boots without the services written to launchd_sim's store, in a plist, what the store held kept", () => {
  const root = mkdtempSync(join(tmpdir(), "ios-store-"));
  try {
    assert.equal(bootsWithout("U", "com.apple.apsd", root), false);
    mkdirSync(join(root, "com.apple.CoreSimulator.SimDevice.U"));
    writeFileSync(join(root, "com.apple.CoreSimulator.SimDevice.U/disabled.plist"), "<plist version=\"1.0\"><dict><key>com.apple.own</key><false/></dict></plist>");
    bootWithout("U", ["com.apple.apsd", "com.apple.PosterBoard"], root);
    assert.equal(bootsWithout("U", "com.apple.apsd", root), true);
    assert.equal(bootsWithout("U", "com.apple.own", root), false);
    const plist = join(root, "com.apple.CoreSimulator.SimDevice.U/disabled.plist");
    assert.ok(readFileSync(plist, "utf8").startsWith("<?xml"));
    assert.deepEqual(JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8", timeout: 10_000 })), {
      "com.apple.PosterBoard": true, "com.apple.apsd": true, "com.apple.own": false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
