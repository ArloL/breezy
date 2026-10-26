#!/usr/bin/env node
// Boots an iPhone in the iOS Simulator whose Safari the scenarios' ios-safari device drives, and starts safaridriver on
// port 4723 for it: node scripts/ios.ts. safaridriver needs `sudo safaridriver --enable` once on this Mac. Stop the
// iPhone with xcrun simctl shutdown all. With --start it only starts the boot, which CI does first, for the iPhone to
// settle while the rest installs.
import { execFileSync, spawn } from "node:child_process";
import { cpus, homedir, loadavg } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { iosUnfit, IosPage, SAFARIDRIVER } from "../scenarios/ios.ts";

const run = (...args: string[]) => execFileSync("xcrun", ["simctl", ...args], { encoding: "utf8", timeout: 300_000 });
// an iPhone already booted, else an iPhone 17, the owner's size, on the newest runtime that has one: CI's iOS 27.1
// offers only the iPhone Duo
const { devices } = JSON.parse(run("list", "devices", "available", "--json")) as { devices: Record<string, { udid: string; name: string; state: string }[]> };
const booted = Object.entries(devices).flatMap(([r, ds]) => ds.filter((d) => d.name.startsWith("iPhone") && d.state === "Booted").map((d) => [r, d] as const))[0];
const runtime = booted?.[0] ?? Object.keys(devices).filter((r) => r.includes("iOS") && devices[r]!.some((d) => d.name === "iPhone 17")).sort().at(-1);
const phone = booted?.[1] ?? devices[runtime!]?.find((d) => d.name === "iPhone 17");
if (!phone) throw new Error("no iPhone 17 simulator: add one in Xcode");
// the keyboard types what the cases type, as Android's spell checker is off for them: autocorrect wrote "neighbours" as
// "neighbors" and dropped words, capitals and predictions came unasked. Read only as the iPhone boots.
// The file itself, with plutil: the Mac's own preferences daemon kept what defaults wrote and the iPhone booted without it.
const prefs = join(homedir(), "Library/Developer/CoreSimulator/Devices", phone.udid, "data/Library/Preferences/com.apple.Preferences.plist");
const off = ["KeyboardAutocorrection", "KeyboardPrediction", "KeyboardAutocapitalization", "KeyboardCheckSpelling", "KeyboardShowPredictionBar"];
const plutil = (...args: string[]) => execFileSync("plutil", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const isOff = (k: string) => { try { return plutil("-extract", k, "raw", prefs) === "false"; } catch { return false; } };
if (!off.every(isOff)) {
  if (phone.state === "Booted") {
    run("shutdown", phone.udid);
    phone.state = "Shutdown";
  }
  try { plutil("-lint", prefs); } catch { plutil("-create", "binary1", prefs); }
  for (const k of off) plutil("-replace", k, "-bool", "NO", prefs);
}
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
