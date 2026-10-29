// The phone: a finger on the web app, and what the others see of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PHONES, World, centre, item, type Kind, type SimDevice } from "./world.ts";
import { SAFARI } from "../web/test/fakes.ts";

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

test("a tap or double tap aimed off the phone's screen fails at once, as an iPhone's status bar takes the touch", async () => {
  const w = await World.start(["phone", "web"]);
  try {
    const phone = w.devices[0]!, { w: width, h } = await phone.size();
    for (const p of [{ x: width / 2, y: -15 }, { x: width + 10, y: h / 2 }, { x: width / 2, y: h + 1 }]) {
      await assert.rejects(phone.doubleTap(await phone.world(p)), /off the screen/);
      await assert.rejects(phone.tap(await phone.world(p)), /off the screen/);
    }
  } finally {
    w.stop();
  }
});

test("a tap on a phone's bars, or on its keyboard, fails at once, as they take the touch on a real phone", { timeout: 30_000 }, async () => {
  const w = await World.start(["safari", "web"]);
  try {
    const phone = w.devices[0]!;
    for (const y of [30, SAFARI.bottom + 10]) await assert.rejects(phone.tap(await phone.world({ x: 100, y })), /off the board/);
    await phone.doubleTap(await phone.world({ x: 100, y: 200 }));
    await phone.still("the keyboard to come");
    await assert.rejects(phone.tap(await phone.world({ x: 100, y: SAFARI.h - SAFARI.keyboard / 2 })), /off the board/);
  } finally {
    w.stop();
  }
});

test("each of the hub's phones is its page's size, and opens a board as its browser does: at ×0.75, 16 pt inside the board", { timeout: 60_000 }, async () => {
  for (const [kind, screen] of Object.entries(PHONES) as [Kind, NonNullable<(typeof PHONES)[Kind]>][]) {
    const w = await World.start([kind, "web"]);
    try {
      const phone = w.devices[0]!;
      assert.deepEqual(await phone.size(), { w: screen.w, h: screen.h }, kind);
      assert.deepEqual((await phone.scene()).camera, { x: 16, y: screen.top + 16, zoom: 0.75 }, kind);
    } finally {
      w.stop();
    }
  }
});

test("a phone makes a card as a real phone's harness does, by editing it, which leaves the board at ×1", { timeout: 30_000 }, async () => {
  const w = await World.start(["safari", "web"]);
  try {
    const phone = w.devices[0]!, p = await phone.world({ x: 200, y: 300 });
    const id = await phone.addCard(p.x, p.y);
    const s = await phone.scene();
    assert.equal(item(s, id).text, "card");
    assert.equal(s.camera.zoom, 1);
  } finally {
    w.stop();
  }
});
