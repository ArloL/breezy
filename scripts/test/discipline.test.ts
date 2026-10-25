// What keeps the scenarios stable, kept so (TESTING.md, "Two jobs"): a case waits for a condition, not for a time, and
// drives a device only through scenarios/device.ts, so that one kind of device cannot be driven another way in one case.
// Each fixed wait a case keeps is listed here with why it is not a condition.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const cases = readFileSync(new URL("../../scenarios/cases.ts", import.meta.url), "utf8");

/** Each fixed wait in scenarios/cases.ts, as its line reads, how many times, and why. */
const WAITS: [line: string, times: number, why: string][] = [
  ["await d.wait(250);", 1, "eventually()'s poll"],
  ["await d.wait(100);", 3, "polls in shows() and weights() until what is drawn settles"],
  ["if (input === \"touch\") await a.wait(600);", 2, "a person's pause after a double tap, so that the next tap is no triple tap"],
  ["await a.wait(400);", 3, "a person's pause after a tap, so that the next one is no double tap"],
  ["await a.wait(2000);", 1, "the offline case's drag, given time to be saved before the device goes online"],
  ["await a.wait(100);", 1, "the hold that lifts a card under a still finger"],
  ["await b.wait(100);", 1, "the other device's drag, given time to be refused"],
  ["await a.wait(50);", 1, "a move after the other device's refusal"],
  ["await a.wait(300);", 1, "a phone's double tap opening its editor before keys, as a person waits for the keyboard"],
  ["await a.wait(1500);", 1, "a pinch's coast, which a desktop browser's still() does not wait for"],
];

test("a case waits a fixed time only where it says why", () => {
  const found = new Map<string, number>();
  for (const l of cases.split("\n")) if (/\.wait\(\d/.test(l)) found.set(l.trim(), (found.get(l.trim()) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries([...found].sort()), Object.fromEntries(WAITS.map(([l, n]) => [l, n] as const).sort()));
});

test("a case sleeps on no timer of its own and drives no browser but through a device", () => {
  for (const banned of [/setTimeout\(/, /\bsleep\(/, /\bpage\./, /playwright/, /\bdriver\b/]) assert.doesNotMatch(cases, banned);
});
