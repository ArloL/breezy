// What a browser on the emulator shows over the page, and the button that sends it away.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dismissal } from "./prompts.ts";

test("Firefox's survey over the page is sent away by its No Thanks", () => {
  const ui = '<node text="Please help Firefox by taking this short survey" bounds="[0,1800][1080,1900]" /><node text="Take Survey" bounds="[40,1950][1040,2050]" /><node text="No Thanks" bounds="[40,2080][1040,2180]" />';
  assert.deepEqual(dismissal(ui), { text: "No Thanks", x: 540, y: 2130 });
});

test("nothing to send away when no such button shows", () => {
  assert.equal(dismissal('<node text="Take Survey" bounds="[40,1950][1040,2050]" />'), null);
});
