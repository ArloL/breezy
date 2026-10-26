// Nothing waits without end: each CI job has a deadline, and each test file on real devices exits after its last test.
// A run once sat an hour after every case had passed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("every CI job on a runner has a timeout", () => {
  const dir = join(root, ".github/workflows");
  const missing: string[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
    const jobs = readFileSync(join(dir, f), "utf8").split(/^jobs:$/m)[1]!.split(/^(?=\S)/m)[0]!;
    for (const job of jobs.split(/^(?=  [\w-]+:\s*$)/m).filter((j) => /^  [\w-]+:/.test(j))) {
      if (/^    runs-on:/m.test(job) && !/^    timeout-minutes:/m.test(job)) missing.push(`${f} ${job.trim().split(":")[0]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("every test file on real devices exits after its last test", () => {
  const files = ["scenarios", "scenarios/platform"].flatMap((d) => readdirSync(join(root, d)).filter((f) => f.endsWith(".e2e.ts")).map((f) => `${d}/${f}`));
  assert.ok(files.length > 0);
  assert.deepEqual(files.filter((f) => !/\nexitsAfter\([\w]*\);\n$/.test(readFileSync(join(root, f), "utf8"))), []);
});
