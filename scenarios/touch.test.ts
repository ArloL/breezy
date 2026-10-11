// The phone: a finger on the web app, and what the others see of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { World, centre, item, type SimDevice } from "./world.ts";

async function phoneAndMac() {
  const w = await World.start(["web", "swift"]);
  const [phone, mac] = w.devices as [SimDevice, SimDevice];
  const lane = await mac.addLane(0, 0);
  const card = await mac.addCard(600, 72);
  await w.settle();
  return { w, phone, mac, lane, card };
}

test("a tap on a card selects it, and the Mac sees nothing move", async () => {
  const { w, phone, mac, card } = await phoneAndMac();
  try {
    await phone.tap(centre(item(await phone.scene(), card)));
    await w.wait(400);
    assert.equal(item(await phone.scene(), card).selected, true);
    await w.settle();
    assert.equal(item(await mac.scene(), card).x, 600);
  } finally {
    w.stop();
  }
});
