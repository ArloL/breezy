// The B1 check itself, and that it fails on the hub when the edited card is left out of sight.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cases } from "./cases.ts";
import { outOfSight, watchSight } from "./sight.ts";
import { Device, type Sight } from "./device.ts";
import { World } from "./world.ts";
import { PHONE } from "../web/test/fakes.ts";
import { BINARY } from "../scripts/fuzz/swift-devices.ts";
import type { Point } from "../web/types.ts";

const board = { x: 0, y: 120, w: 402, h: 374 };

test("a card inside what shows is in sight", () => {
  assert.equal(outOfSight({ focus: { x: 20, y: 200, w: 240, h: 48 }, caret: { x: 32, y: 212, w: 0, h: 24 }, visible: board }), null);
});

test("a card under the keyboard is out of sight", () => {
  assert.match(outOfSight({ focus: { x: 20, y: 520, w: 240, h: 48 }, caret: { x: 32, y: 532, w: 0, h: 24 }, visible: board }) ?? "", /edited card/);
});

test("a card off the side is out of sight", () => {
  assert.notEqual(outOfSight({ focus: { x: 252, y: 200, w: 240, h: 48 }, caret: { x: 264, y: 212, w: 0, h: 24 }, visible: board }), null);
});

test("a card taller than what shows is in sight by its caret", () => {
  const focus = { x: 20, y: 0, w: 240, h: 900 };
  assert.equal(outOfSight({ focus, caret: { x: 32, y: 300, w: 0, h: 24 }, visible: board }), null);
  assert.notEqual(outOfSight({ focus, caret: { x: 32, y: 700, w: 0, h: 24 }, visible: board }), null);
});

test("a card within the app's 32 pt of filling what shows is in sight by its caret, as the app reveals only its line", () => {
  const focus = { x: 20, y: 100, w: 240, h: 360 };
  assert.equal(outOfSight({ focus, caret: { x: 32, y: 300, w: 0, h: 24 }, visible: board }), null);
});

test("nothing edited is nothing to check", () => {
  assert.equal(outOfSight({ focus: null, caret: null, visible: board }), null);
});

test("a failure names the focus, the caret and what shows", () => {
  assert.equal(outOfSight({ focus: { x: 20, y: 520, w: 240, h: 48 }, caret: { x: 32, y: 532, w: 0, h: 24 }, visible: board }),
    "the edited card at 20,520 240×48, its caret at 32,532 0×24, the board showing 0,120 402×374");
});

/** A device whose edited card, from a tap on, is at `y(ms since the tap)`. */
class Moving extends Device {
  readonly kind = "test";
  now = 0;
  tapped = -1;
  y: (t: number) => number;
  constructor(y: (t: number) => number) {
    super();
    this.y = y;
  }
  async pointer() {}
  async key() {}
  async scene(): Promise<never> {
    throw new Error("no scene");
  }
  async addCard() {
    return "";
  }
  async addLane() {
    return "";
  }
  async wait(ms: number) {
    this.now += ms;
  }
  override async tap(_p: Point) {
    this.tapped = this.now;
  }
  override async sight(): Promise<Sight> {
    return { focus: { x: 20, y: this.tapped < 0 ? 200 : this.y(this.now - this.tapped), w: 240, h: 48 }, caret: null, visible: board };
  }
}

test("a step that leaves the card at rest out of sight fails, naming the device and the step", async () => {
  await assert.rejects(watchSight(new Moving(() => 520)).tap({ x: 1, y: 2 }), /^Error: out of sight on test after tap\(\{"x":1,"y":2\}\): the edited card at 20,520/);
});

test("a card that comes to rest in sight passes, though it moved out of sight on the way", async () => {
  await watchSight(new Moving((t) => t < 600 ? 520 + t : 200)).tap({ x: 1, y: 2 });
});

test("a card in sight while the camera moves, at rest out of it, fails", async () => {
  await assert.rejects(watchSight(new Moving((t) => t < 400 ? 200 + t / 10 : 520)).tap({ x: 1, y: 2 }), /out of sight on test after tap/);
});

const zoomedOut = cases.find((c) => c.name.startsWith("a card made with a double tap at 25 %"))!;

test("the iOS new card's bug, planted, fails its case on the hub", { skip: !existsSync(BINARY) && "breezy-sim is not built", timeout: 120_000 }, async () => {
  const w = await World.start(["phone", "web"], 1, "reveal-current");
  try {
    // a keyboard that does not shrink the page, as the Home Screen app's seemed not to: nothing reveals the card again
    // before the first key, as the owner saw. Where it does, the plant stops the zoom half way instead, as in a tab.
    await w.hub.command(w.devices[0]!.d, { cmd: "screen", screen: { ...PHONE, keyboard: 0 } });
    await assert.rejects(zoomedOut.run({ devices: w.devices.map(watchSight), settle: () => w.settle() }), /out of sight on phone after doubleTap/);
  } finally {
    w.stop();
  }
});

test("the iOS new card's case passes on a phone whose keyboard does not shrink the page", { skip: !existsSync(BINARY) && "breezy-sim is not built", timeout: 120_000 }, async () => {
  const w = await World.start(["phone", "web"]);
  try {
    await w.hub.command(w.devices[0]!.d, { cmd: "screen", screen: { ...PHONE, keyboard: 0 } });
    await zoomedOut.run({ devices: w.devices.map(watchSight), settle: () => w.settle() });
  } finally {
    w.stop();
  }
});

test("a key is checked in two readings 20 ms apart, as nothing it starts waits to move", async () => {
  const d = new Moving(() => 200);
  await watchSight(d).key("a");
  assert.equal(d.now, 20);
});

test("a tap is checked in three readings 50 ms apart, as a keyboard may be on its way", async () => {
  const d = new Moving(() => 200);
  await watchSight(d).tap({ x: 1, y: 2 });
  assert.equal(d.now, 100);
});
