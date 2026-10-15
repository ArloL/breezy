// The cases on real devices against server/dev.sh and the relay under wrangler dev: the web app as it ships in headless
// Chromium, WebKit and Firefox, Chrome on the Android device adb sees, and the Debug Mac app. Slower: run with
//   node --test scenarios/browsers.e2e.ts
// under MISE_ENV=android mise exec -- after node scripts/android.ts for Android.
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { cases, type Case } from "./cases.ts";
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
/** Each kind acts once and watches once, which a run of minutes can afford; a phone acts only with a finger.
 * SCENARIO_PAIRS="chromium:mac mac:chromium" runs others. */
const pairs = (process.env.SCENARIO_PAIRS?.split(" ").map((p) => p.split(":") as [RealKind, RealKind])
  ?? [["chromium", "webkit"], ["webkit", "firefox"], ["firefox", "mac"], ["mac", "android"], ["android", "chromium"]]);

/** Runs a case gets before it fails, each in a fresh world: Main gives 2, so that a rare flake warns where it would block
 * a merge, and lists it in build/scenarios/flaky.txt; soaks give 1, to count every failure. */
const RUNS = Number(process.env.SCENARIO_RUNS ?? 1);
const MS = 90_000;

/** One run of `c` on `kinds` in a fresh world, recorded; its error when it fails or takes over `MS`. */
async function once(name: string, c: Case, kinds: [RealKind, RealKind]): Promise<Error | null> {
  const w = new RealWorld();
  let verdict = "failed or timed out", timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        await w.start(kinds);
        await c.run({ devices: w.devices, settle: () => w.settle() });
      })(),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out after ${c.ms ?? MS} ms`)), c.ms ?? MS))),
    ]);
    verdict = "passed";
    return null;
  } catch (e) {
    return e as Error;
  } finally {
    clearTimeout(timer);
    await w.record(name, verdict);
    await w.stop();
  }
}

for (const c of cases) {
  for (const [a, b] of pairs) {
    if (c.input === "touch" && a === "mac" || c.input === "mouse" && a === "android" || c.acts && !c.acts.includes(a)) continue;
    test(`${c.name} (${a} → ${b})`, { skip: [a, b].includes("mac") && noMac || [a, b].includes("android") && noAndroid, timeout: RUNS * ((c.ms ?? MS) + 30_000) }, async (t) => {
      let first: Error | null = null;
      for (let run = 1; ; run++) {
        const e = await once(t.name, c, [a, b]);
        if (!e) break;
        if (run === RUNS) throw first ?? e;
        first ??= e;
      }
      if (!first) return;
      t.diagnostic(`flaky: failed once, then passed: ${first.message}`);
      mkdirSync("build/scenarios", { recursive: true });
      appendFileSync("build/scenarios/flaky.txt", `${t.name}: ${first.message.split("\n")[0]}\n`);
    });
  }
}
