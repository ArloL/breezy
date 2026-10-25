// Every case on the hub's fakes, for each pair of kinds whose first takes the case's input: the Mac has no touch.
import { test } from "node:test";
import { cases } from "./cases.ts";
import { watchSight } from "./sight.ts";
import { World, type Kind } from "./world.ts";

const kinds: Kind[] = ["swift", "web", "phone"];

for (const c of cases) {
  for (const a of kinds) {
    if (c.input === "touch" && a === "swift") continue;
    // a phone acts only with a finger, and never watches
    if (c.input === "mouse" && a === "phone") continue;
    // the Mac's editing is in its app, not in its core yet
    if (c.edits && a === "swift") continue;
    if (c.offline || c.draws || c.busy) continue;
    for (const b of kinds.filter((k) => k !== "phone")) {
      test(`${c.name} (${a} → ${b})`, async () => {
        const w = await World.start([a, b]);
        try {
          await c.run({ devices: w.devices.map(watchSight), settle: () => w.settle() });
        } finally {
          w.stop();
        }
      });
    }
  }
}
