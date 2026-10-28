// A recording drawn as what its screen showed: where the board, the keyboard, the edited card and its caret were.
import { test } from "node:test";
import assert from "node:assert/strict";
import { frames, svg } from "../wireframe.ts";
import type { Recording } from "../../web/flight.ts";

/** #129 as the mini showed it: the back's top at 4 and its caret at 52, under the bar to 58, the board 250 pt tall. */
const mini: Recording = {
  schema: 1, origin: 0, dropped: 0, context: { screen: [375, 812] },
  entries: [
    [10, "transition", "edit", { id: "a", back: true }],
    [20, "geometry", "viewport", { inner: [375, 812], visual: [0, 414, 375], area: [58, 308], cam: [0, 0, 1], editing: null }],
    [30, "decision", "reveal", { path: "card", why: "no caret", area: [58, 308], cam: [0, 0, 1], editing: { id: "a", back: true, card: [16, 4, 343, 288], caret: [40, 52, 0, 24], top: 4 } }],
  ],
};

test("draws each entry that says where things were as a frame, carrying the viewport forward", () => {
  const f = frames(mini);
  assert.equal(f.length, 2);
  assert.deepEqual(f[1]!.visual, [0, 414, 375]);
  assert.deepEqual(f[1]!.card, [16, 4, 343, 288]);
  assert.equal(f[1]!.label, "decision reveal: card, no caret");
});

test("shows the card, its caret, the bar above the board and the keyboard below it", () => {
  const s = svg(frames(mini)[1]!);
  for (const part of ["screen", "bar", "keyboard", "card", "caret"]) assert.ok(s.includes(`data-part="${part}"`), part);
  assert.match(s, /data-part="caret"[^>]*y="52"/);
});

test("shades what covers the board below it, a keyboard or a bar, where the recording has no viewport, as a fake's", () => {
  const fake: Recording = { ...mini, entries: [mini.entries[2]!] };
  assert.match(svg(frames(fake)[0]!), /data-part="below"[^>]*y="308"/);
});

test("draws no card when nothing is edited", () => {
  assert.ok(!svg(frames(mini)[0]!).includes(`data-part="card"`));
});
