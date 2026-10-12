/**
 * A coast keeps this fraction of its velocity each millisecond. Freeform's canvas, measured on an iPhone, coasts
 * about 65 ms × the release velocity, much shorter than a UIScrollView list's 0.998.
 */
export const DECEL = 0.985;
const K = Math.log(DECEL);

/**
 * Edge auto-scroll: a zone wide enough for a thumb, which rests up to 28 pt from the edge it reaches less easily; then a
 * speed that grows ×e every 400 ms, as Freeform's does for its first 0.7 s, up to 600 pt/s at 1.2 s. Freeform instead
 * jumps to 1,330 pt/s by 0.95 s. Speeds in pt/ms.
 */
export const EDGE_ZONE = 32;
const EDGE_MIN = 0.03;
const EDGE_TAU = 400;
const EDGE_MAX = 0.6;

export const decay = (v: number, ms: number) => v * DECEL ** ms;
export const coastOffset = (v: number, ms: number) => (v * (DECEL ** ms - 1)) / K;
export const projection = (v: number) => -v / K;

/** UIKit's rubber band: how far content moves when pulled `x` past its limit, for a dimension `d`. */
export const rubber = (x: number, d: number, c = 0.55) => Math.sign(x) * (1 - 1 / ((Math.abs(x) * c) / d + 1)) * d;

/** Auto-scroll speed in pt/ms for a finger `depth` points from the edge that has stayed in the zone `heldMs`. */
export function edgeSpeed(depth: number, heldMs: number) {
  return depth > EDGE_ZONE ? 0 : Math.min(EDGE_MAX, EDGE_MIN * Math.exp(heldMs / EDGE_TAU));
}
