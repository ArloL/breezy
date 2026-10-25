// The hub's FakeField held to the field contract that DomField keeps in each browser (scenarios/contracts/field.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../web/app.ts";
import { fakePorts, type FakeField, type FakeView } from "../web/test/fakes.ts";
import { FIELD_CASES, type FieldHarness } from "./contracts/field.ts";

globalThis.requestAnimationFrame ??= (f) => setTimeout(() => f(performance.now()), 16) as unknown as number;
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

function fake(): FieldHarness {
  const app = new App({ cards: [{ id: "c", x: 0, y: 0, w: 240, text: "", color: 1 }], lanes: [{ id: "l", x: 0, y: 200, w: 288, h: 720, title: "" }] }, fakePorts);
  const view = app.view as FakeView;
  const told: string[] = [];
  let field: FakeField;
  return {
    async open(kind, text, enter) {
      field = (kind === "title" ? view.titleOf("l") : view.editorOf("c", kind === "notes")) as FakeField;
      field.open(text, { input: () => told.push("input"), done: () => told.push("done"), ...enter ? { enter: () => told.push("enter") } : {} });
    },
    async type(text) {
      for (const k of text) field.type(k);
    },
    async text() {
      return field.text();
    },
    async caret() {
      return field.caret();
    },
    async focusAnother() {
      view.focus(view.titleOf("l") as FakeField);
    },
    async close() {
      field.close();
    },
    async told() {
      return [...told];
    },
  };
}

for (const c of FIELD_CASES) test(`the hub's field: ${c.name}`, () => c.run(fake()));

/** The hub's field drifted as a fake can: its keys change the text without telling the app. */
function drifted(): FieldHarness {
  const h = fake();
  let typed = "";
  return { ...h, type: async (text) => void (typed += text), text: async () => (await h.text()) + typed };
}

test("a fake whose keys tell the app nothing fails the contract", async () => {
  const failed = (await Promise.all(FIELD_CASES.map((c) => c.run(drifted()).then(() => null, () => c.name)))).filter(Boolean);
  assert.ok(failed.length > 0, "no case saw it");
});
