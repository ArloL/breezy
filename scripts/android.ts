#!/usr/bin/env node
// Boots a headless Pixel 8a emulator whose Chrome and Firefox Playwright can drive, for the scenarios' android and
// firefox-android devices:
//   MISE_ENV=android mise install && MISE_ENV=android mise exec -- node scripts/android.ts
// Installs the system image and creates the AVD the first time, and connects adb to the emulator over TCP as well. Each
// wait is bounded and names what it waited for.
// Stop it with MISE_ENV=android mise exec -- adb emu kill.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { arch } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { EMULATOR_TCP, FENIX, FENIX_VERSION, RELAY, SERVER, WEB } from "../scenarios/browser.ts";

const root = new URL("..", import.meta.url).pathname;
const sdk = process.env.ANDROID_HOME!;
const avds = process.env.ANDROID_AVD_HOME!;
// mise puts it on PATH only once it is installed
process.env.PATH = `${join(sdk, "platform-tools")}:${process.env.PATH}`;
// Android 17 with Google Play, whose Chrome is the one a phone gets; the AVD is named for it, so a new one replaces it
const api = "android-37.0";
const image = `system-images;${api};google_apis_playstore;${arch() === "arm64" ? "arm64-v8a" : "x86_64"}`;
const avd = `breezy-${api}`;

const run = (cmd: string, args: string[], { input, timeout = 30_000 }: { input?: string; timeout?: number } = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", input, timeout, stdio: "pipe" });
/** The device the commands go to once there are two: the emulator, and adbd on TCP. */
let device: string[] = [];
const adb = (...args: string[]) => run("adb", [...device, ...args]);
/** Whether `f` neither throws nor returns false. */
const succeeds = (f: () => unknown) => () => {
  try {
    return f() !== false;
  } catch {
    return false;
  }
};

let emulator: ChildProcess | undefined;

async function within(seconds: number, what: string, ok: () => boolean) {
  for (const end = Date.now() + seconds * 1000; !ok(); await sleep(1000)) {
    if (emulator && emulator.exitCode !== null) throw new Error("the emulator quit: see build/android-emulator.log");
    if (Date.now() > end) throw new Error(`gave up after ${seconds} s waiting for ${what}`);
  }
}

// build-tools and the platform build tools/breezy-ime, the keyboard the platform rows type with
const tools = ["build-tools;35.0.0", "platforms;android-35"];
if (!existsSync(join(sdk, "emulator", "emulator")) || !existsSync(join(sdk, ...image.split(";"))) || !tools.every((t) => existsSync(join(sdk, ...t.split(";"))))) {
  run("sdkmanager", ["emulator", "platform-tools", image, ...tools], { timeout: 0 });
}
if (!existsSync(join(avds, `${avd}.ini`))) {
  // avdmanager writes elsewhere when the directory is missing
  mkdirSync(avds, { recursive: true });
  run("avdmanager", ["create", "avd", "--name", avd, "--package", image, "--device", "pixel_8a"], { input: "no\n" });
}
// the emulator alone, as the adb commands below name no device; this run connects TCP again
succeeds(() => adb("disconnect", EMULATOR_TCP))();
// one still listed while it shuts down is not running
if (!/^emulator-\d+\tdevice$/m.test(adb("devices"))) {
  mkdirSync(join(root, "build"), { recursive: true });
  const log = openSync(join(root, "build", "android-emulator.log"), "w");
  emulator = spawn(join(sdk, "emulator", "emulator"), ["-avd", avd, "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot-save"], { detached: true, stdio: ["ignore", log, log] });
  emulator.unref();
}
await within(300, "the emulator to boot", succeeds(() => adb("shell", "getprop", "sys.boot_completed").trim() === "1"));
// The scenarios and the rest of this script reach adbd over TCP, which the emulator redirects from this machine's port to
// its own: the emulator's adb pipe drops every connection on it under load, a few times an hour on some runners, and an
// `am start` it drops leaves Chrome half launched. Listening on TCP restarts adbd.
// listed offline for a moment when its pipe drops
let serial = "";
await within(60, "the emulator to be listed", succeeds(() => (serial = /^(emulator-\d+)\tdevice$/m.exec(adb("devices"))?.[1] ?? "") !== ""));
await within(60, "adbd to listen on TCP", succeeds(() => {
  if (adb("-s", serial, "shell", "getprop", "service.adb.tcp.port").trim() === "5555") return true;
  adb("-s", serial, "tcpip", "5555");
  return false;
}));
await within(60, `adb to connect to ${EMULATOR_TCP}`, succeeds(() => {
  // fails while the emulator's console is starting, and when the redirect is there already
  succeeds(() => adb("-s", serial, "emu", "redir", "add", `tcp:${EMULATOR_TCP.split(":")[1]}:5555`))();
  return adb("connect", EMULATOR_TCP).includes("connected") && adb("-s", EMULATOR_TCP, "get-state").trim() === "device";
}));
device = ["-s", EMULATOR_TCP];
/** Until `adb` with `args` succeeds, connecting again after each failure: adbd drops its TCP connections for a few
 * seconds now and then right after it listens there. */
const settled = (what: string, ...args: string[]) => within(60, what, () => {
  if (succeeds(() => adb(...args))()) return true;
  succeeds(() => run("adb", ["connect", EMULATOR_TCP]))();
  return false;
});
// before Android's own connections take them
for (const port of [WEB, SERVER, RELAY]) {
  await within(90, `port ${port} to be free on the emulator`, succeeds(() => adb("reverse", `tcp:${port}`, `tcp:${port}`)));
}
// Android's own animations, which a software-rendered screen draws on the CPU the page needs too
for (const scale of ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"]) {
  await settled(`${scale} 0`, "shell", "settings", "put", "global", scale, "0");
}
// the emulator's touchscreen says it is a stylus too, and Gboard puts its stylus tutorial over the page as an editor opens
await settled("handwriting off", "shell", "settings", "put", "secure", "stylus_handwriting_enabled", "0");
// a tap on a word the spell checker marks opens Chrome's suggestions a moment later, and the next tap anywhere only
// closes them
await settled("spell checker off", "shell", "settings", "put", "secure", "spell_checker_enabled", "0");
// a crash of some app of Android's own puts a dialog over Chrome, as Digital Wellbeing's did over its first run
await settled("error dialogs hidden", "shell", "settings", "put", "global", "hide_error_dialogs", "1");
// the Play Store updates Google Play services and itself while the scenarios run, and Chrome quits when Play services is
// replaced, closing the page under a case
await within(60, "the Play Store to be off", succeeds(() => adb("shell", "pm", "disable-user", "--user", "0", "com.android.vending").includes("disabled")));
// a cold boot reports itself completed before the package manager knows Chrome
await within(60, "the package manager to know Chrome", succeeds(() => adb("shell", "pm", "path", "com.android.chrome")));
// a user build's Chrome reads the command line Playwright writes only as the debug app; Android has one, which the
// scenarios set to the browser they launch
await settled("Chrome the debug app", "shell", "am", "set-debug-app", "--persistent", "com.android.chrome");
// else Chrome asks for it over the page
await settled("Chrome's notifications granted", "shell", "pm", "grant", "com.android.chrome", "android.permission.POST_NOTIFICATIONS");
/**
 * Until the app of package `pkg`, launched by `launch`, is past its first-run screens to a screen that `done` matches,
 * tapping the buttons `buttons` names, its own or a system dialog's over it.
 */
async function firstRun(name: string, pkg: string, launch: () => unknown, done: RegExp, buttons: string[]) {
  // after a cold boot its activity shows up a while after its package
  await within(60, `${name}'s activity`, succeeds(launch));
  let ui = "", top = "", seen = "";
  const tap = (b: number[]) => adb("shell", "input", "tap", String(Math.round((b[0]! + b[2]!) / 2)), String(Math.round((b[1]! + b[3]!) / 2)));
  await within(90, `${name} to get past its first-run screens`, () => {
    try {
      top = adb("shell", "dumpsys activity activities | grep -m1 topResumedActivity");
      ui = adb("shell", "uiautomator dump /sdcard/ui.xml >/dev/null && cat /sdcard/ui.xml");
    } catch {
      // fails while the screen is still changing
      return false;
    }
    // one shown before they were turned off, or from an earlier launch
    const crash = /text="(?:Close app|CLOSE)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(ui)?.slice(1).map(Number);
    if (crash) {
      tap(crash);
      return false;
    }
    // as Firefox asks to be the default browser
    const dialog = top.includes("permissioncontroller");
    // a tap meant for the app lands on whatever is there instead: the home screen's search bar sits under Chrome's
    // "Got it" in front but not drawn, as when its launch stalled, it is launched again too
    if (!dialog && (!top.includes(`${pkg}/`) || !ui.includes(`package="${pkg}"`))) {
      succeeds(launch)();
      return false;
    }
    if (!dialog && done.test(ui)) return true;
    // a dump during a transition still shows the screen going away, so only a button the next dump shows too is tapped
    const button = new RegExp(`text="(${buttons.join("|")})"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`).exec(ui);
    // its other attributes, as whether it has focus, change from one dump to the next
    const now = button ? `${top} ${button[1]} ${button.slice(2).join(",")}` : "";
    if (!button || now !== seen) {
      seen = now;
      return false;
    }
    console.log(`tapping "${button[1]}"`);
    tap(button.slice(2).map(Number));
    seen = "";
    return false;
  }).catch((e: Error) => {
    throw new Error(`${e.message}; ${top.trim()} shows ${[...ui.matchAll(/text="([^"]+)"/g)].map((m) => m[1]).join(" | ")}`);
  });
}
// which Playwright's --disable-fre does not skip
await firstRun("Chrome", "com.android.chrome", () => adb("shell", "am", "start", "-n", "com.android.chrome/com.google.android.apps.chrome.Main"),
  /com\.android\.chrome:id\/(url_bar|search_box_text)/, ["Use without an account", "Stay signed out", "No thanks", "Got it"]);

// Firefox, the release a person has: Mozilla's archive keeps each, where the Play Store is off
const fenix = /versionName=(\S+)/.exec(adb("shell", "dumpsys", "package", FENIX))?.[1];
if (fenix !== FENIX_VERSION) {
  const abi = arch() === "arm64" ? "arm64-v8a" : "x86_64";
  // in the SDK's folder, which CI caches
  const apk = join(sdk, "breezy", `fenix-${FENIX_VERSION}-${abi}.apk`);
  if (!existsSync(apk)) {
    mkdirSync(join(sdk, "breezy"), { recursive: true });
    run("curl", ["--fail", "--silent", "--show-error", "--location", "--retry", "5", "--output", apk,
      `https://archive.mozilla.org/pub/fenix/releases/${FENIX_VERSION}/android/fenix-${FENIX_VERSION}-android-${abi}/fenix-${FENIX_VERSION}.multi.android-${abi}.apk`], { timeout: 0 });
  }
  run("adb", [...device, "install", "-r", "-d", apk], { timeout: 300_000 });
}
await settled("Firefox's notifications granted", "shell", "pm", "grant", FENIX, "android.permission.POST_NOTIFICATIONS");
// Chrome stays the default browser
await firstRun("Firefox", FENIX, () => adb("shell", "am", "start", "-n", `${FENIX}/org.mozilla.fenix.HomeActivity`),
  /Tabs Open/, ["Continue", "Cancel", "Not now"]);
adb("shell", "am", "force-stop", FENIX);

// what a run used, as the SDK's cache keeps them until it is evicted and a new emulator or image comes unannounced
const revision = (...dir: string[]) => /^Pkg\.Revision=(.*)$/m.exec(readFileSync(join(sdk, ...dir, "source.properties"), "utf8"))?.[1];
console.log(`Chrome ${/versionName=(\S+)/.exec(adb("shell", "dumpsys", "package", "com.android.chrome"))?.[1]}, Firefox ${FENIX_VERSION} on ${api} image ${revision(...image.split(";"))}, emulator ${revision("emulator")}`);
