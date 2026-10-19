import { test } from "node:test";
import assert from "node:assert/strict";
import { inserted, rowOf, rows } from "./rows.ts";

const state = (text: string, at = text.length, editing = true) => ({ text, at, kind: "front" as const, editing });

test("inserted: the string at the caret, the caret after it, still editing", () => {
  assert.equal(inserted(state("Plan"), state("Plan😀"), "😀"), null);
  assert.equal(inserted(state("Plan", 2), state("Pl😀an", 4), "😀"), null);
  assert.match(inserted(state("Plan"), state("Plan"), "😀")!, /Plan/);
  assert.match(inserted(state("Plan"), state("Plan😀", 6, false), "😀")!, /no longer edited/);
  assert.match(inserted(state("Plan"), state("Plangrinning"), "😀")!, /Plangrinning/);
});

test("every row is named once, with a check", () => {
  const names = rows.map((r) => `${r.id}-${r.variant}`);
  assert.deepEqual(names, [...new Set(names)]);
  assert.equal(rowOf("A1", "picker").id, "A1");
  assert.throws(() => rowOf("Z9", "none"));
});

test("the emoji picker's row takes any one emoji at the caret", () => {
  const a1 = rowOf("A1", "picker");
  assert.equal(a1.expect(state("Plan"), state("Plan🤣")), null);
  assert.match(a1.expect(state("Plan"), state("Plan", 4, false))!, /no longer edited/);
  assert.match(a1.expect(state("Plan"), state("Plangrinning"))!, /Plangrinning/);
});

test("Enter while composing Japanese commits what the input method made, at the caret", () => {
  const enter = rowOf("A2", "enter");
  assert.equal(enter.expect(state("Plan"), state("Plan日本")), null);
  assert.equal(enter.expect(state("Plan"), state("Planにほん")), null);
  assert.match(enter.expect(state("Plan"), state("Plannihonn"))!, /Plannihonn/);
  assert.match(enter.expect(state("Plan"), state("Plan日本", 6, false))!, /no longer edited/);
});

test("Esc while composing cancels the composition and nothing else", () => {
  assert.equal(rowOf("A2", "escape").expect(state("Plan"), state("Plan")), null);
  assert.match(rowOf("A2", "escape").expect(state("Plan"), state("Plan", 4, false))!, /no longer edited/);
});

test("a tab switch ends the edit, keeping its text", () => {
  const tab = rowOf("F1", "tab");
  assert.equal(tab.expect(state("Plan"), state("Plan", 4, false)), null);
  assert.match(tab.expect(state("Plan"), state("Plan", 4, true))!, /still edited/);
  assert.match(tab.expect(state("Plan"), state("", 0, false))!, /""/);
});
