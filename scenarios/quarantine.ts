// Cases over their flake budget on a pair (TESTING.md, "Two jobs"), out of Main's checks on push until fixed, with why and
// since when; the soaks still run them, as SCENARIO_QUARANTINE=skip is Main's alone.
export interface Quarantined {
  /** The case's name, as in cases.ts. */
  case: string;
  /** The pair, as "acts:watches"; every pair when left out. */
  pair?: string;
  why: string;
  since: string;
}

export const QUARANTINE: Quarantined[] = [];

/** Why case `name` on `pair` is out of the checks on push, or null. */
export function quarantined(name: string, pair: string, list = QUARANTINE): string | null {
  const q = list.find((q) => q.case === name && (!q.pair || q.pair === pair));
  return q ? `quarantined since ${q.since}: ${q.why}` : null;
}
