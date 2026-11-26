// A step is red when what it runs is: a workflow whose steps pipe a command runs them with pipefail, as a step's
// pipeline otherwise ends in its last command's status. The nightly's strokes step went green on 2026-11-26 with two
// of its three browsers red, `node … | tee | sed` ending in sed's 0 (docs/escapes.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(fileURLToPath(new URL("../../", import.meta.url)), ".github/workflows");
const PIPE = /(?<![|])\|(?![|])\s*(tee|sed|grep|head|tail|jq|awk|sort|tr|cut|xargs|wc)\b/;
const DEFAULT = /^defaults:\n  run:\n    shell: bash -e -o pipefail \{0\}$/m;
setTimeout(() => { console.error("workflows ran past 30 s"); process.exit(1); }, 30_000).unref();

/** The workflow files of `texts` whose steps pipe a command and do not all run with pipefail. */
export function unpiped(texts: Record<string, string>): string[] {
  return Object.entries(texts)
    .filter(([, s]) => PIPE.test(s) && (!DEFAULT.test(s) || /^\s+shell: (?!bash -e -o pipefail)/m.test(s)))
    .map(([f]) => f);
}

test("a workflow whose steps pipe a command runs them with pipefail", () => {
  const texts = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".yaml")).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
  assert.deepEqual(unpiped(texts), []);
});

test("a pipe is found in a step, and pipefail in the workflow's defaults or overridden by a step's own shell", () => {
  const step = "jobs:\n  a:\n    steps:\n    - run: node t.ts | tee out.txt\n";
  const safe = "defaults:\n  run:\n    shell: bash -e -o pipefail {0}\n";
  assert.deepEqual(unpiped({ bare: step, safe: safe + step, or: "jobs:\n  a:\n    steps:\n    - run: a || b\n" }), ["bare"]);
  assert.deepEqual(unpiped({ own: safe + step + "      shell: bash {0}\n" }), ["own"]);
});
