// Only a job that never had a step is run again: the gate is red for bugs, and nothing that ran is run again into green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const yaml = readFileSync(fileURLToPath(new URL("../../.github/workflows/rerun-unstarted.yaml", import.meta.url)), "utf8");
const filter = /\| jq -r '([^']+)'\)/.exec(yaml)![1]!;
const unstarted = (jobs: unknown[]) => execFileSync("jq", ["-r", filter], { input: JSON.stringify({ jobs }), encoding: "utf8", timeout: 10_000 }).trim();
const step = { name: "a step", conclusion: "success" };

test("a job cancelled with no step counts", () => {
  assert.equal(unstarted([{ name: "macos", conclusion: "cancelled", steps: [] }]), "macos");
});

test("a job that ran does not, however it ended", () => {
  assert.equal(unstarted([
    { name: "failed", conclusion: "failure", steps: [step] },
    { name: "timed out", conclusion: "cancelled", steps: [step] },
    { name: "passed", conclusion: "success", steps: [step] },
    { name: "skipped", conclusion: "skipped", steps: [] },
  ]), "");
});

test("it runs a run again once, and only a red one", () => {
  assert.match(yaml, /workflow_run\.conclusion == 'failure' && github\.event\.workflow_run\.run_attempt == 1/);
});
