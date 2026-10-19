import { test } from "node:test";
import assert from "node:assert/strict";
import { composingKey } from "../ime.ts";

test("a key an input method takes is composing, also Safari's Enter after compositionend", () => {
  assert.equal(composingKey({ isComposing: true, keyCode: 27 }), true);
  assert.equal(composingKey({ isComposing: false, keyCode: 229 }), true);
  assert.equal(composingKey({ isComposing: false, keyCode: 13 }), false);
});
