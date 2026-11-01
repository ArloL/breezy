// A Chrome a script starts itself keeps out of the Mac's keychain, as Playwright's do: one that asks for it prompts for
// the owner's password on their Mac.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("every Chrome a script starts itself uses a mock keychain", () => {
  const files = ["scripts", "scenarios"].flatMap((d) => readdirSync(join(root, d)).filter((f) => f.endsWith(".ts")).map((f) => `${d}/${f}`));
  const launches = files.flatMap((f) => readFileSync(join(root, f), "utf8").split("\n").filter((l) => l.includes('"--headless')).map((l) => [f, l] as const));
  assert.ok(launches.length > 0);
  assert.deepEqual(launches.filter(([, l]) => !l.includes('"--use-mock-keychain"')).map(([f]) => f), []);
});
