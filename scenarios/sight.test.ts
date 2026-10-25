// The B1 check itself, and that it fails on the hub when the edited card is left out of sight.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cases } from "./cases.ts";
import { outOfSight, watchSight } from "./sight.ts";
import { Device, type Sight } from "./device.ts";
import { World } from "./world.ts";
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

test("nothing edited is nothing to check", () => {
  assert.equal(outOfSight({ focus: null, caret: null, visible: board }), null);
});

test("a failure names the focus, the caret and what shows", () => {
  assert.equal(outOfSight({ focus: { x: 20, y: 520, w: 240, h: 48 }, caret: { x: 32, y: 532, w: 0, h: 24 }, visible: board }),
    "the edited card at 20,520 240×48, its caret at 32,532 0×24, the board showing 0,120 402×374");
});

/** A device whose edited card goes under the keyboard on a tap, and comes back in sight `late` ms later. */
class Leaving extends Device {
  readonly kind = "test";
  now = 0;
  away = -1;
  late: number;
  constructor(late: number) {
    super();
    this.late = late;
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
    this.away = this.now;
  }
  override async sight(): Promise<Sight> {
    const gone = this.away >= 0 && this.now - this.away < this.late;
    return { focus: { x: 20, y: gone ? 520 : 200, w: 240, h: 48 }, caret: null, visible: board };
  }
}

test("a step that leaves the card out of sight past a second fails, naming the step", async () => {
  await assert.rejects(watchSight(new Leaving(2000)).tap({ x: 1, y: 2 }), /^Error: out of sight after tap\(\{"x":1,"y":2\}\): the edited card at 20,520/);
});

test("a card back in sight within the second passes", async () => {
  await watchSight(new Leaving(600)).tap({ x: 1, y: 2 });
});

const zoomedOut = cases.find((c) => c.name.startsWith("a card made with a double tap at 25 %"))!;

test("the iOS new card's bug, planted, fails its case on the hub", { skip: !existsSync(BINARY) && "breezy-sim is not built", timeout: 120_000 }, async () => {
  const w = await World.start(["phone", "web"], 1, "reveal-current");
  try {
    // on the hub the plant stops the zoom half way, as in a Safari tab, rather than leave the caret off screen
    await assert.rejects(zoomedOut.run({ devices: w.devices.map(watchSight), settle: () => w.settle() }), /out of sight after doubleTap|fingers edit at 100 %/);
  } finally {
    w.stop();
  }
});
