import { test } from "node:test";
import assert from "node:assert/strict";
import { panMode } from "../pan-mode.ts";

test("?pan= wins over the stored mode", () => {
  assert.equal(panMode("?pan=native", null), "native");
  assert.equal(panMode("?pan=camera", "native"), "camera");
});

test("the stored mode applies without ?pan=", () => {
  assert.equal(panMode("", "native"), "native");
});

test("the default is the camera, and an unknown value is ignored", () => {
  assert.equal(panMode("?demo", null), "camera");
  assert.equal(panMode("?pan=fast", "native"), "native");
  assert.equal(panMode("", "fast"), "camera");
});
