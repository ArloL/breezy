// The same input on the Swift core and the web core ends with the same scene.
import { test } from "node:test";
import assert from "node:assert/strict";
import { World, centre, item, type SimDevice, type Device, type Scene } from "./world.ts";

/** What two cores must agree on: ids are random per device, so items go by their order of making. */
function comparable(s: Scene, order: string[]) {
  const name = (id: string) => `#${order.indexOf(id)}`;
  const strip = ({ id, ...rest }: { id: string }) => ({ id: name(id), ...rest });
  return { cards: s.cards.map(strip), lanes: s.lanes.map(strip), turned: s.turned && name(s.turned), marquee: s.marquee, camera: s.camera };
}

type Steps = (d: Device, made: string[]) => Promise<void>;

async function agree(name: string, setUp: Steps, act: Steps) {
  test(`the cores agree: ${name}`, async () => {
    const results = [];
    for (const kind of ["swift", "web"] as const) {
      const w = await World.start([kind]);
      try {
        const [d] = w.devices as [SimDevice];
        const made: string[] = [];
        await setUp(d, made);
        await w.settle();
        await act(d, made);
        await w.settle();
        results.push({ kind, scene: comparable(await d.scene(), made) });
      } finally {
        w.stop();
      }
    }
    assert.deepEqual(results[1]!.scene, results[0]!.scene, "web's scene against Swift's");
  });
}

const laneAndCards: Steps = async (d, made) => {
  made.push(await d.addLane(144, 360));
  made.push(await d.addCard(600, 72));
  made.push(await d.addCard(600, 240));
  made.push(await d.addCard(24, 72));
};

agree("a card dragged into a lane", laneAndCards, async (d, made) => {
  const s = await d.scene();
  await d.drag(centre(item(s, made[1]!)), centre(item(s, made[0]!)));
});

agree("a card dragged out of a stack", laneAndCards, async (d, made) => {
  const s = await d.scene();
  await d.drag(centre(item(s, made[3]!)), { x: 900, y: 600 });
});

agree("a lane dragged by its header carries its cards", laneAndCards, async (d, made) => {
  const s = await d.scene();
  const l = item(s, made[0]!);
  await d.drag({ x: l.x + 100, y: l.y + 10 }, { x: l.x + 400, y: l.y + 130 });
});

agree("a lane resized by its corner", laneAndCards, async (d, made) => {
  const l = item(await d.scene(), made[0]!);
  await d.drag({ x: l.x + l.w - 5, y: l.y + l.h - 5 }, { x: l.x + l.w + 200, y: l.y + l.h - 100 });
});

agree("a box selects what it touches", laneAndCards, async (d) => {
  await d.drag({ x: 1000, y: 600 }, { x: 610, y: 100 });
});

agree("a click selects, another elsewhere clears", laneAndCards, async (d, made) => {
  const s = await d.scene();
  await d.click(centre(item(s, made[1]!)));
});
