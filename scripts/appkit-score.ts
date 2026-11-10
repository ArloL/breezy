// How many of the AppKit edge cases (web/test/appkit-edge.json) WheelPan, as the tree has it now, moves as AppKit did,
// within each case's noise, measure by measure and by kind of stroke: a scoreboard for tuning it.
//
//   node scripts/appkit-score.ts
import { readFileSync } from "node:fs";
import { compare, KEYS } from "../web/test/helpers/appkit.ts";
import type { Fixture } from "./reference-fixture.ts";

const f: Fixture = JSON.parse(readFileSync(new URL("../web/test/appkit-edge.json", import.meta.url), "utf8"));
const kinds = new Map<string, Record<string, number>>(), total: Record<string, number> = {}, offs: Record<string, number[]> = {};
for (const c of f.cases) {
  const kind = c.name.replace(/-\d+$/, ""), row = kinds.get(kind) ?? { n: 0 };
  row.n++;
  for (const m of compare(c)) (offs[m.k] ??= []).push(m.off);
  for (const m of compare(c)) if (m.off <= m.within) { row[m.k] = (row[m.k] ?? 0) + 1; total[m.k] = (total[m.k] ?? 0) + 1; }
  kinds.set(kind, row);
}
console.log(`| Strokes | n | ${KEYS.join(" | ")} |\n|---|---|${KEYS.map(() => "---").join("|")}|`);
for (const [kind, row] of kinds) console.log(`| ${kind} | ${row.n} | ${KEYS.map((k) => row[k] ?? 0).join(" | ")} |`);
console.log(`| all | ${f.cases.length} | ${KEYS.map((k) => total[k] ?? 0).join(" | ")} |`);
const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1];
console.log(`| median off | | ${KEYS.map((k) => `${median(offs[k]).toFixed(0)} ${k === "settle" ? "ms" : "pt"}`).join(" | ")} |`);
