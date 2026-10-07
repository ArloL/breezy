import { test } from "node:test";
import assert from "node:assert/strict";
import { command } from "../keys.js";

const key = (k, mods = {}, ctx = {}) =>
  command({ key: k, code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }, { mac: true, typing: null, ...ctx });

test("⌘ shortcuts on the Mac, Ctrl elsewhere", () => {
  assert.equal(key("z", { metaKey: true }), "undo");
  assert.equal(key("z", { metaKey: true, shiftKey: true }), "redo");
  assert.equal(key("Z", { metaKey: true, shiftKey: true }), "redo");
  assert.equal(key("z", { ctrlKey: true }), null);
  assert.equal(key("z", { ctrlKey: true }, { mac: false }), "undo");
  assert.equal(key("a", { metaKey: true }), "select-all");
  assert.equal(key("f", { metaKey: true }), "find");
  assert.equal(key("g", { metaKey: true }), "find-next");
  assert.equal(key("g", { metaKey: true, shiftKey: true }), "find-previous");
  assert.equal(key("e", { metaKey: true }), "find-selection");
});

test("zoom keys: ⌘+ or ⌘=, ⌘-, ⌘0 and ⇧0 by position", () => {
  assert.equal(key("=", { metaKey: true }), "zoom-in");
  assert.equal(key("+", { metaKey: true, shiftKey: true }), "zoom-in");
  assert.equal(key("-", { metaKey: true }), "zoom-out");
  assert.equal(key("0", { metaKey: true }), "zoom-reset");
  assert.equal(command({ key: "=", code: "Digit0", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true }, { mac: true, typing: null }), "zoom-reset");
});

test("board keys", () => {
  assert.equal(key(" "), "turn");
  assert.equal(key("Escape"), "escape");
  assert.equal(key("Backspace"), "delete");
  assert.equal(key("Delete"), "delete");
  assert.equal(key("3"), "colour-3");
  assert.equal(key("6"), null);
  assert.equal(key("l"), "new-lane");
  assert.equal(key("L", { shiftKey: true }), "new-lane");
});

test("⇧1 types '!' and colours nothing; ⌥ and ⌘ leave board keys alone", () => {
  assert.equal(key("!", { shiftKey: true, code: "Digit1" }), null);
  assert.equal(key("3", { altKey: true }), null);
  assert.equal(key("l", { metaKey: true }), null);
});

test("typing into a card types, except the keys that end or turn it", () => {
  const card = { typing: "card" };
  for (const k of [" ", "3", "l", "Backspace", "Enter"]) assert.equal(key(k, {}, card), null, k);
  assert.equal(key("a", { metaKey: true }, card), null);
  assert.equal(key("Escape", {}, card), "end-edit");
  assert.equal(key("Enter", { metaKey: true }, card), "end-edit");
  assert.equal(key("Tab", {}, card), "switch-side");
  assert.equal(key("Tab", { shiftKey: true }, card), null);
  assert.equal(key("z", { metaKey: true }, card), "undo");
  assert.equal(key("f", { metaKey: true }, card), "find");
  assert.equal(key("=", { metaKey: true }, card), "zoom-in");
});

test("a lane title ends on Tab; the find field keeps its own keys", () => {
  assert.equal(key("Tab", {}, { typing: "lane" }), "end-edit");
  assert.equal(key(" ", {}, { typing: "lane" }), null);
  const field = { typing: "field" };
  assert.equal(key("z", { metaKey: true }, field), null);
  assert.equal(key("a", { metaKey: true }, field), null);
  assert.equal(key("g", { metaKey: true }, field), "find-next");
  assert.equal(key("Backspace", {}, field), null);
});
