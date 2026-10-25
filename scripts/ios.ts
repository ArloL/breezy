#!/usr/bin/env node
// Boots an iPhone in the iOS Simulator whose Safari the scenarios' ios-safari device drives: node scripts/ios.ts. The
// device touches it through idb (brew install facebook/fb/idb-companion, and uv for scripts/sim-hid.py) and reads its
// page through the agent the scenarios' server puts in it. Stop the iPhone with xcrun simctl shutdown all. With --start
// it only starts the boot, which CI does first, for the iPhone to settle while the rest installs.
import { execFileSync } from "node:child_process";
import { cpus, loadavg } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { iosUnfit } from "../scenarios/ios.ts";

const run = (...args: string[]) => execFileSync("xcrun", ["simctl", ...args], { encoding: "utf8", timeout: 300_000 });
// the newest iPhone of the newest runtime, booted or not
const { devices } = JSON.parse(run("list", "devices", "available", "--json")) as { devices: Record<string, { udid: string; name: string; state: string }[]> };
const runtime = Object.keys(devices).filter((r) => r.includes("iOS") && devices[r]!.some((d) => d.name.startsWith("iPhone"))).sort().at(-1);
const phone = devices[runtime!]?.filter((d) => d.name.startsWith("iPhone")).at(-1);
if (!phone) throw new Error("no iPhone simulator: install an iOS runtime in Xcode");
if (phone.state !== "Booted") run("boot", phone.udid);
if (process.argv.includes("--start")) {
  console.log(`booting ${phone.name} on ${runtime!.split(".").at(-1)}`);
  process.exit(0);
}
run("bootstatus", phone.udid, "-b");
const unfit = await iosUnfit();
if (unfit) throw new Error(unfit);
run("launch", phone.udid, "com.apple.mobilesafari");
console.log(`${phone.name} on ${runtime!.split(".").at(-1)}, touched through idb and read through the scenarios' agent`);
// a fresh iPhone keeps the runner busy for minutes after its boot, at a load of 500 to 600 on 3 CPUs, and the first
// cases failed in it
const settling = Date.now(), most = 60 * cpus().length;
while (loadavg()[0] > most && Date.now() - settling < 8 * 60_000) await sleep(5000);
console.log(`the load ${loadavg()[0].toFixed(0)} of ${cpus().length} CPUs after ${Math.round((Date.now() - settling) / 1000)} s settling`);
