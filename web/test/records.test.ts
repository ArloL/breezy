import { test } from "node:test";
import assert from "node:assert/strict";
import { boardFrom, cardRecord, changes, deletedRecord } from "../sync/records.ts";
import { decode } from "../sync/base64.ts";
import { newID } from "../rules.ts";
import { between } from "../sync/order-key.ts";
import { fixture } from "./helpers/fixture.ts";
import type { Card, Lane } from "../types.ts";
import type { Edits, SyncRecord } from "../sync/records.ts";

const card = (id: string, x: number, y: number, text = "t"): Card => ({ id, x, y, w: 240, text, color: 1 });
const lane = (id: string, x: number, y: number): Lane => ({ id, x, y, w: 480, h: 720, title: "Lane" });
const records = (c: Edits) => Object.fromEntries(Object.entries(c).filter(([, v]) => v.fields).map(([id, v]) => [id, v.fields!]));

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
  assert.ok((out.c.fields!.order as string) > "V" && (out.c.fields!.order as string) < "l");
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
  assert.equal(decode(id)!.length, 16);
  assert.notEqual(newID(), id);
});

test("only a JSON number sets a colour", () => {
  const [c] = boardFrom({ c: { format: 1, kind: "card", board: "B", color: "3" } }, "B").cards;
  assert.equal(c.color, 1);
});

test("only deleted: true leaves a record out", () => {
  const [c] = boardFrom({ c: { format: 1, kind: "card", board: "B", deleted: 1 } as unknown as SyncRecord }, "B").cards;
  assert.equal(c.id, "c");
});

const keysOf = (out: Edits) => Object.fromEntries(Object.entries(out).filter(([, c]) => c.fields?.order !== undefined).map(([id, c]) => [id, c.fields!.order as string]));
const cards = (ids: string[]) => ids.map((id) => card(id, 0, 0));

test("order writes match the shared cases", () => {
  for (const c of fixture("order-writes.json")) assert.deepEqual(keysOf(changes({ cards: cards(c.old), lanes: [] }, { cards: cards(c.now), lanes: [] }, "B", c.orders)), c.keys, c.name);
});

test("when the store has the order seen here, the keys written give the board's order", () => {
  let seed = 1;
  const rand = (n: number) => ((seed = (seed * 48271) % 2147483647) % n);
  for (let n = 0; n < 2000; n++) {
    const ids = Array.from({ length: 1 + rand(8) }, (_, i) => `c${i}`);
    let k = "";
    const orders = Object.fromEntries(ids.map((id) => [id, (k = rand(4) ? between(k, null) : k + "V")]));
    const now = [...ids].sort(() => rand(3) - 1);
    if (rand(2)) now.splice(rand(now.length + 1), 0, "new");
    const out = changes({ cards: cards(ids), lanes: [] }, { cards: cards(now), lanes: [] }, "B", orders);
    const keys = { ...orders, ...keysOf(out) };
    const recs = Object.fromEntries(now.map((id) => [id, cardRecord(card(id, 0, 0), "B", keys[id])]));
    assert.deepEqual(boardFrom(recs, "B").cards.map((c) => c.id), now, JSON.stringify({ ids, orders, now }));
  }
});
