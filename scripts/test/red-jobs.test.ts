// What a workflow's own report calls red: a job GitHub never gave a runner reads `abandoned` or `cancelled`, not `failure`,
// and the weekly mutation run's report once took BreezyKit's for green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));
const reports = readdirSync(dir).filter((f) => f.endsWith(".yaml")).flatMap((f) =>
  [...readFileSync(join(dir, f), "utf8").matchAll(/red=\$\(jq -r '([^']+)' <<< "\$RESULTS"\)/g)].map((m) => [f, m[1]!] as const));

const results = Object.fromEntries(["success", "skipped", "failure", "cancelled", "abandoned", "timed_out"].map((r) => [r, { result: r, outputs: {} }]));

test("each workflow's report finds its jobs by the same words", () => {
  for (const f of ["mutation.yaml", "nightly.yaml"]) assert.ok(reports.some(([r]) => r === f), f);
});

for (const [file, filter] of reports) {
  test(`${file} calls red whatever did not run to success, and only that`, () => {
    const red = execFileSync("jq", ["-r", filter], { input: JSON.stringify(results), encoding: "utf8", timeout: 10_000 }).trim();
    assert.equal(red, "failure, cancelled, abandoned, timed_out");
  });
}
