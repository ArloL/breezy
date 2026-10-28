// A night held to the one before by what each device did in each case that passed on both: a case's input is the
// same each night, so a device that now decides, goes through or takes something a different number of times moved
// before anything failed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { report } from "../nights.ts";
import type { Entry } from "../../web/flight.ts";

const edit: Entry = [1, "transition", "edit", { id: "a", back: false }];
const tap: Entry = [1, "input", "tap", { x: 1, y: 2 }];
const reveal: Entry = [2, "decision", "reveal", { path: "card", why: "fits" }];
const geometry: Entry = [3, "geometry", "viewport", { inner: [400, 800] }];

const night = (root: string, d0: Entry[], verdict = "passed") => {
  const dir = join(root, Math.random().toString(36).slice(2));
  mkdirSync(join(dir, "1"), { recursive: true });
  writeFileSync(join(dir, "1", "case.json"), JSON.stringify({ case: "a card", pair: ["chromium", "webkit"], verdict }));
  writeFileSync(join(dir, "1", "d0 chromium flight.json"), JSON.stringify({ schema: 1, origin: 0, dropped: 0, context: null, entries: d0 }));
  return dir;
};

test("a device that did something a different number of times than on the last night is named, with both counts", () => {
  const root = mkdtempSync(join(tmpdir(), "nights-"));
  const md = report(night(root, [tap, edit, reveal]), night(root, [tap, tap, edit, reveal, reveal, reveal]));
  assert.match(md, /a card \(chromium → webkit\)/);
  assert.match(md, /d0 chromium: `input tap` 1 → 2/);
});

test("the same counts, or only geometry, which moves with the runner, give nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "nights-"));
  assert.equal(report(night(root, [tap, edit, geometry]), night(root, [tap, edit, geometry, geometry])), "");
});

test("reveals, which the keyboard's timing repeats, and a case drawn at random each night are no measure", () => {
  const root = mkdtempSync(join(tmpdir(), "nights-"));
  assert.equal(report(night(root, [edit, reveal]), night(root, [edit, reveal, reveal])), "");
  const randomNight = (d0: Entry[]) => {
    const dir = night(root, d0);
    writeFileSync(join(dir, "1", "case.json"), JSON.stringify({ case: "keys pressed at random", pair: ["chromium", "webkit"], verdict: "passed" }));
    return dir;
  };
  assert.equal(report(randomNight([tap]), randomNight([tap, tap])), "");
});

test("a case that failed on either night is no measure of the other", () => {
  const root = mkdtempSync(join(tmpdir(), "nights-"));
  assert.equal(report(night(root, [tap]), night(root, [tap, tap], "failed")), "");
});
