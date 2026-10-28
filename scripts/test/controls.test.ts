// A failed run beside its control, a run of the same case that passed: where their recordings part, and what only the
// failure has, which is where to look, and what both have, which is not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compare, report } from "../controls.ts";
import type { Entry, Recording } from "../../web/flight.ts";

const rec = (entries: Entry[]): Recording => ({ schema: 1, origin: 0, dropped: 0, context: null, entries });
const edit: Entry = [1, "transition", "edit", { id: "a", back: false }];
const fits: Entry = [2, "decision", "reveal", { path: "card", why: "fits", area: [58, 700] }];
const noCaret: Entry = [2, "decision", "reveal", { path: "card", why: "no caret", area: [58, 308] }];
const broken: Entry = [3, "decision", "sight broken", { focus: [16, 4, 343, 288] }];

test("finds where a failure parts from its control, and the signals only the failure has", () => {
  const c = compare(rec([edit, noCaret, broken]), rec([edit, fits]));
  assert.deepEqual(c.parts, { at: 1, failed: "decision reveal card/no caret", control: "decision reveal card/fits" });
  assert.deepEqual(c.only, ["decision reveal card/no caret", "decision sight broken"]);
});

test("recordings alike give nothing to look at", () => {
  assert.deepEqual(compare(rec([edit, fits]), rec([edit, fits])), { parts: null, only: [] });
});

test("a night's failed run is set beside a run of its case that passed, device by device", () => {
  const dir = mkdtempSync(join(tmpdir(), "controls-"));
  const run = (name: string, verdict: string, pair: string[], d0: Entry[]) => {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "case.json"), JSON.stringify({ case: "a turned card", pair, verdict, error: verdict === "passed" ? undefined : "out of sight" }));
    writeFileSync(join(dir, name, `d0 ${pair[0]} flight.json`), JSON.stringify(rec(d0)));
  };
  run("1", "failed", ["ios-home", "chromium"], [edit, noCaret, broken]);
  run("2", "passed", ["android", "chromium"], [edit, fits]);
  const md = report(dir);
  assert.match(md, /a turned card/);
  assert.match(md, /`ios-home → chromium` failed.*against `android → chromium`/);
  assert.match(md, /decision sight broken/);
});

test("a failure whose app recorded nothing where its control's did says so, as that is the signal", () => {
  const dir = mkdtempSync(join(tmpdir(), "controls-"));
  for (const [name, verdict, d0] of [["1", "failed", null], ["2", "passed", [edit, fits]]] as const) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "case.json"), JSON.stringify({ case: "offline launch", pair: ["chromium", "webkit"], verdict }));
    if (d0) writeFileSync(join(dir, name, "d0 chromium flight.json"), JSON.stringify(rec([...d0])));
  }
  assert.match(report(dir), /d0 chromium: the failure's app recorded nothing, the control's 2 entries/);
});

test("a failure with no run of its case that passed says so", () => {
  const dir = mkdtempSync(join(tmpdir(), "controls-"));
  mkdirSync(join(dir, "1"));
  writeFileSync(join(dir, "1", "case.json"), JSON.stringify({ case: "alone", pair: ["ios-home", "chromium"], verdict: "failed" }));
  assert.match(report(dir), /no run of it passed/);
});
