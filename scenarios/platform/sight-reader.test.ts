// The sight check's reader of where the caret is, in Chromium: Chrome on Android leaves the caret at places that have no
// box, which a person still sees it at.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright-core";
import { readSight } from "../browser.ts";

let browser: Browser, page: Page;
before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});
after(() => browser.close());

/** The caret's top as the sight check reads it, in a card's editor holding `text`, at `offset` in its text or in it. */
async function caretAt(text: string, offset: number, inEditor = false) {
  await page.setContent(`<div class="cards"><div data-id="c"><div contenteditable="plaintext-only" style="white-space:pre-wrap;font:20px/30px monospace"></div></div></div>`);
  await page.evaluate(([text, offset, inEditor]) => {
    const el = document.querySelector<HTMLElement>("[contenteditable]")!;
    el.textContent = text;
    el.focus();
    getSelection()!.collapse(inEditor ? el : el.firstChild, offset);
  }, [text, offset, inEditor] as const);
  return (await page.evaluate(readSight))?.caret?.y ?? null;
}

test("a caret after a card's last text, between the editor's children, reads where the text ends", async () => {
  const end = await caretAt("Groceries\nmilk", 14);
  assert.notEqual(end, null);
  assert.equal(await caretAt("Groceries\nmilk", 1, true), end);
});

test("a caret on an empty line reads on that line", async () => {
  const first = await caretAt("Groceries\n\nmilk", 0), third = await caretAt("Groceries\n\nmilk", 11);
  const empty = await caretAt("Groceries\n\nmilk", 10);
  assert.ok(first !== null && third !== null && empty !== null && empty > first && empty < third, `the empty line's caret at ${empty}, the lines around it at ${first} and ${third}`);
});

test("a caret in an empty editor, as on the back of a card just turned, reads where its text would start", async () => {
  // on the first line, of 30 px: the box of a line starts above the caret drawn in it
  const first = await caretAt("x", 0), empty = await caretAt("", 0, true);
  assert.ok(first !== null && empty !== null && empty <= first && first < empty + 30, `the empty editor's caret at ${empty}, the first letter's at ${first}`);
});
