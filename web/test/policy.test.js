import { test } from "node:test";
import assert from "node:assert/strict";
import { hitTest, dragAction } from "../policy.js";

const rectOf = (c) => ({ x: c.x, y: c.y, w: c.w, h: 48 });
const card = (id, x, y, notes) => ({ id, x, y, w: 240, text: "t", color: 1, ...(notes ? { notes } : {}) });
const lane = { id: "l", x: 0, y: 0, w: 480, h: 720, title: "Lane" };
const at = (b, x, y, zoom = 1, turned = null) => hitTest(b, { x, y }, { rectOf, zoom, turned });

test("the folded corner takes a 44 pt touch area, reaching outside the card", () => {
  const b = { cards: [card("a", 0, 0, "n")], lanes: [] };
  assert.deepEqual(at(b, 250, 50), { kind: "fold", id: "a" });
  assert.deepEqual(at(b, 200, 24), { kind: "card", id: "a" });
});

test("a card without notes has no fold", () => {
  const b = { cards: [card("a", 0, 0)], lanes: [] };
  assert.deepEqual(at(b, 238, 46), { kind: "card", id: "a" });
  assert.deepEqual(at(b, 250, 50), { kind: "empty" });
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
  const cases = [
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
  for (const [hit, held, want] of cases) assert.equal(dragAction("one", hit, sel, held), want, JSON.stringify([hit, held]));
});

test("with two-finger panning one finger moves, draws a box or moves lanes at once", () => {
  const sel = new Set();
  const cases = [
    [{ kind: "empty" }, "marquee"],
    [{ kind: "card", id: "b" }, "move"],
    [{ kind: "header", id: "l" }, "lane"],
    [{ kind: "corner", id: "l" }, "resize"],
  ];
  for (const [hit, want] of cases) {
    assert.equal(dragAction("two", hit, sel, false), want);
    assert.equal(dragAction("two", hit, sel, true), want);
  }
});
