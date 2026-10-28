// Drawn steps on both cores, each seed's board and steps from scenarios/parity/steps.ts; a run that parts them is shrunk
// to the fewest steps that still do. PARITY_SEEDS=from:count draws others, as the nightly does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { differ } from "./parity/core.ts";
import { draw, run, type Step } from "./parity/steps.ts";

const [from, count] = (process.env.PARITY_SEEDS ?? "1:20").split(":").map(Number) as [number, number];
const STEPS = Number(process.env.PARITY_STEPS ?? 12);

/** The fewest of `steps` found that still part the cores, dropping one at a time from the last. */
async function shrink(setUp: Parameters<typeof differ>[0], steps: Step[]) {
  let kept = steps;
  for (let i = kept.length - 1; i >= 0; i--) {
    const candidate = kept.toSpliced(i, 1);
    if (await differ(setUp, candidate.map(run))) kept = candidate;
  }
  return kept;
}

for (let seed = from; seed < from + count; seed++) {
  test(`the cores agree on drawn steps: seed ${seed}`, async () => {
    const { setUp, steps } = draw(seed, STEPS);
    const d = await differ(setUp, steps.map(run));
    if (!d) return;
    const kept = await shrink(setUp, steps.slice(0, d.at + 1));
    const last = (await differ(setUp, kept.map(run)))!;
    assert.deepEqual(last.web, last.swift, `web against Swift after ${JSON.stringify(kept)}`);
  });
}
