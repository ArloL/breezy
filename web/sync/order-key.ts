// Fractional order keys, as BreezyKit's OrderKey: base-62 digits compared as strings, never ending in "0", so that a
// key fits between any two. Cards sort by key, then id, so equal keys are harmless.

/** Card id → its order key. */
export type Orders = { [id: string]: string };

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export const valid = (k: unknown): k is string => typeof k === "string" && k.length > 0 && !k.endsWith("0") && [...k].every((c) => DIGITS.includes(c));

/** A key after `a` and before `b`; "" is the start and null the end. Needs a < b, both valid or "". */
export function between(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while (n < b.length && (a[n] ?? "0") === b[n]) n++;
    if (n > 0) return b.slice(0, n) + between(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.floor((da + db + 1) / 2)];
  if (b !== null && b.length > 1) return b[0];
  return DIGITS[da] + between(a.slice(1), null);
}

/** The indices of a longest strictly increasing run of the keys present. */
export function longestIncreasing<T extends string | number>(keys: (T | null)[]): Set<number> {
  const tails: number[] = [];
  const prev: (number | null)[] = new Array(keys.length).fill(null);
  keys.forEach((k, i) => {
    if (k === null) return;
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (keys[tails[m]]! < k) lo = m + 1;
      else hi = m;
    }
    prev[i] = lo > 0 ? tails[lo - 1] : null;
    tails[lo] = i;
  });
  const out = new Set<number>();
  for (let at = tails.at(-1) ?? null; at !== null; at = prev[at]) out.add(at);
  return out;
}

/** Keys for `ids` in this order, keeping as many of `keys` as stay in order, so a reorder rewrites few cards. */
export function assign(ids: string[], keys: Orders): Orders {
  const known = ids.map((id) => (valid(keys[id]) ? keys[id] : null));
  const kept = longestIncreasing(known);
  const out: Orders = {};
  let i = 0;
  while (i < ids.length) {
    if (kept.has(i)) {
      out[ids[i]] = known[i]!;
      i++;
      continue;
    }
    let j = i;
    while (j < ids.length && !kept.has(j)) j++;
    let lo = i > 0 ? out[ids[i - 1]] : "";
    const hi = j < ids.length ? known[j] : null;
    for (let k = i; k < j; k++) out[ids[k]] = lo = between(lo, hi);
    i = j;
  }
  return out;
}
