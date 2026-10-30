// The cases on real devices against server/dev.sh and the relay under wrangler dev: the web app as it ships in headless
// Chromium, WebKit and Firefox, Chrome on the Android device adb sees, Firefox on the emulator, and the Debug Mac app. Slower: run with
//   node --test scenarios/browsers.e2e.ts
// under MISE_ENV=android mise exec -- after node scripts/android.ts for Android.
import { beforeEach, test } from "node:test";
import { execFileSync } from "node:child_process";
import { cases, type Case } from "./cases.ts";
import { dropFenix, RealWorld, rebootedAndroid, rebootFullEmulator, type RealKind } from "./browser.ts";
import { iosUnfit } from "./ios.ts";
import { macUnfit } from "./mac.ts";
import { exitsAfter } from "./exit.ts";
import { smoke } from "./smoke.ts";

const noMac = macUnfit();
const noIos = process.env.SCENARIO_PAIRS?.includes("ios-") ? await iosUnfit() : "Safari on iOS runs where SCENARIO_PAIRS names it";
const noAndroid = (() => {
  try {
    return !/\tdevice$/m.test(execFileSync("adb", ["devices"], { encoding: "utf8", timeout: 30_000 })) && "no Android device: run node scripts/android.ts";
  } catch {
    return "no adb: run under MISE_ENV=android mise exec --";
  }
})();
/** Each kind acts once and watches once, which a run of minutes can afford; a phone acts only with a finger, and the
 * emulator's two browsers never share a world, as only one is on its screen.
 * SCENARIO_PAIRS="chromium:mac mac:chromium" runs others, "mac:chromium mac:webkit mac:firefox" the Mac's copy into
 * each browser; SCENARIO_SMOKE=1 runs the cases marked smoke alone. */
const pairs = (process.env.SCENARIO_PAIRS?.split(" ").map((p) => p.split(":") as [RealKind, RealKind])
  ?? [["chromium", "firefox-android"], ["firefox-android", "webkit"], ["webkit", "firefox"], ["firefox", "mac"], ["mac", "android"], ["android", "chromium"]]);
const ios = (k: RealKind) => k === "ios-safari" || k === "ios-home";
const phone = (k: RealKind) => k === "android" || k === "firefox-android" || ios(k);
const android = (k: RealKind) => k === "android" || k === "firefox-android";

/** One run of each case, in a fresh world: a case that fails is a bug of its level, never run again into green. */
const MS = 90_000;
/** How long a world may take to start, outside its case's time: on CI's runner an iPhone once took 48 s to launch Safari
 * and 16 s to join, and its case had 4 s of its 90 left. */
const START_MS = 180_000;

// before a phone's case and outside its time: a boot takes minutes
beforeEach(async (t) => {
  if (noAndroid || !/android/.test(t.name)) return;
  const said = await rebootFullEmulator();
  if (said) console.log(said);
});

/** Worlds in a row whose servers did not start. Two say the machine cannot run any case, as when a port stayed taken,
 * and the cases left fail at once rather than each wait for the servers until the job times out. */
let unserved = 0, unservedBy = "";

/** One run of `c` on `kinds` in a fresh world, recorded; its error when it fails, or its world takes over `START_MS` to
 * start, or its case runs over `MS` after. */
async function once(name: string, c: Case, kinds: [RealKind, RealKind], run: number): Promise<Error | null> {
  const w = new RealWorld();
  let error: Error | null = null, timedOut = false, timer: ReturnType<typeof setTimeout> | undefined;
  /** `p`, or an error saying `what` once `ms` pass. */
  const within = (p: Promise<unknown>, ms: number, what: string) => Promise.race([p, new Promise((_, reject) => (timer = setTimeout(() => {
    timedOut = true;
    reject(new Error(what));
  }, ms)))]).finally(() => clearTimeout(timer));
  try {
    await within(w.start(kinds, { fresh: c.fresh }), START_MS, `the world did not start in ${START_MS} ms`);
    await within(c.run(w.stage()), c.ms ?? MS, `timed out after ${c.ms ?? MS} ms`);
  } catch (e) {
    error = e as Error;
  } finally {
    clearTimeout(timer);
    await w.record(name, { name: c.name, pair: kinds, run }, error, timedOut);
    // Firefox for Android kept for the next case after a pass
    await w.stop(!error);
  }
  const serve = w.steps.list.find((s) => s.who === "world" && s.action === "serve");
  [unserved, unservedBy] = serve?.error ? [unserved + 1, serve.error] : [0, ""];
  // now, as a job that times out never gets to node's summary of the failures
  if (error) console.log(`run ${run} of ${name} failed: ${error.message.split("\n")[0]}`);
  return error;
}

for (const c of smoke(cases)) {
  for (const [a, b] of pairs) {
    // Safari on the iOS Simulator has one finger, and cannot go offline, be kept busy or start outside the space yet
    if (c.input === "touch" && a === "mac" || c.input === "mouse" && phone(a) || c.acts && !c.acts.includes(a) || c.watches && !c.watches.includes(b) || ios(a) && ((c.fingers ?? 1) > 1 || c.offline || c.busy || c.fresh || c.notOnIphone)) continue;
    const skip = [a, b].includes("mac") && noMac || [a, b].some(android) && noAndroid || [a, b].some(ios) && noIos;
    test(`${c.name} (${a} → ${b})`, { skip, timeout: START_MS + (c.ms ?? MS) + 60_000 }, async (t) => {
      if (unserved >= 2) throw new Error(`not run: the servers did not start for the last ${unserved} cases: ${unservedBy}`);
      // outside the run's time, as a panic in the case before leaves a phone booting
      if ([a, b].some(android)) {
        const said = await rebootedAndroid();
        if (said) console.log(said);
      }
      const e = await once(t.name, c, [a, b], 1);
      if (e) throw e;
    });
  }
}

// last, so that the file's own cleanup runs before its 10 s begin
exitsAfter(dropFenix);
