#!/usr/bin/env node
// Boots an iPhone in the iOS Simulator whose Safari the scenarios' ios-safari device drives: node scripts/ios.ts. The
// device touches it through idb (brew install facebook/fb/idb-companion, and uv for scripts/sim-hid.py) and reads its
// page through the agent the scenarios' server puts in it. Stop the iPhone with xcrun simctl shutdown all. With --start
// it only starts the boot, which CI does first, for the iPhone to settle while the rest installs. With --home it also adds
// the scenarios' app to the Home Screen as "Breezy Scenarios", for the ios-home device: Safari's page menu and Share are
// found by their accessibility, but the share sheet shows its buttons to nothing but the eye, so they are where an
// iPhone 17 on iOS 27 has them; elsewhere, it says how to add it by hand.
import { execFileSync } from "node:child_process";
import { cpus, loadavg } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { HOME_ICON, homeIcon, iosUnfit, SimHid } from "../scenarios/ios.ts";

const run = (...args: string[]) => execFileSync("xcrun", ["simctl", ...args], { encoding: "utf8", timeout: 300_000 });
// an iPhone already booted, as the devices take the first one booted, else the newest of the newest runtime
const { devices } = JSON.parse(run("list", "devices", "available", "--json")) as { devices: Record<string, { udid: string; name: string; state: string }[]> };
const booted = Object.entries(devices).flatMap(([r, ds]) => ds.filter((d) => d.name.startsWith("iPhone") && d.state === "Booted").map((d) => [r, d] as const))[0];
const runtime = booted?.[0] ?? Object.keys(devices).filter((r) => r.includes("iOS") && devices[r]!.some((d) => d.name.startsWith("iPhone"))).sort().at(-1);
const phone = booted?.[1] ?? devices[runtime!]?.filter((d) => d.name.startsWith("iPhone")).at(-1);
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

if (process.argv.includes("--home") && !homeIcon(phone.udid)) {
  // here, not at the top: CI starts the boot before it installs Playwright, which the scenarios' server brings
  const { buildSite, serveStatic, WEB } = await import("../scenarios/browser.ts");
  const site = new URL("../build/web-scenarios", import.meta.url).pathname;
  buildSite(site);
  const web = serveStatic(site, WEB);
  const hid = await SimHid.start(phone.udid);
  const tap = (p: { x: number; y: number }) => hid.touches([[0, "down", p.x, p.y], [50, "up", p.x, p.y]]);
  /** Where Safari's element `id` is, by its accessibility. */
  const find = (id: string) => {
    const out = execFileSync("uvx", ["--quiet", "--python", "3.11", "--from", "fb-idb", "idb", "ui", "describe-all", "--udid", phone.udid, "--json"], { encoding: "utf8", timeout: 120_000 });
    const e = (JSON.parse(out) as { AXUniqueId?: string; frame: { x: number; y: number; width: number; height: number } }[]).find((x) => x.AXUniqueId === id);
    if (!e) throw new Error(`Safari shows no ${id}`);
    return { x: e.frame.x + e.frame.width / 2, y: e.frame.y + e.frame.height / 2 };
  };
  try {
    run("openurl", phone.udid, `http://localhost:${WEB}/`);
    await sleep(4000);
    await tap(find("MoreMenuButton"));
    await sleep(1500);
    await tap(find("ShareButton"));
    await sleep(2500);
    // View More, then Add to Home Screen, on an iPhone 17 on iOS 27
    await tap({ x: 332, y: 781 });
    await sleep(2000);
    await tap({ x: 150, y: 636 });
    await sleep(4000);
    await hid.text(HOME_ICON.slice("Breezy".length));
    await tap({ x: 353, y: 100 });
    await sleep(3000);
  } catch (e) {
    console.log(`adding to the Home Screen stopped: ${(e as Error).message}`);
  } finally {
    hid.stop();
    web.close();
    web.closeAllConnections();
  }
  if (!homeIcon(phone.udid)) {
    console.log(`no "${HOME_ICON}" on the Home Screen: while the scenarios serve the app, open http://localhost:${WEB}/ in the simulator's Safari, Share, Add to Home Screen, name it "${HOME_ICON}", and Add`);
    process.exit(1);
  }
  console.log(`"${HOME_ICON}" is on the Home Screen`);
}
