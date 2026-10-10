// A clock for timeouts, in ms: it never goes back, as a wall clock set back does, and it counts sleep, which
// performance.now() may not. Each reading moves on by the larger of the two clocks' steps since the last.
export function steadyClock(wall = () => Date.now(), mono = () => performance.now()) {
  let [w0, m0] = [wall(), mono()];
  let t = m0;
  return () => {
    const [w, m] = [wall(), mono()];
    t += Math.max(m - m0, w - w0, 0);
    [w0, m0] = [w, m];
    return t;
  };
}
