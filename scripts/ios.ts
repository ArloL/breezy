#!/usr/bin/env node
// Boots an iPhone in the iOS Simulator whose Safari the scenarios' ios-safari device drives: node scripts/ios.ts. The
// device touches its page through scripts/sim-finger.m, built with Xcode's clang, types through idb (brew install
// facebook/fb/idb-companion, and uv for scripts/sim-hid.py) and reads its page through the agent the scenarios' server
// puts in it. Stop the iPhone with xcrun simctl shutdown all. With --start
// it only starts the boot, which CI does first, for the iPhone to settle while the rest installs. With --home it also puts
// the scenarios' app on the Home Screen as "Breezy Scenarios", for the ios-home device, on any iPhone: given with --start,
// before the one boot, as a clip written to a booted iPhone costs it a second.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { cpus, homedir, loadavg } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { HOME_ICON, iosUnfit } from "../scenarios/ios.ts";

const run = (...args: string[]) => execFileSync("xcrun", ["simctl", ...args], { encoding: "utf8", timeout: 300_000 });
// an iPhone already booted, as the devices take the first one booted, else the model IPHONE names: an iPhone 17 by
// default, or the owner's iPhone 13 mini, whose board shows less above its keyboard. On the newest runtime that has one
// (CI's iOS 27.1 offers only the iPhone Duo), else made on the newest iOS runtime that can run it.
const model = process.env.IPHONE ?? "iPhone 17";
type Sim = { udid: string; name: string; state: string };
const { devices } = JSON.parse(run("list", "devices", "available", "--json")) as { devices: Record<string, Sim[]> };
const booted = Object.entries(devices).flatMap(([r, ds]) => ds.filter((d) => d.name.startsWith("iPhone") && d.state === "Booted").map((d) => [r, d] as const))[0];
const ios = Object.keys(devices).filter((r) => r.includes("iOS")).sort().reverse();
let runtime = booted?.[0] ?? ios.find((r) => devices[r]!.some((d) => d.name === model));
let phone: Sim | undefined = booted?.[1] ?? (runtime ? devices[runtime]!.find((d) => d.name === model) : undefined);
for (const r of phone ? [] : ios) {
  try {
    phone = { udid: run("create", model, `com.apple.CoreSimulator.SimDeviceType.${model.replace(/ /g, "-")}`, r).trim(), name: model, state: "Shutdown" };
    runtime = r;
    break;
  } catch {}
}
if (!phone) throw new Error(`no ${model} simulator, and none could be made: add one in Xcode`);
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
    // idb's companion keeps a connection to the iPhone as it was, and its record of the companion outlives it
    try { execFileSync("pkill", ["-f", "idb_companion"]); } catch {}
    rmSync("/tmp/idb/state", { force: true });
  }
  try { plutil("-lint", prefs); } catch { plutil("-create", "binary1", prefs); }
  for (const k of off) plutil("-replace", k, "-bool", "NO", prefs);
}
// the scenarios' app on the Home Screen, for the ios-home device: a web clip written while the iPhone is down, as the
// Home Screen finds the clips as it boots. Added through Safari's share sheet it took taps where an iPhone 17 shows the
// sheet's buttons, timed by the clock, and on CI's busy runner it often never came.
const clips = join(homedir(), "Library/Developer/CoreSimulator/Devices", phone.udid, "data/Library/WebClips");
const titled = (c: string) => {
  try {
    return plutil("-extract", "Title", "raw", join(clips, c, "Info.plist")) === HOME_ICON;
  } catch {
    return false;
  }
};
if (process.argv.includes("--home") && !(existsSync(clips) && readdirSync(clips).some(titled))) {
  const { WEB } = await import("../scenarios/browser.ts");
  if (phone.state === "Booted") {
    run("shutdown", phone.udid);
    phone.state = "Shutdown";
    try { execFileSync("pkill", ["-f", "idb_companion"]); } catch {}
    rmSync("/tmp/idb/state", { force: true });
  }
  const id = randomUUID().replace(/-/g, "").toUpperCase(), clip = join(clips, `${id}.webclip`), info = join(clip, "Info.plist");
  mkdirSync(clip, { recursive: true });
  copyFileSync(new URL("../web/icon-180.png", import.meta.url), join(clip, "icon.png"));
  plutil("-create", "binary1", info);
  // as Add to Home Screen writes them on iOS 27, less the manifest, which the app fetches itself
  const keys: [string, string, string][] = [
    ["Title", "-string", HOME_ICON], ["URL", "-string", `http://localhost:${WEB}/`], ["FullScreen", "-bool", "YES"],
    ["ContentMode", "-string", "UIWebClipContentModeRecommended"], ["ClassicMode", "-bool", "NO"], ["IsAppClip", "-bool", "NO"],
    ["IconIsPrecomposed", "-bool", "NO"], ["IconIsScreenShotBased", "-bool", "NO"], ["IgnoreManifestScope", "-bool", "NO"],
    ["ConfigurationIsManaged", "-bool", "NO"], ["ScenelessBackgroundLaunch", "-bool", "NO"], ["ApplicationBundleVersion", "-integer", "1"],
    ["Eligibility", "-integer", "0"], ["Orientations", "-integer", "0"], ["WebClipStatusBarStyle", "-string", "UIWebClipStatusBarStyleLegacyBlack"],
    ["PlaceholderBundleIdentifier", "-string", `com.apple.WebKit.PushBundle.${id}`], ["TrustedClientBundleIdentifiers", "-array", ""],
  ];
  for (const [k, type, v] of keys) plutil("-insert", k, type, ...(v ? [v] : []), info);
  plutil("-insert", "TrustedClientBundleIdentifiers.0", "-string", "com.apple.mobilesafari", info);
  console.log(`"${HOME_ICON}" written to the Home Screen`);
}
if (phone.state !== "Booted") run("boot", phone.udid);
if (process.argv.includes("--start")) {
  console.log(`booting ${phone.name} on ${runtime!.split(".").at(-1)}`);
  process.exit(0);
}
run("bootstatus", phone.udid, "-b");
run("launch", phone.udid, "com.apple.mobilesafari");
console.log(`${phone.name} on ${runtime!.split(".").at(-1)}, touched through idb and read through the scenarios' agent`);
// a fresh iPhone keeps the runner busy for minutes after its boot, at a load of 500 to 600 on 3 CPUs, and the first
// cases failed in it
const settling = Date.now(), most = 60 * cpus().length;
while (loadavg()[0] > most && Date.now() - settling < 8 * 60_000) await sleep(5000);
console.log(`the load ${loadavg()[0].toFixed(0)} of ${cpus().length} CPUs after ${Math.round((Date.now() - settling) / 1000)} s settling`);
// after the settling: CI's fresh iPhone kept simctl from answering for minutes after its boot
const unfit = await iosUnfit();
if (unfit) throw new Error(unfit);

