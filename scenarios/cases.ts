// Scenarios written once for any kind of device: on the hub's fakes (cases.test.ts) and on real devices
// (browsers.e2e.ts). Each acts on the first device and looks at what the second shows.
import assert from "node:assert/strict";
import { centre, item, type Device } from "./device.ts";

export interface Stage {
  devices: Device[];
  /** Until what one device did shows on the others. */
  settle(): Promise<void>;
}

export interface Case {
  name: string;
  /** What the first device's input must be. */
  input: "mouse" | "touch";
  run(s: Stage): Promise<void>;
}

/** A lane in the middle of the first device's screen and a card beside it, made there, and seen by the others. */
async function laneAndCard({ devices: [a], settle }: Stage) {
  const middle = await a!.world({ x: 450, y: 440 });
  const lane = await a!.addLane(middle.x, middle.y);
  const l = item(await a!.scene(), lane);
  const card = await a!.addCard(l.x + l.w + 200, l.y + 200);
  await settle();
  return { lane, card };
}

/** Where `id` is drawn relative to `lane` on device `d`. */
async function within(d: Device, lane: string, id: string) {
  const s = await d.scene();
  const l = item(s, lane), c = item(s, id);
  return { x: c.x - l.x, y: c.y - l.y };
}

export const cases: Case[] = [
  {
    name: "a card dragged into a lane shows at the top of the lane's column on the other device",
    input: "mouse",
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { lane, card } = await laneAndCard(s);
      const at = await a.scene();
      await a.drag(centre(item(at, card)), centre(item(at, lane)));
      await s.settle();
      assert.deepEqual(await within(b, lane, card), { x: 24, y: 72 });
      assert.equal(item(await b.scene(), card).held, false);
    },
  },
  {
    name: "a card held and dragged into a lane with a finger shows at the top of its column on the other device",
    input: "touch",
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { lane, card } = await laneAndCard(s);
      const at = await a.scene();
      await a.touchDrag(centre(item(at, card)), centre(item(at, lane)));
      await s.settle();
      assert.deepEqual(await within(b, lane, card), { x: 24, y: 72 });
    },
  },
  {
    name: "a lane dragged by its header carries the cards in it, on the other device too",
    input: "mouse",
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { lane, card } = await laneAndCard(s);
      let at = await a.scene();
      await a.drag(centre(item(at, card)), centre(item(at, lane)));
      await s.settle();
      at = await a.scene();
      const l = item(at, lane);
      await a.drag({ x: l.x + 100, y: l.y + 10 }, { x: l.x + 196, y: l.y + 58 });
      await s.settle();
      const seen = item(await b.scene(), lane);
      assert.deepEqual({ dx: seen.x - l.x, dy: seen.y - l.y }, { dx: 96, dy: 48 });
      assert.deepEqual(await within(b, lane, card), { x: 24, y: 72 });
    },
  },
  {
    name: "a finger dragged across a card that is not selected without holding pans, and moves nothing on the other device",
    input: "touch",
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { card } = await laneAndCard(s);
      const made = item(await a.scene(), card);
      await a.tap({ x: made.x + made.w + 100, y: made.y + made.h + 100 });
      await a.wait(400);
      const before = await a.scene(), seen = item(await b.scene(), card);
      const c = item(before, card);
      assert.equal(c.selected, false, "a tap on nothing clears the selection");
      await a.touchDrag(centre(c), { x: c.x - 200, y: c.y + 100 }, { hold: false });
      await s.settle();
      const after = await a.scene();
      assert.notDeepEqual(after.camera, before.camera, "the camera moved");
      assert.deepEqual({ x: item(after, card).x, y: item(after, card).y }, { x: c.x, y: c.y }, "the card did not");
      assert.deepEqual({ x: item(await b.scene(), card).x, y: item(await b.scene(), card).y }, { x: seen.x, y: seen.y });
    },
  },
];
