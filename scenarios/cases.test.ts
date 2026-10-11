// Every case on the hub's fakes, for each pair of kinds whose first takes the case's input: the Mac has no touch.
import { test } from "node:test";
import { cases } from "./cases.ts";
import { World, type Kind } from "./world.ts";

const kinds: Kind[] = ["swift", "web"];

for (const c of cases) {
  for (const a of kinds) {
    if (c.input === "touch" && a === "swift") continue;
    // the Mac's keys and editing are in its app, not in its core yet
    if ((c.edits || c.keys) && a === "swift") continue;
    for (const b of kinds) {
      test(`${c.name} (${a} → ${b})`, async () => {
        const w = await World.start([a, b]);
        try {
          await c.run({ devices: w.devices, settle: () => w.settle() });
        } finally {
          w.stop();
        }
      });
    }
  }
}
