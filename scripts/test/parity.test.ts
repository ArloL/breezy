// The hub's fakes held to the real devices they stand for, by what each decided in the same case: where a fake decides
// otherwise, it lies, as the fake that drew a turned card at its front's size did before #129.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeOf, report, type Known } from "../parity.ts";
import type { Entry, Recording } from "../../web/flight.ts";

const rec = (entries: Entry[]): Recording => ({ schema: 1, origin: 0, dropped: 0, context: null, entries });
const edit: Entry = [1, "transition", "edit", { id: "a", back: true }];
const tall: Entry = [2, "decision", "reveal", { path: "caret", why: "too tall" }];
const fits: Entry = [2, "decision", "reveal", { path: "card", why: "fits" }];

const night = (real: Entry[], fake: Entry[], known: Known[] = []) => {
  const dir = mkdtempSync(join(tmpdir(), "parity-")), realDir = join(dir, "real"), hubDir = join(dir, "hub");
  const run = (at: string, pair: string[], d0: Entry[]) => {
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, "case.json"), JSON.stringify({ case: "a turned card", pair, verdict: "passed" }));
    writeFileSync(join(at, `d0 ${pair[0]} flight.json`), JSON.stringify(rec(d0)));
  };
  run(join(realDir, "1"), ["ios-home", "chromium"], real);
  run(join(hubDir, "1"), ["phone", "web"], fake);
  const knownFile = join(dir, "known.json");
  writeFileSync(knownFile, JSON.stringify(known));
  return report(realDir, hubDir, knownFile);
};

test("each real kind is held to the fake that stands for it", () => {
  assert.equal(fakeOf("ios-home"), "phone");
  assert.equal(fakeOf("ios-safari"), "phone");
  assert.equal(fakeOf("firefox-android"), "android");
  assert.equal(fakeOf("webkit"), "web");
  assert.equal(fakeOf("mac"), "swift");
});

test("a fake that decided otherwise than its real device in the same case is named, with what each decided alone", () => {
  const md = night([edit, tall], [edit, fits]);
  assert.match(md, /a turned card/);
  assert.match(md, /d0 ios-home against the hub's phone: only the real device decided `decision reveal caret\/too tall`; only the fake decided `decision reveal card\/fits`/);
});

test("only what each decided is held alike, not how the harness got there", () => {
  assert.doesNotMatch(night([edit, edit, tall], [tall]), /only the/);
});

test("a difference known and explained is left out, on its side only", () => {
  const known: Known[] = [{ signature: "decision reveal card/fits", only: "real", reason: "a real device's harness makes a card by editing it" }];
  assert.doesNotMatch(night([edit, fits, tall], [tall], known), /only the/);
  assert.match(night([edit, tall], [edit, fits], known), /only the fake decided `decision reveal card\/fits`/);
});
