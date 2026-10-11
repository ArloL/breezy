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
  /** Whether the first device must edit text, which the hub's fakes cannot yet. */
  edits?: boolean;
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
  {
    name: "text typed into a card shows on the other device",
    input: "mouse",
    edits: true,
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { card } = await laneAndCard(s);
      const before = item(await a.scene(), card).text;
      await a.typeInto(card, " and more");
      await s.settle();
      assert.equal(item(await b.scene(), card).text, `${before} and more`);
    },
  },
  {
    name: "a colour key recolours the card clicked on the other device",
    input: "mouse",
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { card } = await laneAndCard(s);
      await a.click(centre(item(await a.scene(), card)));
      await a.key("3");
      await s.settle();
      assert.equal(item(await b.scene(), card).color, 3);
    },
  },
  {
    name: "⌫ deletes the card clicked, on the other device too",
    input: "mouse",
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { card } = await laneAndCard(s);
      await a.click(centre(item(await a.scene(), card)));
      await a.key("Backspace");
      await s.settle();
      assert.equal((await b.scene()).cards.some((c) => c.id === card), false);
    },
  },
  {
    name: "⌘Z puts a card dragged into a lane back where it was, on the other device too",
    input: "mouse",
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { lane, card } = await laneAndCard(s);
      const at = await a.scene(), was = item(await b.scene(), card);
      await a.drag(centre(item(at, card)), centre(item(at, lane)));
      await s.settle();
      await a.key("z", { meta: true });
      await s.settle();
      const now = item(await b.scene(), card);
      assert.deepEqual({ x: now.x, y: now.y }, { x: was.x, y: was.y });
    },
  },
  {
    name: "a lane resized by its corner has that size on the other device",
    input: "mouse",
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { lane } = await laneAndCard(s);
      const l = item(await a.scene(), lane);
      await a.drag({ x: l.x + l.w - 6, y: l.y + l.h - 6 }, { x: l.x + l.w + 90, y: l.y + l.h - 102 });
      await s.settle();
      const seen = item(await b.scene(), lane);
      assert.deepEqual({ w: seen.w, h: seen.h }, { w: l.w + 96, h: l.h - 96 });
    },
  },
  {
    name: "a card dragged out of a stack lets the one below it close up, on the other device too",
    input: "mouse",
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { lane, card } = await laneAndCard(s);
      let at = await a.scene();
      await a.drag(centre(item(at, card)), centre(item(at, lane)));
      const l = item(at, lane);
      const second = await a.addCard(l.x + l.w + 200, l.y + 400);
      await s.settle();
      at = await a.scene();
      await a.drag(centre(item(at, second)), centre(item(at, lane)));
      await s.settle();
      assert.deepEqual(await within(b, lane, second), { x: 24, y: 72 + item(await b.scene(), card).h + 24 }, "stacked below the first");
      at = await a.scene();
      await a.drag(centre(item(at, card)), { x: l.x + l.w + 300, y: l.y + 100 });
      await s.settle();
      assert.deepEqual(await within(b, lane, second), { x: 24, y: 72 }, "closed up to the top");
    },
  },
  {
    name: "a card one device holds stays where it holds it when the other drags it",
    input: "mouse",
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { lane, card } = await laneAndCard(s);
      const at = await a.scene();
      const c = centre(item(at, card)), l = centre(item(at, lane));
      const [pa, pl] = [await a.screen(c), await a.screen(l)];
      await a.pointer("down", pa);
      await a.pointer("move", { x: pa.x - 20, y: pa.y + 20 });
      await a.wait(100);
      await s.settle();
      const bs = await b.scene();
      const target = { x: item(bs, card).x + 300, y: item(bs, card).y + 300 };
      await b.drag(centre(item(bs, card)), target);
      await b.wait(100);
      const tried = item(await b.scene(), card);
      assert.ok(Math.abs(tried.x - target.x) > 100, `the other device could not move it (at ${tried.x}, dragged to about ${target.x})`);
      await a.pointer("move", pl);
      await a.wait(50);
      await a.pointer("up", pl);
      await s.settle();
      assert.deepEqual(await within(b, lane, card), { x: 24, y: 72 }, "where the holder put it");
      assert.deepEqual(await within(a, lane, card), { x: 24, y: 72 });
    },
  },
  {
    name: "a card made with a double tap and typed into on a phone shows its text on the other device",
    input: "touch",
    edits: true,
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { lane } = await laneAndCard(s);
      const l = item(await a.scene(), lane);
      const had = new Set((await a.scene()).cards.map((c) => c.id));
      await a.doubleTap({ x: l.x + l.w + 150, y: l.y + 450 });
      await a.wait(300);
      await a.type("from the phone");
      // a tap on the board ends the edit, as there is no Esc on a phone
      await a.tap({ x: l.x + l.w + 500, y: l.y + 600 });
      await s.settle();
      const made = (await b.scene()).cards.filter((c) => !had.has(c.id));
      assert.deepEqual(made.map((c) => c.text), ["from the phone"]);
    },
  },
  {
    name: "a lane renamed from its header has the new name on the other device",
    input: "mouse",
    edits: true,
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { lane } = await laneAndCard(s);
      await a.rename(lane, "Doing");
      await s.settle();
      assert.equal(item(await b.scene(), lane).title, "Doing");
    },
  },
  {
    name: "a box drawn on empty space selects the cards it touches, and the other device sees nothing move",
    input: "mouse",
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { card } = await laneAndCard(s);
      const c = item(await a.scene(), card), seen = item(await b.scene(), card);
      await a.drag({ x: c.x + c.w + 60, y: c.y + c.h + 60 }, { x: c.x + 20, y: c.y + 20 });
      assert.equal(item(await a.scene(), card).selected, true);
      await s.settle();
      assert.deepEqual({ x: item(await b.scene(), card).x, y: item(await b.scene(), card).y }, { x: seen.x, y: seen.y });
    },
  },
  {
    name: "Space turns the card under the pointer over, and again turns it back",
    input: "mouse",
    async run(s) {
      const [a] = s.devices as [Device, Device];
      const { card } = await laneAndCard(s);
      const c = centre(item(await a.scene(), card));
      await a.click(c);
      await a.key(" ");
      assert.equal((await a.scene()).turned, card);
      await a.key(" ");
      assert.equal((await a.scene()).turned, null);
    },
  },
  {
    name: "two fingers spreading apart zoom in about their middle",
    input: "touch",
    async run(s) {
      const [a] = s.devices as [Device, Device];
      await laneAndCard(s);
      const before = (await a.scene()).camera;
      const touch = (finger: number) => ({ kind: "touch" as const, finger });
      await a.pointer("down", { x: 500, y: 400 }, touch(1));
      await a.pointer("down", { x: 600, y: 400 }, touch(2));
      for (let i = 1; i <= 10; i++) {
        await a.wait(16);
        await a.fingers("move", [[1, { x: 500 - 5 * i, y: 400 }], [2, { x: 600 + 5 * i, y: 400 }]]);
      }
      await a.pointer("up", { x: 450, y: 400 }, touch(1));
      await a.pointer("up", { x: 650, y: 400 }, touch(2));
      await a.wait(1500);
      const { camera } = await a.scene();
      const zoom = Math.min(2, before.zoom * 2);
      assert.ok(Math.abs(camera.zoom - zoom) < 0.02, `zoom ${camera.zoom}, the fingers' spread doubled from ${before.zoom}`);
      // the world point first under the fingers' middle stays there, within a few points: a browser hands the app one
      // finger's move at a time, so the middle wobbles between them and the release may coast a little
      const w0 = (550 - before.x) / before.zoom, w1 = (550 - camera.x) / camera.zoom;
      assert.ok(Math.abs(w1 - w0) < 4, `world x ${w1} under the middle, was ${w0}`);
    },
  },
];
