import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Main's sync job keeps a failing hub case's recordings", () => {
  const main = readFileSync(new URL("../../.github/workflows/main.yaml", import.meta.url), "utf8");
  const sync = main.slice(main.indexOf("\n  sync:\n"), main.indexOf("\n  web:\n"));
  assert.match(sync, /- if: \$\{\{ failure\(\) \}\}\n\s+uses: actions\/upload-artifact@\S+ # \S+\n\s+with:\n\s+name: hub\n\s+path: build\/hub\n/);
});
