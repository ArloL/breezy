// One sender's samples of one value, played back a little late so that it moves smoothly, as BreezyKit's Track; see
// the WebRTC design. Times are ms: `at` on the sender's clock, `arrival` and `now` on this device's.
export const WINDOW_MS = 2000;
export const PAUSE_MS = 250;
export const MIN_DELAY_MS = 8;
export const MAX_DELAY_MS = 150;

/** The lower median of the gaps between consecutive `at` up to PAUSE_MS; 0 without any. */
function interval(samples) {
  const gaps = samples.slice(1).map((s, i) => s.at - samples[i].at).filter((g) => g <= PAUSE_MS).sort((a, b) => a - b);
  return gaps.length ? gaps[(gaps.length - 1) >> 1] : 0;
}

export class Track {
  constructor() {
    this.samples = [];
    this.offset = 0;
    this.delay = MIN_DELAY_MS;
  }

  recent(upTo) {
    return this.samples.filter((s) => s.arrival > upTo - WINDOW_MS);
  }

  /** What the sender had at its time `at`, arriving at `arrival`; older than the last, it is dropped. */
  push(at, arrival, value) {
    const last = this.samples.at(-1);
    if (last && at <= last.at) return;
    // after a pause the value sat still until just before this sample, rather than drifting all the way
    if (last && arrival - last.arrival > PAUSE_MS) {
      const hold = at - interval(this.recent(last.arrival));
      if (hold > last.at && hold < at) this.samples.push({ at: hold, arrival: arrival - (at - hold), value: last.value });
    }
    this.samples.push({ at, arrival, value });
    const recent = this.recent(arrival);
    this.samples = this.samples.slice(Math.max(0, this.samples.length - recent.length - 2));
    this.offset = Math.min(...recent.map((s) => s.arrival - s.at));
    const late = recent.map((s) => s.arrival - s.at - this.offset).sort((a, b) => a - b);
    const jitter = late[Math.ceil((late.length * 9) / 10) - 1];
    this.delay = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, interval(recent) + jitter));
  }

  /** The value at `now`, played back `delay` late, between the samples either side; never past the last. */
  sample(now) {
    const t = now - this.offset - this.delay;
    const s = this.samples;
    if (t <= s[0].at) return s[0].value;
    for (let i = 1; i < s.length; i++) {
      if (t >= s[i].at) continue;
      const a = s[i - 1], b = s[i], k = (t - a.at) / (b.at - a.at);
      return a.value.map((v, j) => v + (b.value[j] - v) * k);
    }
    return s.at(-1).value;
  }

  /** Whether playback has yet to reach the last sample. */
  playing(now) {
    return this.samples.length > 0 && now - this.offset - this.delay < this.samples.at(-1).at;
  }
}
