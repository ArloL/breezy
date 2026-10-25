// Every trace in scenarios/traces/ replayed into the web app in Chromium, Firefox and WebKit, checked against its row:
// what each platform's input once sent, kept from regressing. Rows still open are todo.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, firefox, webkit, type Browser } from "playwright-core";
import { buildSite, serveStatic } from "../browser.ts";
import { replaySteps, setCaret } from "./replay.ts";
import { rowOf, type Target } from "./rows.ts";
import type { EditorState, Step, Trace } from "../../web/record.ts";

const root = new URL("../..", import.meta.url).pathname;
const PORT = 58563;
const dir = join(root, "scenarios/traces");
const traces: [string, Trace][] = readdirSync(dir, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".json"))
  .map((f) => [f, JSON.parse(readFileSync(join(dir, f), "utf8"))]);
const engines = { chromium, firefox, webkit };
let site: ReturnType<typeof serveStatic>;
const browsers = new Map<string, Browser>();

before(async () => {
  const out = join(root, "build", "web-replay");
  buildSite(out);
  site = serveStatic(out, PORT);
  for (const [name, engine] of Object.entries(engines)) browsers.set(name, await engine.launch());
});
after(async () => {
  for (const b of browsers.values()) await b.close();
  site?.close();
});

for (const [file, trace] of traces) {
  const row = rowOf(trace.row, trace.variant);
  for (const engine of Object.keys(engines)) {
    test(`${file} in ${engine}: ${row.title}`, { todo: row.open.includes(trace.target as Target) }, async () => {
      const page = await browsers.get(engine)!.newPage({ viewport: { width: 1200, height: 800 } });
      // a plant BREEZY_PLANT names, in the page as in Node (TESTING.md)
      if (process.env.BREEZY_PLANT) await page.addInitScript((p) => void (globalThis.__breezyPlant = p), process.env.BREEZY_PLANT);
      try {
        await page.goto(`http://localhost:${PORT}/?demo=edit&record`);
        await page.waitForFunction(() => "breezyRecord" in window && (document.activeElement as HTMLElement | null)?.isContentEditable);
        await page.evaluate(setCaret, trace.before.at);
        const state = () => page.evaluate(async () => ((await import("/record.js" as string)) as typeof import("../../web/record.ts")).editorState());
        const start: EditorState = await state();
        assert.equal(start.text, trace.before.text, "the replay starts from the trace's text");
        await page.evaluate(replaySteps, trace.steps);
        assert.equal(row.expect(start, await state()), null);
      } finally {
        await page.close();
      }
    });
  }
}

test("replay puts an input where the browser's range says, not where the text's diff guesses", async () => {
  const page = await browsers.get("chromium")!.newPage({ viewport: { width: 1200, height: 800 } });
  try {
    await page.goto(`http://localhost:${PORT}/?demo=edit&record`);
    await page.waitForFunction(() => "breezyRecord" in window && (document.activeElement as HTMLElement | null)?.isContentEditable);
    // "ff" in "offsite": an "f" typed between them is the same text change as one typed after them
    await page.evaluate(replaySteps, [{ t: 0, type: "input", inputType: "insertText", data: "f", isComposing: false, range: [10, 10], edit: [11, 11, "f"] }] as Step[]);
    const at = await page.evaluate(async () => ((await import("/record.js" as string)) as typeof import("../../web/record.ts")).editorState().at);
    assert.equal(at, 11);
  } finally {
    await page.close();
  }
});
