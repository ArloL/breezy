import { test } from "node:test";
import assert from "node:assert/strict";
import { hitTest, dragAction, pressAction } from "../policy.ts";
import type { DragAction, Hit } from "../policy.ts";
import type { Board, Card, Lane } from "../types.ts";

const rectOf = (c: Card) => ({ x: c.x, y: c.y, w: c.w, h: 48 });
const card = (id: string, x: number, y: number, notes?: string): Card => ({ id, x, y, w: 240, text: "t", color: 1, ...(notes ? { notes } : {}) });
const lane: Lane = { id: "l", x: 0, y: 0, w: 480, h: 720, title: "Lane" };
const at = (b: Board, x: number, y: number, zoom = 1, turned: string | null = null) => hitTest(b, { x, y }, { rectOf, zoom, turned });

test("every card's corner takes a 64 pt touch area inside the card", () => {
  const b = { cards: [card("a", 0, 0)], lanes: [] };
  assert.deepEqual(at(b, 180, 10), { kind: "fold", id: "a" });
  assert.deepEqual(at(b, 170, 40), { kind: "card", id: "a" });
  assert.deepEqual(at(b, 250, 50), { kind: "empty" });
});

test("zoomed in, the touch corner stays 64 pt on screen", () => {
  const b = { cards: [card("a", 0, 0)], lanes: [] };
  assert.deepEqual(at(b, 210, 20, 2), { kind: "fold", id: "a" });
  assert.deepEqual(at(b, 200, 20, 2), { kind: "card", id: "a" });
});

test("below 69 % the touch corner is the card's", () => {
  const b = { cards: [card("a", 0, 0)], lanes: [] };
  assert.deepEqual(at(b, 230, 40, 0.7), { kind: "fold", id: "a" });
  assert.deepEqual(at(b, 230, 40, 0.68), { kind: "card", id: "a" });
});

test("cards win over the lane header beneath them", () => {
  const b = { cards: [card("a", 24, 24)], lanes: [lane] };
  assert.deepEqual(at(b, 100, 40), { kind: "card", id: "a" });
  assert.deepEqual(at(b, 300, 40), { kind: "header", id: "l" });
});

test("the header and the resize corner grow to 44 pt at low zoom", () => {
  const b = { cards: [], lanes: [lane] };
  assert.deepEqual(at(b, 100, 150, 0.25), { kind: "header", id: "l" });
  assert.deepEqual(at(b, 100, 150, 1), { kind: "empty" });
  assert.deepEqual(at(b, 480, 720), { kind: "corner", id: "l" });
  assert.deepEqual(at(b, 420, 660, 0.25), { kind: "corner", id: "l" });
  assert.deepEqual(at(b, 420, 660, 1), { kind: "empty" });
});

test("a turned card is on top of later cards", () => {
  const b = { cards: [card("a", 0, 0), card("b", 24, 0)], lanes: [] };
  assert.deepEqual(at(b, 100, 24), { kind: "card", id: "b" });
  assert.deepEqual(at(b, 100, 24, 1, "a"), { kind: "card", id: "a" });
});

test("one finger pans unless the drag starts on a selected card or after a hold", () => {
  const sel = new Set(["a"]);
  const cases: [Hit, boolean, DragAction][] = [
    [{ kind: "empty" }, false, "pan"],
    [{ kind: "empty" }, true, "marquee"],
    [{ kind: "card", id: "b" }, false, "pan"],
    [{ kind: "card", id: "b" }, true, "move"],
    [{ kind: "card", id: "a" }, false, "move"],
    [{ kind: "fold", id: "a" }, false, "move"],
    [{ kind: "header", id: "l" }, false, "pan"],
    [{ kind: "header", id: "l" }, true, "lane"],
    [{ kind: "corner", id: "l" }, false, "pan"],
    [{ kind: "corner", id: "l" }, true, "resize"],
  ];
  for (const [hit, held, want] of cases) assert.equal(dragAction(hit, sel, held), want, JSON.stringify([hit, held]));
});

const mouseAt = (b: Board, x: number, y: number, zoom = 1, turned: string | null = null) => hitTest(b, { x, y }, { rectOf, zoom, turned, touch: false });

test("a pointer's fold is the card's own 32 pt corner, at any zoom", () => {
  const b = { cards: [card("a", 0, 0)], lanes: [] };
  assert.deepEqual(mouseAt(b, 210, 20), { kind: "fold", id: "a" });
  assert.deepEqual(mouseAt(b, 200, 40), { kind: "card", id: "a" });
  assert.deepEqual(mouseAt(b, 210, 10), { kind: "card", id: "a" });
  assert.deepEqual(mouseAt(b, 210, 20, 0.25), { kind: "fold", id: "a" });
});

test("a pointer's lane corner is 20 pt and its header 48 pt at any zoom", () => {
  const b = { cards: [], lanes: [lane] };
  assert.deepEqual(mouseAt(b, 470, 710), { kind: "corner", id: "l" });
  assert.deepEqual(mouseAt(b, 455, 700), { kind: "empty" });
  assert.deepEqual(mouseAt(b, 100, 40, 0.25), { kind: "header", id: "l" });
  assert.deepEqual(mouseAt(b, 100, 60, 0.25), { kind: "empty" });
});

const press = (kind: Hit["kind"], mods: { shift?: boolean; alt?: boolean } = {}, sel: string[] = []) => pressAction({ kind, id: "a" } as Hit, { shift: false, alt: false, ...mods }, new Set(sel));

test("a press on a card selects it alone and drags; in a selection it keeps the selection", () => {
  assert.deepEqual(press("card"), { select: "only", drag: "move", collapse: true });
  assert.deepEqual(press("card", {}, ["a", "b"]), { select: "keep", drag: "move", collapse: true });
  assert.deepEqual(press("card", { shift: true }), { select: "toggle", drag: null });
  assert.deepEqual(press("card", { alt: true }), { select: "pile", drag: "move", collapse: true });
});

test("a press on a fold is a press on the card", () => {
  for (const mods of [{}, { shift: true }, { alt: true }]) for (const sel of [[], ["a", "b"]]) {
    assert.deepEqual(press("fold", mods, sel), press("card", mods, sel));
  }
});

test("lane presses select the lane; shift on the header toggles it", () => {
  assert.deepEqual(press("corner"), { select: "only", drag: "resize" });
  assert.deepEqual(press("header"), { select: "only", drag: "lane" });
  assert.deepEqual(press("header", { shift: true }), { select: "toggle", drag: null });
});

test("a press on empty space clears the selection, or with shift keeps it, and boxes", () => {
  assert.deepEqual(press("empty"), { select: "none", drag: "marquee" });
  assert.deepEqual(press("empty", { shift: true }), { select: "keep", drag: "marquee" });
});
