// The cases on real devices against server/dev.sh and the relay under wrangler dev: the web app as it ships in headless
// Chromium, WebKit and Firefox, Chrome on the Android device adb sees, Firefox on the emulator, and the Debug Mac app. Slower: run with
//   node --test scenarios/browsers.e2e.ts
// under MISE_ENV=android mise exec -- after node scripts/android.ts for Android.
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cases, type Case } from "./cases.ts";
import { RealWorld, type RealKind } from "./browser.ts";
import { MAC_APP } from "./mac.ts";
import { RECORDS } from "./record.ts";

const noMac = !existsSync(MAC_APP) && "the Debug Mac app is not built";
const noAndroid = (() => {
  try {
    return !/\tdevice$/m.test(execFileSync("adb", ["devices"], { encoding: "utf8", timeout: 30_000 })) && "no Android device: run node scripts/android.ts";
  } catch {
    return "no adb: run under MISE_ENV=android mise exec --";
  }
})();
/** Each kind acts once and watches once, which a run of minutes can afford; a phone acts only with a finger, and the
 * emulator's two browsers never share a world, as only one is on its screen.
 * SCENARIO_PAIRS="chromium:mac mac:chromium" runs others. */
const pairs = (process.env.SCENARIO_PAIRS?.split(" ").map((p) => p.split(":") as [RealKind, RealKind])
  ?? [["chromium", "firefox-android"], ["firefox-android", "webkit"], ["webkit", "firefox"], ["firefox", "mac"], ["mac", "android"], ["android", "chromium"]]);
const phone = (k: RealKind) => k === "android" || k === "firefox-android";

/** Runs a case gets before it fails, each in a fresh world: Main gives 2, so that a rare flake warns where it would block
 * a merge, and lists it in build/scenarios/flaky.txt; soaks give 1, to count every failure. */
const RUNS = Number(process.env.SCENARIO_RUNS ?? 1);
const MS = 90_000;

/** Worlds in a row whose servers did not start. Two say the machine cannot run any case, as when a port stayed taken,
 * and the cases left fail at once rather than each wait for the servers until the job times out. */
let unserved = 0, unservedBy = "";

/** One run of `c` on `kinds` in a fresh world, recorded; its error when it fails or takes over `MS`. */
async function once(name: string, c: Case, kinds: [RealKind, RealKind], run: number): Promise<Error | null> {
  const w = new RealWorld();
  let error: Error | null = null, timedOut = false, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        await w.start(kinds);
        await c.run(w.stage());
      })(),
      new Promise((_, reject) => (timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`timed out after ${c.ms ?? MS} ms`));
      }, c.ms ?? MS))),
    ]);
  } catch (e) {
    error = e as Error;
  } finally {
    clearTimeout(timer);
    await w.record(name, { name: c.name, pair: kinds, run }, error, timedOut);
    await w.stop();
  }
  const serve = w.steps.list.find((s) => s.who === "world" && s.action === "serve");
  [unserved, unservedBy] = serve?.error ? [unserved + 1, serve.error] : [0, ""];
  // now, as a job that times out never gets to node's summary of the failures
  if (error) console.log(`run ${run} of ${name} failed: ${error.message.split("\n")[0]}`);
  return error;
}

for (const c of cases) {
  for (const [a, b] of pairs) {
    if (c.input === "touch" && a === "mac" || c.input === "mouse" && phone(a) || c.acts && !c.acts.includes(a) || c.watches && !c.watches.includes(b)) continue;
    test(`${c.name} (${a} → ${b})`, { skip: [a, b].includes("mac") && noMac || [a, b].some(phone) && noAndroid, timeout: RUNS * ((c.ms ?? MS) + 60_000) }, async (t) => {
      let first: Error | null = null;
      for (let run = 1; ; run++) {
        if (unserved >= 2) throw new Error(`not run: the servers did not start for the last ${unserved} cases: ${unservedBy}`);
        const e = await once(t.name, c, [a, b], run);
        if (!e) break;
        if (run === RUNS) throw first ?? e;
        first ??= e;
      }
      if (!first) return;
      t.diagnostic(`flaky: failed once, then passed: ${first.message}`);
      mkdirSync(RECORDS, { recursive: true });
      appendFileSync(join(RECORDS, "flaky.txt"), `${t.name}: ${first.message.split("\n")[0]}\n`);
    });
  }
}
