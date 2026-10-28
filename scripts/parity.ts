#!/usr/bin/env node
// The hub's fakes held to the real devices they stand for: each real run of a night that passed beside the hub's run of
// the same case and kinds, by the decisions each device took, not in what order or how the harness got there (a real
// device's harness makes a card by editing it, the hub's by an op). A fake that decides what its real device never did
// lies, as the fake that drew a turned card at its front's size did before #129. Differences known and explained are in
// scripts/parity-known.json. As Markdown for the nightly summary, a report while it proves itself:
// node scripts/parity.ts REAL_DIR HUB_DIR >> "$GITHUB_STEP_SUMMARY"
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recording, runs, sign } from "./controls.ts";
import type { Recording } from "../web/flight.ts";

/** A difference explained: a decision only one side takes, and why that is no lie. */
export interface Known {
  signature: string;
  only: "real" | "fake";
  reason: string;
}

const KNOWN = fileURLToPath(new URL("parity-known.json", import.meta.url));

/** The hub's device that stands for real device `kind`. */
export const fakeOf = (kind: string) =>
  kind.startsWith("ios-") ? "phone" : kind.endsWith("android") ? "android" : kind === "mac" ? "swift" : "web";

const decisions = (r: Recording) => new Set(r.entries.filter((e) => e[1] === "decision").map(sign));

export function report(realDir: string, hubDir: string, knownFile = KNOWN): string {
  const known = JSON.parse(readFileSync(knownFile, "utf8")) as Known[];
  const explained = (side: Known["only"], s: string) => known.some((k) => k.only === side && k.signature === s);
  const fakes = existsSync(hubDir) ? [...runs(hubDir)].filter((r) => r.verdict === "passed") : [];
  const out: string[] = [];
  for (const real of existsSync(realDir) ? runs(realDir) : []) {
    if (real.verdict !== "passed") continue;
    const fake = fakes.find((f) => f.case === real.case && f.pair.every((k, i) => k === fakeOf(real.pair[i]!)));
    if (!fake) continue;
    const lines = real.pair.flatMap((kind, i) => {
      const a = recording(real, i), b = recording(fake, i);
      if (!a || !b) return [];
      const r = decisions(a), f = decisions(b);
      const onlyReal = [...r].filter((s) => !f.has(s) && !explained("real", s));
      const onlyFake = [...f].filter((s) => !r.has(s) && !explained("fake", s));
      if (!onlyReal.length && !onlyFake.length) return [];
      const say = (who: string, list: string[]) => list.length ? [`only the ${who} decided ${list.map((s) => `\`${s}\``).join(", ")}`] : [];
      return [`- d${i} ${kind} against the hub's ${fake.pair[i]}: ${[...say("real device", onlyReal), ...say("fake", onlyFake)].join("; ")}`];
    });
    if (lines.length) out.push(`### ${real.case}`, "", `\`${real.pair.join(" → ")}\` against the hub's \`${fake.pair.join(" → ")}\`:`, "", ...lines, "");
  }
  if (!out.length) return "";
  return ["## Fakes against real devices", "",
    "Decisions the hub's fake and the real device it stands for did not both take, in a case both passed: a fake that lies, or a difference to explain in scripts/parity-known.json.", "",
    ...out].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(report(process.argv[2]!, process.argv[3]!));
