import { test } from "node:test";
import assert from "node:assert/strict";
import { RELOAD_AFTER_MS, shouldReload } from "../update.js";

const away = { running: "1", latest: "2", hiddenFor: RELOAD_AFTER_MS, editing: false };

test("coming back after a while to a downloaded version reloads into it", () => {
  assert.equal(shouldReload(away), true);
});

test("a quick app switch keeps the running version", () => {
  assert.equal(shouldReload({ ...away, hiddenFor: RELOAD_AFTER_MS - 1 }), false);
});

test("an open editor keeps the running version", () => {
  assert.equal(shouldReload({ ...away, editing: true }), false);
});

test("without another version there is nothing to reload into", () => {
  assert.equal(shouldReload({ ...away, latest: "1" }), false);
  assert.equal(shouldReload({ ...away, latest: null }), false);
});
