// SplitMix64, as BreezyKit's tests seed theirs: the same seed draws the same numbers everywhere.
export class Rng {
  constructor(seed) {
    this.state = BigInt.asUintN(64, BigInt(seed));
  }

  next64() {
    this.state = BigInt.asUintN(64, this.state + 0x9e3779b97f4a7c15n);
    let z = this.state;
    z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
    z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
    return z ^ (z >> 31n);
  }

  /** In [0, 1). */
  float() {
    return Number(this.next64() >> 11n) / 2 ** 53;
  }

  /** In [0, n). */
  int(n) {
    return Math.floor(this.float() * n);
  }

  between(lo, hi) {
    return lo + this.float() * (hi - lo);
  }

  chance(p) {
    return this.float() < p;
  }

  pick(xs) {
    return xs[this.int(xs.length)];
  }

  /** An entry of `{key: weight}`, by weight; null when all are 0. */
  weighted(weights) {
    const entries = Object.entries(weights).filter(([, w]) => w > 0);
    let r = this.float() * entries.reduce((s, [, w]) => s + w, 0);
    for (const [k, w] of entries) if ((r -= w) < 0) return k;
    return entries.at(-1)?.[0] ?? null;
  }

  bytes(n) {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = Number(this.next64() & 0xffn);
    return out;
  }

  /** A seed for something else, so that adding draws here does not shift its numbers. */
  fork() {
    return this.next64();
  }
}
