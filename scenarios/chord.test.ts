// The keys a desktop browser is sent for ⌘, against what the board makes of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { command, onMac } from "../web/keys.ts";
import { chord } from "./chord.ts";

const WEBKIT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15";
const CHROMIUM_LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

function pressed(keys: string) {
  const parts = keys.split("+"), key = parts.pop()!;
  return { key, code: "", keyCode: 0, isComposing: false, altKey: false, metaKey: parts.includes("Meta"), ctrlKey: parts.includes("Control"), shiftKey: parts.includes("Shift") };
}

for (const [name, macOS, ua] of [["WebKit off the Mac", false, WEBKIT], ["Chromium off the Mac", false, CHROMIUM_LINUX], ["WebKit on the Mac", true, WEBKIT]] as const) {
  test(`⌘Z and ⇧⌘Z undo and redo in ${name}`, () => {
    const mac = onMac(ua);
    assert.equal(command(pressed(chord("z", { meta: true }, { macOS, pageMac: mac })), { mac, typing: null }), "undo");
    assert.equal(command(pressed(chord("z", { meta: true, shift: true }, { macOS, pageMac: mac })), { mac, typing: "card" }), "redo");
  });
}

test("off the Mac, ⌘A in a field and ⌘↑ are the OS's own Ctrl+A and Ctrl+Home, whatever the page says it is on", () => {
  assert.equal(chord("a", { meta: true }, { macOS: false, pageMac: true }), "Control+a");
  assert.equal(chord("ArrowUp", { meta: true, shift: true }, { macOS: false, pageMac: true }), "Shift+Control+Home");
  assert.equal(chord("ArrowRight", { meta: true }, { macOS: false, pageMac: false }), "End");
});
