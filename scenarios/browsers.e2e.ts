// The cases on real devices against server/dev.sh and the relay under wrangler dev: the web app as it ships in headless
// Chromium, WebKit and Firefox, Chrome on the Android device adb sees, and the Debug Mac app. Slower: run with
//   node --test scenarios/browsers.e2e.ts
// under MISE_ENV=android mise exec -- after node scripts/android.ts for Android.
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cases } from "./cases.ts";
import { RealWorld, type RealKind } from "./browser.ts";
import { MAC_APP } from "./mac.ts";

const noMac = !existsSync(MAC_APP) && "the Debug Mac app is not built";
const noAndroid = (() => {
  try {
    return !/\tdevice$/m.test(execFileSync("adb", ["devices"], { encoding: "utf8" })) && "no Android device: run node scripts/android.ts";
  } catch {
    return "no adb: run under MISE_ENV=android mise exec --";
  }
})();
/** Each kind acts once and watches once, which a run of minutes can afford; a phone acts only with a finger. */
const pairs: [RealKind, RealKind][] = [["chromium", "webkit"], ["webkit", "firefox"], ["firefox", "mac"], ["mac", "android"], ["android", "chromium"]];

for (const c of cases) {
  for (const [a, b] of pairs) {
    if (c.input === "touch" && a === "mac" || c.input === "mouse" && a === "android") continue;
    test(`${c.name} (${a} → ${b})`, { skip: [a, b].includes("mac") && noMac || [a, b].includes("android") && noAndroid, timeout: 90_000 }, async () => {
      const w = await RealWorld.start([a, b]);
      try {
        await c.run({ devices: w.devices, settle: () => w.settle() });
      } finally {
        await w.stop();
      }
    });
  }
}
