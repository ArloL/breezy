import { test } from "node:test";
import assert from "node:assert/strict";
import { World, centre, item, type Kind } from "./world.ts";

const pairs: [Kind, Kind][] = [["swift", "swift"], ["swift", "web"], ["web", "swift"], ["web", "web"]];

for (const [mover, watcher] of pairs) {
  test(`a card a ${mover} device drags into a lane shows there on a ${watcher} device`, async () => {
    const w = await World.start([mover, watcher]);
    try {
      const [a, b] = w.devices as [typeof w.devices[0], typeof w.devices[0]];
      const lane = await a.addLane(0, 0);
      const card = await a.addCard(600, 72);
      await w.settle();
      const before = await a.scene();
      await a.drag(centre(item(before, card)), centre(item(before, lane)));
      await w.settle();

      const seen = item(await b.scene(), card);
      const l = item(await b.scene(), lane);
      assert.ok(seen.x >= l.x && seen.x + seen.w <= l.x + l.w, `the card (${seen.x}) is inside the lane (${l.x}–${l.x + l.w})`);
      assert.equal(seen.x, l.x + 24, "in its column");
      assert.equal(seen.y, l.y + 72, "at the top of its column");
      assert.equal(seen.held, false);
      assert.deepEqual(await b.board(), await a.board());
    } finally {
      w.stop();
    }
  });
}
