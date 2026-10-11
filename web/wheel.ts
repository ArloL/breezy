export const LINE = 16;
const PAGE = 800;
// A pinch's deltas are a few points each; a mouse wheel's notch can be 100. One notch zooms about 1.25×, as ⌘+ does.
const ZOOM_PER_PT = 0.01;
const MAX_ZOOM_DELTA = 25;

/** What a wheel event does: a pinch (⌃, as browsers send it) or ⌘-scroll zooms about the pointer; any other scroll pans. */
export function wheelAction({ deltaX, deltaY, deltaMode, ctrlKey, metaKey }) {
  const unit = [1, LINE, PAGE][deltaMode] ?? 1;
  if (ctrlKey || metaKey) {
    const d = Math.max(-MAX_ZOOM_DELTA, Math.min(MAX_ZOOM_DELTA, deltaY * unit));
    return { zoom: Math.exp(-d * ZOOM_PER_PT) };
  }
  return { pan: { x: -deltaX * unit, y: -deltaY * unit } };
}
