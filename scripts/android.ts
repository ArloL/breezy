#!/usr/bin/env node
// Boots a headless Pixel 8a emulator whose Chrome Playwright can drive, for the scenarios' android device:
//   MISE_ENV=android mise install && MISE_ENV=android mise exec -- node scripts/android.ts
// Installs the system image and creates the AVD the first time, and connects adb to the emulator over TCP as well. Each
// wait is bounded and names what it waited for.
// Stop it with adb emu kill.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { arch } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { EMULATOR_TCP, RELAY, SERVER, WEB } from "../scenarios/browser.ts";

const root = new URL("..", import.meta.url).pathname;
const sdk = process.env.ANDROID_HOME!;
const avds = process.env.ANDROID_AVD_HOME!;
// mise puts it on PATH only once it is installed
process.env.PATH = `${join(sdk, "platform-tools")}:${process.env.PATH}`;
const image = `system-images;android-36;google_apis_playstore;${arch() === "arm64" ? "arm64-v8a" : "x86_64"}`;

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

if (!existsSync(join(sdk, "emulator", "emulator")) || !existsSync(join(sdk, ...image.split(";")))) {
  run("sdkmanager", ["emulator", "platform-tools", image], { timeout: 0 });
}
if (!existsSync(join(avds, "breezy.ini"))) {
  // avdmanager writes elsewhere when the directory is missing
  mkdirSync(avds, { recursive: true });
  run("avdmanager", ["create", "avd", "--name", "breezy", "--package", image, "--device", "pixel_8a"], { input: "no\n" });
}
// the emulator alone, as the adb commands below name no device; this run connects TCP again
succeeds(() => adb("disconnect", EMULATOR_TCP))();
// one still listed while it shuts down is not running
if (!/^emulator-\d+\tdevice$/m.test(adb("devices"))) {
  mkdirSync(join(root, "build"), { recursive: true });
  const log = openSync(join(root, "build", "android-emulator.log"), "w");
  emulator = spawn(join(sdk, "emulator", "emulator"), ["-avd", "breezy", "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot-save"], { detached: true, stdio: ["ignore", log, log] });
  emulator.unref();
}
await within(300, "the emulator to boot", succeeds(() => adb("shell", "getprop", "sys.boot_completed").trim() === "1"));
// The scenarios and the rest of this script reach adbd over TCP, which the emulator redirects from this machine's port to
// its own: the emulator's adb pipe drops every connection on it under load, a few times an hour on some runners, and an
// `am start` it drops leaves Chrome half launched. Listening on TCP restarts adbd.
const serial = /^(emulator-\d+)\tdevice$/m.exec(adb("devices"))![1]!;
await within(60, "adbd to listen on TCP", succeeds(() => {
  if (adb("-s", serial, "shell", "getprop", "service.adb.tcp.port").trim() === "5555") return true;
  adb("-s", serial, "tcpip", "5555");
  return false;
}));
// already there when the emulator was running
succeeds(() => adb("-s", serial, "emu", "redir", "add", `tcp:${EMULATOR_TCP.split(":")[1]}:5555`))();
await within(60, `adb to connect to ${EMULATOR_TCP}`, succeeds(() => adb("connect", EMULATOR_TCP).includes("connected") && adb("-s", EMULATOR_TCP, "get-state").trim() === "device"));
device = ["-s", EMULATOR_TCP];
// before Android's own connections take them
for (const port of [WEB, SERVER, RELAY]) {
  await within(90, `port ${port} to be free on the emulator`, succeeds(() => adb("reverse", `tcp:${port}`, `tcp:${port}`)));
}
// a cold boot reports itself completed before the package manager knows Chrome
await within(60, "the package manager to know Chrome", succeeds(() => adb("shell", "pm", "path", "com.android.chrome")));
// a user build's Chrome reads the command line Playwright writes only as the debug app
adb("shell", "am", "set-debug-app", "--persistent", "com.android.chrome");
// else Chrome asks for it over the page
adb("shell", "pm", "grant", "com.android.chrome", "android.permission.POST_NOTIFICATIONS");
// Chrome's first-run screens, which Playwright's --disable-fre does not skip; after a cold boot its activity shows up a
// while after its package
const chrome = () => adb("shell", "am", "start", "-n", "com.android.chrome/com.google.android.apps.chrome.Main");
await within(60, "Chrome's activity", succeeds(chrome));
let ui = "", top = "", seen = "";
await within(90, "Chrome to get past its first-run screens", () => {
  try {
    top = adb("shell", "dumpsys activity activities | grep -m1 topResumedActivity");
    ui = adb("shell", "uiautomator dump /sdcard/ui.xml >/dev/null && cat /sdcard/ui.xml");
  } catch {
    // fails while the screen is still changing
    return false;
  }
  // a tap meant for Chrome lands on whatever is there instead: the home screen's search bar sits under "Got it"
  // in front but not drawn, as when its launch stalled, it is launched again too
  if (!top.includes("com.android.chrome/") || !ui.includes('package="com.android.chrome"')) {
    succeeds(chrome)();
    return false;
  }
  if (/com\.android\.chrome:id\/(url_bar|search_box_text)/.test(ui)) return true;
  // a dump during a transition still shows the screen going away, so only a button the next dump shows too is tapped
  const button = /text="(?:Use without an account|No thanks|Got it)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(ui);
  const now = top + button?.[0];
  if (!button || now !== seen) {
    seen = now;
    return false;
  }
  const [x0, y0, x1, y1] = button.slice(1).map(Number);
  adb("shell", "input", "tap", String(Math.round((x0! + x1!) / 2)), String(Math.round((y0! + y1!) / 2)));
  seen = "";
  return false;
}).catch((e: Error) => {
  throw new Error(`${e.message}; ${top.trim()} shows ${[...ui.matchAll(/text="([^"]+)"/g)].map((m) => m[1]).join(" | ")}`);
});

