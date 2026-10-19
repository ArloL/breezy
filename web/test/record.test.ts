import { test } from "node:test";
import assert from "node:assert/strict";
import { toStep } from "../record.ts";

const base = { key: undefined, code: undefined, isComposing: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, data: undefined, inputType: undefined, target: "editor" as const };

test("a key keeps what a replay needs to tell it from typing", () => {
  assert.deepEqual(toStep({ ...base, type: "keydown", key: "Escape", code: "Escape", isComposing: true, keyCode: 229 }, 12.4, null, true),
    { t: 12, type: "keydown", key: "Escape", code: "Escape", isComposing: true, keyCode: 229, mods: "" });
  assert.equal((toStep({ ...base, type: "keydown", key: "z", code: "KeyZ", metaKey: true, shiftKey: true, keyCode: 90 }, 0, null, true) as { mods: string }).mods, "meta+shift");
});

test("an input keeps its type, data and the range it replaced", () => {
  assert.deepEqual(toStep({ ...base, type: "input", inputType: "insertCompositionText", data: "に", isComposing: true }, 3, [4, 4], true),
    { t: 3, type: "input", inputType: "insertCompositionText", data: "に", isComposing: true, range: [4, 4] });
});

test("focus changes keep whether the page had focus", () => {
  assert.deepEqual(toStep({ ...base, type: "focusout" }, 90, null, false), { t: 90, type: "blur", of: "editor", hasFocus: false });
  assert.deepEqual(toStep({ ...base, type: "blur", target: "window" }, 91, null, false), { t: 91, type: "blur", of: "window", hasFocus: false });
});

test("events a replay does not need are left out", () => {
  assert.equal(toStep({ ...base, type: "pointermove" }, 0, null, true), null);
});

test("the page being hidden or shown is kept, for a replay to tell a tab switch from a picker", () => {
  assert.deepEqual(toStep({ ...base, type: "visibilitychange", hidden: true }, 5, null, false), { t: 5, type: "visibility", hidden: true });
});
