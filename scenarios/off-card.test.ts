// Where a case taps to end a card's edit: on the board that shows, clear of the bars over it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { offCard } from "./cases.ts";
import { Device, type Scene, type Sight } from "./device.ts";

/** An iPhone 13 mini editing a card at world 120,600, the camera `y` pt down, and its page scrolled `scrolled` pt, as iOS
 * scrolls it to show a field the keyboard would cover: the sight in the page's frame, the camera in the board's. */
class Mini extends Device {
  readonly kind = "test";
  readonly y: number;
  readonly scrolled: number;
  constructor(y: number, scrolled: number) {
    super();
    [this.y, this.scrolled] = [y, scrolled];
  }
  async pointer() {}
  async key(_key: string) {}
  async wait() {}
  async addCard() {
    return "";
  }
  async addLane() {
    return "";
  }
  override async size() {
    return { w: 375, h: 762 };
  }
  async scene(): Promise<Scene> {
    const card = { id: "c", x: 120, y: 600, w: 240, h: 48, selected: true, held: false };
    return { cards: [card], lanes: [], turned: null, marquee: null, camera: { x: -44, y: this.y, zoom: 1 } };
  }
  override async sight(): Promise<Sight> {
    // the top bar's bottom at 58 and the keys bar's top at 340, as the nights of 2026-10-28 and 29 recorded them
    return { focus: { x: 76, y: 600 + this.y - this.scrolled, w: 240, h: 48 }, caret: null, visible: { x: 0, y: 58, w: 375, h: 282 } };
  }
}

test("a card iOS scrolled to just under the top bar is tapped off below it, not on the bar's person", async () => {
  const d = new Mini(-176, 350), p = await d.screen(await offCard(d, "c"));
  const page = p.y - 350;
  assert.ok(page >= 58 && page <= 340, `the tap at ${page} in the page, the board showing 58–340`);
  assert.ok(page > 74 + 48, "below the card");
});

test("a card the board panned above the keyboard is tapped off 40 pt above it", async () => {
  const d = new Mini(-324, 0);
  assert.deepEqual(await d.screen(await offCard(d, "c")), { x: 196, y: 236 });
});
