// The cases on real devices against server/dev.sh and the relay under wrangler dev: the web app as it ships in headless
// Chromium and WebKit, and the Debug Mac app. Slower: run with
//   node --test scenarios/browsers.e2e.ts
import { test } from "node:test";
import { existsSync } from "node:fs";
import { cases } from "./cases.ts";
import { RealWorld, type RealKind } from "./browser.ts";
import { MAC_APP } from "./mac.ts";

const noMac = !existsSync(MAC_APP) && "the Debug Mac app is not built";
/** Each kind acts once and watches once, which a run of minutes can afford. */
const pairs: [RealKind, RealKind][] = [["chromium", "webkit"], ["webkit", "mac"], ["mac", "chromium"]];

for (const c of cases) {
  for (const [a, b] of pairs) {
    if (c.input === "touch" && a === "mac") continue;
    test(`${c.name} (${a} → ${b})`, { skip: [a, b].includes("mac") && noMac, timeout: 90_000 }, async () => {
      const w = await RealWorld.start([a, b]);
      try {
        await c.run({ devices: w.devices, settle: () => w.settle() });
      } finally {
        await w.stop();
      }
    });
  }
}
