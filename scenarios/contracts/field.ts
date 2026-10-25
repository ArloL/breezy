// What a field being edited promises the app (web/ports.ts's Field), whatever draws it: the same cases run against the
// hub's FakeField in Node (scenarios/field-contract.test.ts) and against DomField in each browser
// (scenarios/platform/field-contract.test.ts), so that typing on the hub keeps to what a browser does.
import assert from "node:assert/strict";

/** A field to check, as the app makes one, and the keys and focus a person gives it. */
export interface FieldHarness {
  /** Opens a field of `kind` on `text`; with `enter`, Return ends it, as a lane's title. */
  open(kind: "front" | "notes" | "title", text: string, enter?: boolean): Promise<void>;
  /** Keys at the caret; "\n" is Return. */
  type(text: string): Promise<void>;
  text(): Promise<string>;
  caret(): Promise<number | null>;
  /** Another field takes the keyboard. */
  focusAnother(): Promise<void>;
  close(): Promise<void>;
  /** What the field told the app so far: "input", "done" or "enter", in turn. */
  told(): Promise<string[]>;
}

export const FIELD_CASES: { name: string; run(h: FieldHarness): Promise<void> }[] = [
  {
    name: "opening shows the text, with the caret at its end",
    async run(h) {
      await h.open("front", "Title\nline");
      assert.equal(await h.text(), "Title\nline");
      assert.equal(await h.caret(), 10);
    },
  },
  {
    name: "each key typed tells input, and the text holds it",
    async run(h) {
      await h.open("notes", "ab");
      await h.type("cd");
      assert.equal(await h.text(), "abcd");
      assert.equal((await h.told()).filter((t) => t === "input").length, 2);
    },
  },
  {
    name: "Return in a front starts a line",
    async run(h) {
      await h.open("front", "T");
      await h.type("\nx");
      assert.equal(await h.text(), "T\nx");
      assert.ok(!(await h.told()).includes("enter"));
    },
  },
  {
    name: "Return in a field that Return ends tells enter, and adds no line",
    async run(h) {
      await h.open("title", "Lane", true);
      await h.type("\n");
      assert.ok((await h.told()).includes("enter"));
      assert.equal(await h.text(), "Lane");
    },
  },
  {
    name: "another field taking the keyboard tells done",
    async run(h) {
      await h.open("notes", "a");
      await h.focusAnother();
      assert.deepEqual((await h.told()).filter((t) => t === "done"), ["done"]);
    },
  },
  {
    // its caret is not part of it: a browser leaves the selection where it was, and the app asks only while editing
    name: "a closed field tells nothing more",
    async run(h) {
      await h.open("notes", "a");
      await h.close();
      const told = (await h.told()).length;
      await h.type("b").catch(() => {});
      assert.equal((await h.told()).length, told);
    },
  },
];
