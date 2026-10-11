// The scenarios that matter most, on the web app as it ships, in real browsers. Slower: run with
//   node --test scenarios/browsers.e2e.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserWorld, centre, item, type BrowserKind } from "./browser.ts";

const pairs: [BrowserKind, BrowserKind][] = [["chromium", "webkit"], ["webkit", "chromium"]];

for (const [mover, watcher] of pairs) {
  test(`a card a mouse drags into a lane in ${mover} shows there in ${watcher}`, async () => {
    const w = await BrowserWorld.start([mover, watcher]);
    try {
      const [a, b] = w.devices as [typeof w.devices[0], typeof w.devices[0]];
      const lane = await a.addLane(100, 100);
      const card = await a.addCard(900, 300);
      await w.settle();
      const s = await a.scene();
      await a.drag(centre(item(s, card)), centre(item(s, lane)));
      await w.settle();
      const l = item(await b.scene(), lane), c = item(await b.scene(), card);
      assert.deepEqual({ x: c.x, y: c.y }, { x: l.x + 24, y: l.y + 72 }, "in the lane's column, at its top");
    } finally {
      await w.stop();
    }
  });
}

test("a card held and dragged into a lane with a finger in webkit shows there in chromium", async () => {
  const w = await BrowserWorld.start(["webkit", "chromium"]);
  try {
    const [phone, desk] = w.devices as [typeof w.devices[0], typeof w.devices[0]];
    const lane = await desk.addLane(100, 100);
    const card = await desk.addCard(900, 300);
    await w.settle();
    const s = await phone.scene();
    await phone.touchDrag(centre(item(s, card)), centre(item(s, lane)));
    await w.settle();
    const l = item(await desk.scene(), lane), c = item(await desk.scene(), card);
    assert.deepEqual({ x: c.x, y: c.y }, { x: l.x + 24, y: l.y + 72 });
  } finally {
    await w.stop();
  }
});
