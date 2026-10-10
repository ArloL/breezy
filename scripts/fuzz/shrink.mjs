// Shrinks a failing trace by delta debugging: drops chunks of its run phase while a replay still fails the same way.
import { Hub } from "./hub.mjs";

/** What a failure is, without its numbers, so that a smaller trace failing otherwise does not count. */
export const kindOf = (problems) => [...new Set(problems.map((p) => p.problem.replace(/[0-9]+/g, "N").replace(/ on .*/, "")))].sort().join("; ");

/** The smallest trace found within `runs` replays that still fails as `want` does; `log` hears of progress. */
export async function shrink(opts, trace, { runs = 60, log = () => {} } = {}) {
  const fixed = trace.filter((e) => e.phase !== "run" || e.derived || !["op", "fault", "link"].includes(e.kind));
  let entries = trace.filter((e) => !fixed.includes(e));
  const fails = async (candidate) => {
    const r = await new Hub({ ...opts, replay: [...fixed, ...candidate] }).run();
    return r.ok ? null : r;
  };
  const first = await fails(entries);
  if (!first) return null;
  const want = kindOf(first.problems);
  let best = first, used = 1, n = 2;
  while (entries.length >= 2 && used < runs) {
    const size = Math.ceil(entries.length / n);
    let reduced = false;
    for (let i = 0; i < entries.length && used < runs; i += size) {
      const candidate = [...entries.slice(0, i), ...entries.slice(i + size)];
      used++;
      const r = await fails(candidate);
      if (r && kindOf(r.problems) === want) {
        entries = candidate;
        best = r;
        n = Math.max(n - 1, 2);
        reduced = true;
        log(`  ${entries.length} entries (${used} replays)`);
        break;
      }
    }
    if (!reduced) {
      if (size === 1) break;
      n = Math.min(entries.length, n * 2);
    }
  }
  return { entries: entries.length, trace: [...fixed, ...entries], problems: best.problems, replays: used };
}
