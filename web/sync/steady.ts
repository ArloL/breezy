// A clock for timeouts, in ms: it never goes back, as a wall clock set back does, and it counts sleep, which
// performance.now() may not. It follows the monotonic clock, and the wall clock only when that moved on over a second
// more, as across sleep: taking the larger step every time would gain the wall clock's coarse ticks on each reading.
const SLEEP_MS = 1000;

export function steadyClock(wall = () => Date.now(), mono = () => performance.now()) {
  let [w0, m0] = [wall(), mono()];
  let t = m0;
  return () => {
    const [w, m] = [wall(), mono()];
    const [dw, dm] = [w - w0, Math.max(0, m - m0)];
    t += dw - dm > SLEEP_MS ? dw : dm;
    [w0, m0] = [w, m];
    return t;
  };
}
