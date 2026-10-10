import { test } from "node:test";
import assert from "node:assert/strict";
import { boardFrom, cardRecord, changes, deletedRecord } from "../sync/records.js";
import { decode } from "../sync/base64.js";
import { newID } from "../rules.js";

const card = (id, x, y, text = "t") => ({ id, x, y, w: 240, text, color: 1 });
const lane = (id, x, y) => ({ id, x, y, w: 480, h: 720, title: "Lane" });
const records = (c) => Object.fromEntries(Object.entries(c).filter(([, v]) => v.fields).map(([id, v]) => [id, v.fields]));

test("a board goes to records and back", () => {
  const b = { cards: [card("c1", 24, 48, "One"), card("c2", 0, 0, "Two")], lanes: [lane("l1", 0, 0)] };
  assert.deepEqual(boardFrom(records(changes({ cards: [], lanes: [] }, b, "B", {})), "B"), b);
});

test("only changed fields are written", () => {
  const old = { cards: [card("c1", 0, 0, "One")], lanes: [] };
  const now = { cards: [{ ...card("c1", 0, 0, "One"), color: 3 }], lanes: [] };
  assert.deepEqual(changes(old, now, "B", { c1: "V" }), { c1: { fields: { color: 3 } } });
});

test("reordering writes one order key", () => {
  const old = { cards: [card("a", 0, 0), card("b", 0, 0)], lanes: [] };
  const now = { cards: [card("b", 0, 0), card("a", 0, 0)], lanes: [] };
  assert.deepEqual(changes(old, now, "B", { a: "V", b: "l" }), { b: { fields: { order: "G" } } });
});

test("an order another device changed is not written back when nothing moved here", () => {
  const b = { cards: [card("a", 0, 0), card("b", 0, 0)], lanes: [] };
  assert.deepEqual(changes(b, structuredClone(b), "B", { a: "V", b: "G" }), {});
});

test("a card moved here gets a key among the others' order, which stays", () => {
  const old = { cards: [card("a", 0, 0), card("b", 0, 0), card("c", 0, 0)], lanes: [] };
  const now = { cards: [card("a", 0, 0), card("c", 0, 0), card("b", 0, 0)], lanes: [] };
  // another device put c first meanwhile; here c went between a and b
  const out = changes(old, now, "B", { a: "V", b: "l", c: "G" });
  assert.deepEqual(Object.keys(out), ["c"]);
  assert.ok(out.c.fields.order > "V" && out.c.fields.order < "l");
});

test("removed items are marked deleted", () => {
  const old = { cards: [card("a", 0, 0)], lanes: [lane("l", 0, 0)] };
  assert.deepEqual(changes(old, { cards: [], lanes: [] }, "B", { a: "V" }), { a: { deleted: "card" }, l: { deleted: "lane" } });
});

test("bad values from another device fall back", () => {
  const [c] = boardFrom({ c: { format: 1, kind: "card", board: "B", color: 9, pos: "x" } }, "B").cards;
  assert.deepEqual(c, { id: "c", x: 0, y: 0, w: 240, text: "", color: 5 });
});

test("deleted records and other boards are left out", () => {
  const recs = { a: cardRecord(card("a", 0, 0), "B", "V"), b: cardRecord(card("b", 0, 0), "C", "V"), d: deletedRecord("card") };
  assert.deepEqual(boardFrom(recs, "B").cards.map((c) => c.id), ["a"]);
});

test("new ids are 16 random bytes", () => {
  const id = newID();
  assert.equal(id.length, 22);
  assert.equal(decode(id).length, 16);
  assert.notEqual(newID(), id);
});

test("only a JSON number sets a colour", () => {
  const [c] = boardFrom({ c: { format: 1, kind: "card", board: "B", color: "3" } }, "B").cards;
  assert.equal(c.color, 1);
});

test("only deleted: true leaves a record out", () => {
  const [c] = boardFrom({ c: { format: 1, kind: "card", board: "B", deleted: 1 } }, "B").cards;
  assert.equal(c.id, "c");
});
