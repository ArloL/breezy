/**
 * A coast keeps this fraction of its velocity each millisecond. Freeform's canvas, measured on an iPhone, coasts
 * about 65 ms × the release velocity, much shorter than a UIScrollView list's 0.998.
 */
export const DECEL = 0.985;
const K = Math.log(DECEL);

/**
 * Edge auto-scroll, as measured in Freeform: a narrow zone; a crawl for most of a second, then a sharp speed-up.
 * Speeds in pt/ms by milliseconds held, from the distances Freeform scrolled after holding 0.25 to 0.9 s.
 */
export const EDGE_ZONE = 24;
const EDGE_CURVE = [[0, 0.045], [375, 0.085], [550, 0.13], [650, 0.15], [750, 0.35], [850, 1.1], [950, 1.5]];

export const decay = (v, ms) => v * DECEL ** ms;
export const coastOffset = (v, ms) => (v * (DECEL ** ms - 1)) / K;
export const projection = (v) => -v / K;

/** UIKit's rubber band: how far content moves when pulled `x` past its limit, for a dimension `d`. */
export const rubber = (x, d, c = 0.55) => Math.sign(x) * (1 - 1 / ((Math.abs(x) * c) / d + 1)) * d;

/** Auto-scroll speed in pt/ms for a finger `depth` points from the edge that has stayed in the zone `heldMs`. */
export function edgeSpeed(depth, heldMs) {
  if (depth > EDGE_ZONE) return 0;
  const i = EDGE_CURVE.findIndex(([t]) => t > heldMs);
  if (i === -1) return EDGE_CURVE.at(-1)[1];
  const [t0, v0] = EDGE_CURVE[i - 1];
  const [t1, v1] = EDGE_CURVE[i];
  return v0 + ((v1 - v0) * (heldMs - t0)) / (t1 - t0);
}
