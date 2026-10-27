// Which cases a run on real devices gets: all, or with SCENARIO_SMOKE=1 the few marked `smoke`, Main's share of them.
import type { Case } from "./cases.ts";

/** `cases`, or those marked `smoke` when `env` (SCENARIO_SMOKE) is "1"; none marked is an error, not an empty run. */
export function smoke(cases: Case[], env: string | undefined = process.env.SCENARIO_SMOKE): Case[] {
  if (env !== "1") return cases;
  const set = cases.filter((c) => c.smoke);
  if (set.length === 0) throw new Error("SCENARIO_SMOKE=1 but no case is marked smoke");
  return set;
}
