// DomField held to the field contract in Chromium, Firefox and WebKit, through each browser's own keys and focus, as the
// hub's FakeField is in Node (scenarios/contracts/field.ts).
import { after, before, test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright-core";
import { buildSite, serveStatic } from "../browser.ts";
import { FIELD_CASES, type FieldHarness } from "../contracts/field.ts";

const root = new URL("../..", import.meta.url).pathname;
const PORT = 58562;
const engines = { chromium, firefox, webkit };
const browsers = new Map<string, Browser>();
let site: ReturnType<typeof serveStatic>;

before(async () => {
  const out = join(root, "build", "web-contract");
  buildSite(out);
  // a page of the site's own, without the app, where its modules load; the field drawn as style.css draws a card's
  // text, which keeps its newlines
  writeFileSync(join(out, "contract.html"), '<!doctype html><meta charset="utf-8"><title>contract</title><style>#f { white-space: pre-wrap }</style><body>');
  site = serveStatic(out, PORT);
  for (const [name, engine] of Object.entries(engines)) browsers.set(name, await engine.launch());
});
after(async () => {
  for (const b of browsers.values()) await b.close();
  site.close();
  site.closeAllConnections();
});

type Window = { f: { open(t: string, on: object): void; text(): string; caret(): number | null; close(): void }; told: string[] };

function dom(page: Page): FieldHarness {
  return {
    async open(kind, text, enter) {
      await page.goto(`http://127.0.0.1:${PORT}/contract.html`);
      await page.evaluate(async ([kind, text, enter]) => {
        const { DomField } = await import("/field.js" as string);
        document.body.innerHTML = '<div id="f"></div><input id="other">';
        const w = window as unknown as Window;
        w.told = [];
        w.f = new DomField(document.getElementById("f"), kind);
        w.f.open(text, { input: () => w.told.push("input"), done: () => w.told.push("done"), ...enter ? { enter: () => w.told.push("enter") } : {} });
      }, [kind, text, enter ?? false] as const);
    },
    async type(text) {
      for (const part of text.split(/(\n)/)) {
        if (part === "\n") await page.keyboard.press("Enter");
        else if (part) await page.keyboard.type(part);
      }
    },
    text: () => page.evaluate(() => (window as unknown as Window).f.text()),
    caret: () => page.evaluate(() => (window as unknown as Window).f.caret()),
    async focusAnother() {
      await page.focus("#other");
    },
    async close() {
      await page.evaluate(() => (window as unknown as Window).f.close());
    },
    told: () => page.evaluate(() => [...(window as unknown as Window).told]),
  };
}

for (const engine of Object.keys(engines)) {
  for (const c of FIELD_CASES) {
    test(`${engine}'s field: ${c.name}`, async () => {
      const page = await browsers.get(engine)!.newPage();
      try {
        await c.run(dom(page));
      } finally {
        await page.close();
      }
    });
  }
}
