import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { clipHTML, clipText, readClip } from "../clip.ts";
import type { Clip } from "../types.ts";

const clip: Clip = {
  v: 1,
  board: "B",
  cards: [
    { id: "c1", x: 24, y: 72, w: 240, h: 48, text: 'He said "hi" <b> & 🍕', color: 3, notes: "back & side" },
    { id: "c2", x: 312, y: 72, w: 240, h: 72, text: "Soup", color: 1 },
  ],
};

const withCards = (cards: unknown, v: unknown = 1) => `<div data-breezy="${JSON.stringify({ v, board: "B", cards }).replaceAll('"', "&quot;")}"></div>`;
const one = (k: object) => readClip(withCards([{ id: "a", x: 0, y: 0, w: 240, h: 48, text: "t", color: 1, ...k }]))!.cards[0];

test("clipText joins fronts with a blank line", () => {
  const c: Clip = { v: 1, board: "B", cards: [{ ...clip.cards[0], text: "Pizza\nfor Al" }, { ...clip.cards[1], text: "Soup" }] };
  assert.equal(clipText(c), "Pizza\nfor Al\n\nSoup");
});

test("readClip reads the fixture", () => {
  assert.deepEqual(readClip(fs.readFileSync("web/test/clip-fixture.html", "utf8")), clip);
});

test("readClip(clipHTML(c)) is c", () => {
  assert.deepEqual(readClip(clipHTML(clip)), clip);
});

test("clipHTML shows the text and keeps < > & out of the attribute", () => {
  const html = clipHTML(clip);
  assert.match(html, /^<div data-breezy="[^<>]*">He said &quot;hi&quot; &lt;b&gt; &amp; 🍕<br><br>Soup<\/div>$/);
  assert.equal(html.slice(0, html.indexOf('">')).includes("&amp;"), false);
});

test("readClip rejects what is not a clip", () => {
  assert.equal(readClip("<p>hello</p>"), null);
  assert.equal(readClip(withCards([], 2)), null);
  assert.equal(readClip(withCards("no")), null);
  assert.equal(readClip(withCards([{ id: "a", x: 0, y: 0, text: 1 }])), null);
  assert.equal(readClip('<div data-breezy="{nope"></div>'), null);
});

test("readClip clamps the colour and makes every copy a card wide", () => {
  assert.equal(one({ color: 9 }).color, 5);
  assert.equal(one({ color: 0 }).color, 1);
  for (const w of [0, -5, 480]) assert.equal(one({ w }).w, 240);
});

test("a no-break space survives a round trip and &nbsp; is read as one", () => {
  const c: Clip = { v: 1, board: "B", cards: [{ ...clip.cards[1], text: "10\u00a0km" }] };
  assert.equal(readClip(clipHTML(c))!.cards[0].text, "10\u00a0km");
  assert.equal(clipHTML(c).split('">')[0].includes("\u00a0"), false);
  const h = clipHTML(c).replace("\\u00a0", "&nbsp;");
  assert.equal(readClip(h)!.cards[0].text, "10\u00a0km");
});

test("readClip mends a card's colour, size and notes of the wrong type", () => {
  assert.equal(one({ color: 2.5 }).color, 3);
  assert.equal(one({ color: "x" }).color, 1);
  assert.equal(one({ w: "x" }).w, 240);
  assert.equal(one({ h: "x" }).h, 48);
  assert.equal(one({ notes: 5 }).notes, undefined);
});
