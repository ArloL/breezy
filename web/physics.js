/**
 * A coast keeps this fraction of its velocity each millisecond. Freeform's canvas, measured on an iPhone, coasts
 * about 65 ms × the release velocity, much shorter than a UIScrollView list's 0.998.
 */
export const DECEL = 0.985;
const K = Math.log(DECEL);

/** Edge auto-scroll, as measured in Freeform: a narrow zone, starting slowly and speeding up while held. */
export const EDGE_ZONE = 24;
const EDGE_MIN = 0.04; // pt/ms
const EDGE_MAX = 0.6;
const EDGE_RAMP = 0.00064; // pt/ms per ms held: about 40 to 360 pt/s in half a second

export const decay = (v, ms) => v * DECEL ** ms;
export const coastOffset = (v, ms) => (v * (DECEL ** ms - 1)) / K;
export const projection = (v) => -v / K;

/** UIKit's rubber band: how far content moves when pulled `x` past its limit, for a dimension `d`. */
export const rubber = (x, d, c = 0.55) => Math.sign(x) * (1 - 1 / ((Math.abs(x) * c) / d + 1)) * d;

/** Auto-scroll speed in pt/ms for a finger `depth` points from the edge that has stayed in the zone `heldMs`. */
export const edgeSpeed = (depth, heldMs) => (depth > EDGE_ZONE ? 0 : Math.min(EDGE_MAX, EDGE_MIN + EDGE_RAMP * heldMs));
