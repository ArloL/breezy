// Scenarios written once for any kind of device: on the hub's fakes (cases.test.ts) and on real devices
// (browsers.e2e.ts). Each acts on the first device and looks at what the second shows.
import assert from "node:assert/strict";
import { centre, item, type Box, type Device, type Editor, type Frame } from "./device.ts";
import { LANE_H, LANE_W } from "../web/rules.ts";

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
  /** Whether the first device must draw its text for the case to see, which the hub's fakes do not. */
  draws?: boolean;
  /** Whether the first device must go offline and launch again, which the hub's fakes cannot. */
  offline?: boolean;
  run(s: Stage): Promise<void>;
}

/** A lane in the middle of the first device's screen and a card beside it, made there, and seen by the others. On a
 * phone, the lane at the top left and the card below it. */
async function laneAndCard({ devices: [a], settle }: Stage) {
  const narrow = (await a!.size()).w < 900;
  const at = await a!.world(narrow ? { x: 24, y: 96 } : { x: 450, y: 440 });
  const lane = await a!.addLane(narrow ? at.x + LANE_W / 2 : at.x, narrow ? at.y + LANE_H / 2 : at.y);
  const l = item(await a!.scene(), lane);
  const card = narrow ? await a!.addCard(l.x + l.w / 2, l.y + l.h + 72) : await a!.addCard(l.x + l.w + 200, l.y + 200);
  await settle();
  return { lane, card };
}

/** Until `test` holds, checked every 250 ms on `d`'s clock for at most `ms`. */
async function eventually(d: Device, ms: number, test: () => Promise<boolean>) {
  for (let t = 0; t < ms; t += 250) {
    if (await test()) return true;
    await d.wait(250);
  }
  return test();
}

/** Where `id` is drawn relative to `lane` on device `d`. */
async function within(d: Device, lane: string, id: string) {
  const s = await d.scene();
  const l = item(s, lane), c = item(s, id);
  return { x: c.x - l.x, y: c.y - l.y };
}

/** Where the editor's text and caret should be. */
interface Want {
  text: string;
  at: number;
}

const mid = (b: Box) => b.y + b.h / 2;

/**
 * Whether `e` draws the text and caret of `want`: the title, up to the first newline, semibold and the rest regular; the
 * caret against the character before or after it, at a soft wrap either; between newlines, at the line's start as many
 * lines down as there are newlines; and inside the card and what the screen shows.
 */
function drawn(e: Editor | null, want: Want, card: Box) {
  assert.ok(e, "nothing is being edited");
  assert.deepEqual({ text: e.text, at: e.at }, want, "the text and caret");
  const title = want.text.includes("\n") ? want.text.indexOf("\n") : want.text.length;
  for (let i = 0; i < want.text.length; i++) {
    if (want.text[i] === "\n") continue;
    const w = e.weights[i]!, ok = i < title ? w >= 600 : w <= 500;
    assert.ok(ok, `${JSON.stringify(want.text[i])} at ${i}, in the ${i < title ? "title" : "rest"}, weighs ${w}`);
  }
  const c = e.caret;
  assert.ok(c, "no caret is drawn");
  const near = (a: number, b: number) => Math.abs(a - b) <= 2;
  const line = (b: Box) => Math.abs(mid(c) - mid(b)) < e.line / 2;
  const before = e.chars[want.at - 1], after = e.chars[want.at];
  if (before || after) {
    const ok = !!before && line(before) && near(c.x, before.x + before.w) || !!after && line(after) && near(c.x, after.x);
    assert.ok(ok, `the caret ${JSON.stringify(c)} is not beside ${JSON.stringify(before)} before it or ${JSON.stringify(after)} after it`);
  } else {
    let k = want.at - 1;
    while (k >= 0 && !e.chars[k]) k--;
    const down = want.text.slice(k + 1, want.at).split("\n").length - 1;
    const y = k >= 0 ? mid(e.chars[k]!) + down * e.line : e.origin.y + (down + 0.5) * e.line;
    assert.ok(near(c.x, e.origin.x) && Math.abs(mid(c) - y) < e.line / 2,
      `the caret ${JSON.stringify(c)} is not at the start of the line ${down} below ${k >= 0 ? `${JSON.stringify(e.chars[k])}` : "the top"}, at x ${e.origin.x}, mid y ${y}`);
  }
  const inside = (b: Box, r: Box) => b.x >= r.x - 1 && b.y >= r.y - 1 && b.x + b.w <= r.x + r.w + 1 && b.y + b.h <= r.y + r.h + 1;
  assert.ok(inside(c, card), `the caret ${JSON.stringify(c)} is outside the card ${JSON.stringify(card)}`);
  assert.ok(inside(c, e.view), `the caret ${JSON.stringify(c)} is out of sight of ${JSON.stringify(e.view)}`);
}

/** Card `id` on `d`'s screen. */
async function onScreen(d: Device, id: string): Promise<Box> {
  const s = await d.scene();
  const c = item(s, id), z = s.camera.zoom;
  return { x: c.x * z + s.camera.x, y: c.y * z + s.camera.y, w: c.w * z, h: c.h * z };
}

/** Until `d`'s editor draws `want`, as a person waits to see a key's effect: a busy phone shows it a moment later. */
async function shows(d: Device, card: string, want: Want, after: string) {
  for (let t = 0; ; t += 100) {
    try {
      return drawn(await d.editor(), want, await onScreen(d, card));
    } catch (e) {
      if (t >= 3000) throw new Error(`after ${after}: ${(e as Error).message}`, { cause: e });
    }
    await d.wait(100);
  }
}

/**
 * Edits card `id` at the end of its text, one step at a time: text typed, "\n" Return or "\b" ⌫; after each, the
 * editor draws the text and caret it should. Returns what it should hold.
 */
async function edit(d: Device, id: string, want: Want, steps: string[]): Promise<Want> {
  for (const [i, step] of steps.entries()) {
    if (step === "\b") {
      await d.key("Backspace");
      if (want.at) want = { text: want.text.slice(0, want.at - 1) + want.text.slice(want.at), at: want.at - 1 };
    } else {
      if (step === "\n") await d.key("Enter");
      else await d.type(step);
      want = { text: want.text.slice(0, want.at) + step + want.text.slice(want.at), at: want.at + step.length };
    }
    await shows(d, id, want, JSON.stringify(steps.slice(0, i + 1).join("")));
  }
  return want;
}

/** A card made where nothing is, as a person makes one with `input`, and its id once it is being edited. */
async function newCard(d: Device, input: "mouse" | "touch") {
  const narrow = (await d.size()).w < 900;
  const p = await d.world(narrow ? { x: 40, y: 200 } : { x: 400, y: 200 });
  const had = new Set((await d.scene()).cards.map((c) => c.id));
  await (input === "touch" ? d.doubleTap(p) : d.doubleClick(p));
  let id = "";
  await d.until("a new card", async () => !!(id = (await d.scene()).cards.find((c) => !had.has(c.id))?.id ?? ""));
  await shows(d, id, { text: "", at: 0 }, "the double " + (input === "touch" ? "tap" : "click"));
  return id;
}

/** Ends the edit as a person does: Esc, or on a phone a tap on the board just above the card, kept in sight of the
 * keyboard; and until the front at rest is semibold up to the first newline. */
async function endEdit(d: Device, id: string, input: "mouse" | "touch") {
  if (input === "touch") {
    const c = item(await d.scene(), id);
    await d.tap({ x: c.x + c.w / 2, y: c.y - 40 });
  } else {
    await d.key("Escape");
  }
  await d.until("the edit to end", async () => !(await d.editor()));
  const text = item(await d.scene(), id).text!;
  const title = text.includes("\n") ? text.indexOf("\n") : text.length;
  const weights = await d.weights(id);
  if (weights) assert.deepEqual(weights, [...text].filter((ch) => ch !== "\n").map((_, i) => i < title ? 600 : 400), "the weights at rest");
}

/** Typing at the end of a title and the lines below it, Return, ⌫ back across them, and again. */
const lines = (input: "mouse" | "touch"): Case => ({
  name: `a card's title and lines typed, deleted and typed again ${input === "touch" ? "on a phone " : ""}show the caret after the last key, the title semibold`,
  input,
  edits: true,
  draws: true,
  async run(s) {
    const [a, b] = s.devices as [Device, Device];
    const id = await newCard(a, input);
    let want = await edit(a, id, { text: "", at: 0 }, [
      "Groceries", "\n", "milk", "\n", "\n", "\b", "\b", "\b", "\b", "\b", "\b", "\b", "\n", "eggs",
      ...Array<string>(14).fill("\b"), "Shopping",
    ]);
    await endEdit(a, id, input);
    const c = centre(item(await a.scene(), id));
    await (input === "touch" ? a.doubleTap(c) : a.doubleClick(c));
    await shows(a, id, { text: want.text, at: want.text.length }, "opening it again");
    want = await edit(a, id, { text: want.text, at: want.text.length }, ["\n", "bread", "\n", "\n", "butter"]);
    await endEdit(a, id, input);
    await s.settle();
    assert.equal(item(await b.scene(), id).text, want.text);
  },
});

/** Typing word by word into a title and a line below that both wrap, ⌫ back across the wraps and the newline, and on. */
const wrapping = (input: "mouse" | "touch"): Case => ({
  name: `a card's title and lines that wrap ${input === "touch" ? "on a phone " : ""}show the caret after the last key, the title semibold`,
  input,
  edits: true,
  draws: true,
  async run(s) {
    const [a, b] = s.devices as [Device, Device];
    const id = await newCard(a, input);
    /** Each word a step, after a space but the first: the caret is never after a space a line may end in. */
    const words = (t: string, after = false) => t.split(" ").map((w, i) => (i || after ? ` ${w}` : w));
    let want = await edit(a, id, { text: "", at: 0 }, [
      ...words("Ask the neighbours whether they could water the plants while we are away"), "\n",
      ...words("Fill the can from the rain barrel behind the shed and leave the key under the pot"),
    ]);
    // back across the last two wraps, the newline and into the title, one key at a time
    const back = want.text.length - want.text.indexOf("\n") + " are away".length;
    want = await edit(a, id, want, Array<string>(back).fill("\b"));
    want = await edit(a, id, want, [...words("are away for the summer", true), "\n", ...words("Water twice a week")]);
    await endEdit(a, id, input);
    await s.settle();
    assert.equal(item(await b.scene(), id).text, want.text);
  },
});

export const cases: Case[] = [
  lines("mouse"),
  lines("touch"),
  wrapping("mouse"),
  wrapping("touch"),
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
    name: "a card dragged into a lane with a finger in the app launched without network shows there on the other device once online",
    input: "touch",
    offline: true,
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { lane, card } = await laneAndCard(s);
      const was = await within(b, lane, card);
      await a.offline(true);
      await a.relaunch();
      const at = await a.scene();
      await a.touchDrag(centre(item(at, card)), centre(item(at, lane)));
      await a.wait(2000);
      assert.deepEqual(await within(a, lane, card), { x: 24, y: 72 }, "where it was dragged, offline");
      assert.deepEqual(await within(b, lane, card), was, "the other device saw it while the first was offline");
      await a.offline(false);
      // quality goal 3a: both show it 10 s after both are online
      const there = await eventually(b, 10_000, async () => JSON.stringify(await within(b, lane, card)) === JSON.stringify({ x: 24, y: 72 }));
      assert.ok(there, `the other device shows it at ${JSON.stringify(await within(b, lane, card))} 10 s after the first came online; the first says "${await a.syncStatus()}", the other "${await b.syncStatus()}"`);
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
      await a.tap({ x: made.x + made.w + 100, y: made.y + made.h / 2 });
      await a.wait(400);
      const before = await a.scene(), seen = item(await b.scene(), card);
      const c = item(before, card);
      assert.equal(c.selected, false, "a tap on nothing clears the selection");
      await a.touchDrag(centre(c), { x: c.x + 200, y: c.y - 100 }, { hold: false });
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
      // a tap on the board ends the edit, as there is no Esc on a phone: just above the card, which the board keeps in
      // sight of the keyboard
      const card = (await a.scene()).cards.find((c) => !had.has(c.id))!;
      await a.tap({ x: card.x + card.w / 2, y: card.y - 40 });
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
      const size = await a.size(), m = { x: size.w / 2, y: size.h / 2 };
      const spread: Frame[] = [];
      for (let i = 1; i <= 10; i++) spread.push([16, "move", [[1, { x: m.x - 50 - 5 * i, y: m.y }], [2, { x: m.x + 50 + 5 * i, y: m.y }]]]);
      await a.gesture([
        [0, "down", [[1, { x: m.x - 50, y: m.y }]]],
        [0, "down", [[2, { x: m.x + 50, y: m.y }]]],
        ...spread,
        [0, "up", [[1, { x: m.x - 100, y: m.y }]]],
        [0, "up", [[2, { x: m.x + 100, y: m.y }]]],
      ]);
      await a.wait(1500);
      const { camera } = await a.scene();
      const zoom = Math.min(2, before.zoom * 2);
      assert.ok(Math.abs(camera.zoom - zoom) < 0.02, `zoom ${camera.zoom}, the fingers' spread doubled from ${before.zoom}`);
      // the world point first under the fingers' middle stays there, within a few points: a browser hands the app one
      // finger's move at a time, so the middle wobbles between them and the release may coast a little
      const w0 = (m.x - before.x) / before.zoom, w1 = (m.x - camera.x) / camera.zoom;
      assert.ok(Math.abs(w1 - w0) < 4, `world x ${w1} under the middle, was ${w0}`);
    },
  },
];
