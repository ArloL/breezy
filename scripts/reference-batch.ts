// Replays each of the owner's strokes in build/reference/ into the reference app, checking the replay reproduces
// AppKit's curve, then into Firefox on the dev server; keeps which files belong together in build/reference/cases.json,
// and picks up where it left off. It takes over the pointer and the front window while it runs.
//
//   node scripts/reference-batch.ts
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { check, deltas } from "./reference-check.ts";
import { isStray } from "./reference-fixture.ts";
import { intoFirefox, intoReference, type Stroke } from "./replay.ts";

/** `faithful`: the replay's deltas add up to the recording's, which scripts/reference-fixture.ts requires. */
export interface Case { recorded: string; replayed: string; firefox: string; faithful: boolean }

const root = fileURLToPath(new URL("../", import.meta.url)), dir = `${root}build/reference`, out = `${dir}/cases.json`;
const deadline = setTimeout(() => { console.error("the batch ran past 45 minutes"); process.exit(1); }, 45 * 60_000);
const cases: Case[] = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : [];
const read = (f: string): Stroke => JSON.parse(readFileSync(f, "utf8"));
const todo = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "cases.json" && !f.includes("-replay-")).map((f) => `${dir}/${f}`)
  .filter((f) => !isStray(read(f)) && !cases.some((c) => c.recorded === f));

/** One retry: a window that came up late, or a page that had not loaded. */
async function twice<T>(what: string, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    console.log(`  ${what} failed (${(e as Error).message}); again`);
    return f();
  }
}

for (const [i, f] of todo.entries()) {
  const s = read(f), name = f.split("/").pop();
  console.log(`${i + 1}/${todo.length} ${name}`);
  const replayed = await twice("reference", () => intoReference(s));
  const r = check(s, read(replayed), []);
  console.log(r.lines.map((l) => `  ${l}`).join("\n"));
  const firefox = await twice("firefox", () => intoFirefox(s));
  cases.push({ recorded: f, replayed, firefox, faithful: deltas(s, read(replayed)).length === 0 });
  writeFileSync(out, JSON.stringify(cases, null, 1));
}
console.log(`${cases.length} cases, ${cases.filter((c) => !c.faithful).length} not faithful`);
clearTimeout(deadline);
