#!/usr/bin/env node
// Boots an iPhone in the iOS Simulator whose Safari the scenarios' ios-safari device drives, and starts safaridriver on
// port 4723 for it: node scripts/ios.ts. safaridriver needs `sudo safaridriver --enable` once on this Mac. Stop the
// iPhone with xcrun simctl shutdown all. With --start it only starts the boot, which CI does first, for the iPhone to
// settle while the rest installs.
import { execFileSync, spawn } from "node:child_process";
import { cpus, loadavg } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { iosUnfit, IosPage, SAFARIDRIVER } from "../scenarios/ios.ts";

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
// Settings → Safari → Advanced → Remote Automation and Web Inspector, which safaridriver needs to find Safari
for (const key of ["RemoteAutomationEnabled", "WebKitRemoteAutomationEnabled", "WebInspectorEnabled", "WebKitInspectorEnabled"]) {
  run("spawn", phone.udid, "defaults", "write", "com.apple.mobilesafari", key, "-bool", "YES");
}
run("launch", phone.udid, "com.apple.mobilesafari");
await sleep(5000);
if (await iosUnfit()) spawn("safaridriver", ["-p", new URL(SAFARIDRIVER).port], { detached: true, stdio: "ignore" }).unref();
for (const end = Date.now() + 30_000; await iosUnfit(); await sleep(500)) {
  if (Date.now() > end) throw new Error("safaridriver did not start in 30 s: run sudo safaridriver --enable once");
}
// the first session on a fresh simulator took over 90 s, a case's whole time, or never came
const warm = Date.now();
await (await IosPage.open()).close();
console.log(`${phone.name} on ${runtime!.split(".").at(-1)}, safaridriver on ${SAFARIDRIVER}, a first session in ${Math.round((Date.now() - warm) / 1000)} s`);
// a fresh iPhone keeps the runner busy for minutes after its boot, at a load of 500 to 600 on 3 CPUs, and the first
// cases failed in it
const settling = Date.now(), most = 60 * cpus().length;
while (loadavg()[0] > most && Date.now() - settling < 8 * 60_000) await sleep(5000);
console.log(`the load ${loadavg()[0].toFixed(0)} of ${cpus().length} CPUs after ${Math.round((Date.now() - settling) / 1000)} s settling`);
