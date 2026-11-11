export function stopsBrowserPan(s: { lifted: boolean; dragAction: string | null; doubleTapSecond: boolean; editing: boolean; inEditor: boolean }): boolean {
  return s.lifted || (s.dragAction !== null && s.dragAction !== "pan") || s.doubleTapSecond || (s.editing && s.inEditor);
}

// "taken": the browser owns the touch, as it can't be cancelled or has scrolled since the sequence's first finger.
export function pinchKind(s: { cancelable: boolean; pannedThisTouch: boolean }): "own" | "taken" {
  return s.cancelable && !s.pannedThisTouch ? "own" : "taken";
}

export function followVelocity(prev: { x: number; y: number }, dx: number, dy: number, dt: number): { x: number; y: number } {
  const t = Math.max(1, dt);
  return { x: 0.7 * (dx / t) + 0.3 * prev.x, y: 0.7 * (dy / t) + 0.3 * prev.y };
}

export function coastFromLift(v: { x: number; y: number }, sinceLastMove: number): { x: number; y: number } {
  return sinceLastMove <= 50 ? v : { x: 0, y: 0 };
}
