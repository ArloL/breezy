// The scenarios that matter most, on the web app as it ships in real browsers and on the Debug Mac app. Slower: run with
//   node --test scenarios/browsers.e2e.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { RealWorld, centre, item, type RealKind } from "./browser.ts";
import { MAC_APP } from "./mac.ts";

const noMac = !existsSync(MAC_APP) && "the Debug Mac app is not built";

const pairs: [RealKind, RealKind][] = [["chromium", "webkit"], ["webkit", "chromium"], ["mac", "chromium"], ["webkit", "mac"]];

for (const [mover, watcher] of pairs) {
  test(`a card a mouse drags into a lane in ${mover} shows there in ${watcher}`, { skip: [mover, watcher].includes("mac") && noMac }, async () => {
    const w = await RealWorld.start([mover, watcher]);
    try {
      const [a, b] = w.devices as [typeof w.devices[0], typeof w.devices[0]];
      const lane = await a.addLane(100, 100);
      const l0 = item(await a.scene(), lane);
      const card = await a.addCard(l0.x + l0.w + 200, l0.y + 200);
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
  const w = await RealWorld.start(["webkit", "chromium"]);
  try {
    const [phone, desk] = w.devices as [typeof w.devices[0], typeof w.devices[0]];
    const lane = await desk.addLane(100, 100);
    const l0 = item(await desk.scene(), lane);
    const card = await desk.addCard(l0.x + l0.w + 200, l0.y + 200);
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
