import { test } from "node:test";
import assert from "node:assert/strict";
import { cancels } from "../sheet.ts";

const key = (key: string, more: { isComposing?: boolean; keyCode?: number } = {}) => ({ key, isComposing: false, keyCode: 0, ...more });

test("Esc cancels a sheet that has Cancel", () => {
  assert.equal(cancels(key("Escape"), true), true);
});

test("Esc leaves a sheet without Cancel showing", () => {
  assert.equal(cancels(key("Escape"), false), false);
});

test("an Esc that ends an input method's composition is the input method's", () => {
  assert.equal(cancels(key("Escape", { isComposing: true }), true), false);
  assert.equal(cancels(key("Escape", { keyCode: 229 }), true), false);
});

test("other keys leave the sheet", () => {
  for (const k of ["Enter", "Tab", "a", "Backspace"]) assert.equal(cancels(key(k), true), false);
});
