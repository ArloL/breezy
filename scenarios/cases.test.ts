// Every case on the hub's fakes, for each pair of kinds whose first takes the case's input: the Mac has no touch.
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cases } from "./cases.ts";
import { watchSight } from "./sight.ts";
import { PHONES, World, type Kind } from "./world.ts";

const kinds: Kind[] = ["swift", "web", "phone", "mini", "safari", "safari-mini", "android"];
/** Where a failing case keeps its devices' recordings, and with HUB_RECORDS=all a passing one too, for the fakes to be
 * held to the real devices nightly (scripts/parity.ts). */
const RECORDS = join(new URL("..", import.meta.url).pathname, "build", "hub");
const ALL = process.env.HUB_RECORDS === "all";

/** The devices' recordings and what the case was, as a real device's run keeps them; whatever they do, nothing thrown. */
async function keep(dir: string, w: World, run: { case: string; pair: Kind[]; verdict: string }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "case.json"), `${JSON.stringify(run)}\n`);
  await Promise.all(w.devices.map(async (d, i) => {
    const r = await d.flight().catch(() => null);
    if (r) writeFileSync(join(dir, `d${i} ${d.kind} flight.json`), `${JSON.stringify(r)}\n`);
  })).catch(() => {});
}

for (const c of cases) {
  for (const a of kinds) {
    if (c.input === "touch" && a === "swift") continue;
    // a phone acts only with a finger, and never watches
    if (c.input === "mouse" && PHONES[a]) continue;
    // the Mac's editing is in its app, not in its core yet
    if (c.edits && a === "swift") continue;
    // the Mac pans in its view, not in its core
    if (c.pans && a === "swift") continue;
    if (c.offline || c.draws || c.busy || c.fresh || c.buttons || c.outage) continue;
    for (const b of kinds.filter((k) => !PHONES[k])) {
      const name = `${c.name} (${a} → ${b})`;
      test(name, async () => {
        const w = await World.start([a, b]);
        const dir = join(RECORDS, name.replace(/[^\w -]+/g, "").slice(0, 120));
        try {
          await c.run({ devices: w.devices.map(watchSight), settle: () => w.settle() });
          if (ALL) await keep(dir, w, { case: c.name, pair: [a, b], verdict: "passed" });
        } catch (e) {
          await keep(dir, w, { case: c.name, pair: [a, b], verdict: "failed" }).catch(() => {});
          if (e instanceof Error) e.message += `\nrecordings in ${dir}`;
          throw e;
        } finally {
          w.stop();
        }
      });
    }
  }
}
