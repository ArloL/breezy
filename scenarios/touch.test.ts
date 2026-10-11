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

test("a card held and dragged into a lane on the phone lands in its column on the Mac", async () => {
  const { w, phone, mac, lane, card } = await phoneAndMac();
  try {
    const s = await phone.scene();
    await phone.touchDrag(centre(item(s, card)), centre(item(s, lane)));
    await w.settle();
    const seen = item(await mac.scene(), card);
    assert.deepEqual({ x: seen.x, y: seen.y }, { x: 24, y: 72 });
    assert.deepEqual(await mac.board(), await phone.board());
  } finally {
    w.stop();
  }
});

test("a finger dragged across a card without holding pans the board and moves nothing", async () => {
  const { w, phone, mac, card } = await phoneAndMac();
  try {
    const before = await phone.scene();
    await phone.touchDrag(centre(item(before, card)), { x: 300, y: 300 }, { hold: false });
    await w.settle();
    const after = await phone.scene();
    assert.notDeepEqual(after.camera, before.camera, "the camera moved");
    assert.deepEqual(item(after, card).x, item(before, card).x, "the card did not");
    assert.equal(item(await mac.scene(), card).x, 600);
  } finally {
    w.stop();
  }
});

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

test("two fingers spreading apart zoom in about their middle", async () => {
  const { w, phone } = await phoneAndMac();
  try {
    const touch = (finger: number) => ({ kind: "touch" as const, finger });
    await phone.pointer("down", { x: 500, y: 400 }, touch(1));
    await phone.pointer("down", { x: 600, y: 400 }, touch(2));
    for (let i = 1; i <= 10; i++) {
      await w.wait(16);
      await phone.pointer("move", { x: 500 - 10 * i, y: 400 }, touch(1));
      await phone.pointer("move", { x: 600 + 10 * i, y: 400 }, touch(2));
    }
    await phone.pointer("up", { x: 400, y: 400 }, touch(1));
    await phone.pointer("up", { x: 700, y: 400 }, touch(2));
    await w.wait(2000);
    const { camera } = await phone.scene();
    assert.ok(Math.abs(camera.zoom - 2) < 0.01, `zoom ${camera.zoom} is the fingers' spread, 3×, held to the limit of 2`);
    // the world point first under the fingers' middle stays there
    assert.ok(Math.abs((550 - camera.x) / camera.zoom - 550) < 1, `camera ${JSON.stringify(camera)}`);
  } finally {
    w.stop();
  }
});
