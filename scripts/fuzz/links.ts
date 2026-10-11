// Each device's network over virtual time: a seeded state machine per device, plus outages of the server or the relay
// alone. What a state does to messages is the hub's; this decides which state a device is in, and for how long.

/** ms, one way, on top of which the server and the relay add their own. */
const LATENCY = {
  lan: [1, 5],
  good: [20, 60],
  degraded: [150, 600],
};

/** Per profile: the share of time in each state, how long a stay lasts (s), and how often partial outages come. */
export const PROFILES = {
  lan: { base: "lan", states: { good: 1 }, outage: 0 },
  office: { base: "good", states: { good: 0.92, degraded: 0.05, handover: 0.03 }, outage: 0.01 },
  train: { base: "good", states: { good: 0.4, degraded: 0.3, tunnel: 0.15, handover: 0.1, flapping: 0.05 }, outage: 0.02 },
  tether: { base: "good", states: { good: 0.55, degraded: 0.2, dead: 0.15, handover: 0.1 }, outage: 0.01 },
  "blocked-ws": { base: "good", states: { good: 0.95, degraded: 0.05 }, outage: 0, relayBlocked: true },
};

const STAY = { good: [5, 60], degraded: [5, 40], tunnel: [5, 90], dead: [10, 60], flapping: [2, 10] };

export class Link {
  /** `notify(kind)` tells the device of an "online", "offline" or "change" event when its OS would. */
  constructor(rng, profile, { onChange = () => {} } = {}) {
    this.rng = rng;
    this.profileName = profile === "mixed" ? rng.pick(["lan", "office", "train", "tether"]) : profile;
    this.profile = PROFILES[this.profileName];
    if (!this.profile) throw new Error(`unknown profile ${profile}`);
    this.state = this.profile.base === "lan" ? "lan" : "good";
    this.until = 0;
    /** Whether the device was told it is offline, so that requests fail at once. */
    this.toldOffline = false;
    /** Whether open connections survive the state: a short tunnel keeps them, TCP retransmitting. */
    this.keeps = true;
    this.blocked = { server: false, relay: !!this.profile.relayBlocked };
    this.onChange = onChange;
  }

  get up() {
    return this.state === "lan" || this.state === "good" || this.state === "degraded";
  }

  /** One-way ms to `dest` ("server", "relay" or "peer") for a message sent now, or null when it is lost; `when` gives
   * the earliest delivery for one held back, as in a tunnel that keeps connections. */
  latency(dest, connection = true) {
    if (dest !== "peer" && this.blocked[dest]) return null;
    const r = this.rng;
    const extra = dest === "server" ? 15 : dest === "relay" ? 5 : 0;
    switch (this.state) {
      case "lan":
      case "good": {
        const [lo, hi] = LATENCY[this.state === "lan" ? "lan" : "good"];
        return r.between(lo, hi) + extra;
      }
      case "degraded": {
        const [lo, hi] = LATENCY.degraded;
        // heavy-tailed, and a lost packet costs a retransmission on a connection, or the message on a channel
        let ms = lo + (hi - lo) * Math.min(20, 1 / Math.max(0.05, r.float()) - 1) / 4;
        if (r.chance(0.06)) {
          if (!connection) return null;
          ms += r.between(1000, 3000);
        }
        return ms + extra;
      }
      default:
        return null;
    }
  }

  /** Moves to the next state at `now` (ms); returns what changed: {from, to, until, kills, tell}. */
  step(now) {
    const p = this.profile;
    const from = this.state;
    const weights = { ...p.states };
    // leaving a bad state goes back to good
    const to = from !== "good" && from !== "lan" ? (p.base === "lan" ? "lan" : "good") : this.rng.weighted(weights);
    const [lo, hi] = STAY[to === "lan" ? "good" : to] ?? [0, 0];
    const stay = to === "handover" ? 0 : this.rng.between(lo, hi) * 1000;
    this.state = to === "handover" ? from : to;
    this.until = now + stay;
    let kills = false, tell = null;
    if (to === "handover") {
      kills = true;
      tell = this.rng.chance(0.7) ? "change" : null;
    } else if (to === "tunnel") {
      this.keeps = stay < 40_000 && this.rng.chance(0.6);
      kills = !this.keeps;
      this.toldOffline = this.rng.chance(0.5);
      tell = this.toldOffline ? "offline" : null;
    } else if (to === "dead") {
      kills = true;
    } else if (from === "tunnel") {
      tell = this.toldOffline ? "online" : this.rng.chance(0.3) ? "change" : null;
      this.toldOffline = false;
    }
    return { from, to, until: this.until, kills, tell };
  }
}
