// The same input on the Swift core and the web core ends with the same scene, by the same transitions.
import { centre, item } from "./world.ts";
import { parity, type Steps } from "./parity/core.ts";

const laneAndCards: Steps = async (d, made) => {
  made.push(await d.addLane(144, 360));
  made.push(await d.addCard(600, 72));
  made.push(await d.addCard(600, 240));
  made.push(await d.addCard(24, 72));
};

parity("a card dragged into a lane", laneAndCards, async (d, made) => {
  const s = await d.scene();
  await d.drag(centre(item(s, made[1]!)), centre(item(s, made[0]!)));
});

parity("a card dragged out of a stack", laneAndCards, async (d, made) => {
  const s = await d.scene();
  await d.drag(centre(item(s, made[3]!)), { x: 900, y: 600 });
});

parity("a lane dragged by its header carries its cards", laneAndCards, async (d, made) => {
  const s = await d.scene();
  const l = item(s, made[0]!);
  // low in the header, out of the zone where a drag scrolls the board, which the Swift core leaves to its view
  await d.drag({ x: l.x + 100, y: l.y + 40 }, { x: l.x + 400, y: l.y + 160 });
});

parity("a lane resized by its corner", laneAndCards, async (d, made) => {
  const l = item(await d.scene(), made[0]!);
  await d.drag({ x: l.x + l.w - 5, y: l.y + l.h - 5 }, { x: l.x + l.w + 200, y: l.y + l.h - 100 });
});

parity("a box selects what it touches", laneAndCards, async (d) => {
  await d.drag({ x: 1000, y: 600 }, { x: 610, y: 100 });
});

parity("a click selects, another elsewhere clears", laneAndCards, async (d, made) => {
  const s = await d.scene();
  await d.click(centre(item(s, made[1]!)));
});

parity("a colour key recolours the card clicked, and ⌫ deletes another", laneAndCards, async (d, made) => {
  const s = await d.scene();
  await d.click(centre(item(s, made[1]!)));
  await d.key("4");
  await d.click(centre(item(s, made[3]!)));
  await d.key("Backspace");
});

parity("Space turns the card clicked over", laneAndCards, async (d, made) => {
  const s = await d.scene();
  await d.click(centre(item(s, made[2]!)));
  await d.key(" ");
});

parity("⌘Z undoes a drag into a lane, and ⇧⌘Z does it again", laneAndCards, async (d, made) => {
  const s = await d.scene();
  await d.drag(centre(item(s, made[1]!)), centre(item(s, made[0]!)));
  await d.key("z", { meta: true });
  await d.key("z", { meta: true, shift: true });
});
