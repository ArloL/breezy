# Breezy direct WebRTC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remote cursors and drags that keep up with the real ones on two screens side by side: a direct WebRTC data channel beside the relay, sends at display rate over it, and every receiver playing remote positions back each frame through an adaptive buffer.

**Architecture:** A pure `Track` (both languages) buffers one sender's samples and plays them back `interval + jitter` late. `Live` stamps `cursor` and `live` bodies with `at` and `seq`, keeps tracks per peer, and returns sampled values; the web app and the Mac app draw them each frame. A `Direct` (both languages) runs signalling through the relay over a `PeerTransport`: `RTCPeerConnection` on the web, a hidden WKWebView on the Mac. `Live` routes `cursor` and `live` over open channels and falls back to the relay.

**Tech Stack:** Plain ES modules and `node --test` (web), Swift 6 / Swift Testing / AppKit / WebKit (Mac), WebRTC data channels, Cloudflare relay unchanged.

**Spec:** `docs/superpowers/specs/2026-10-09-breezy-webrtc-design.md`. Background: `docs/superpowers/specs/2026-10-09-breezy-multiplayer-design.md`.

## Global Constraints

- The relay (`relay/`) and `sync.php` do not change; nothing is deployed.
- BreezyKit takes Apple frameworks only and never imports WebKit: `PeerTransport` lives in BreezyKit, `WebPeerTransport` in the app target.
- macOS deployment target 15.0.
- STUN `stun:stun.cloudflare.com:3478`; no TURN.
- Data channel: `negotiated: true, id: 0, ordered: false, maxRetransmits: 0`.
- Send gate: 8 ms while every peer's channel is open, 50 ms otherwise. Holder heartbeat every 5 s, always to the relay.
- Track: window 2000 ms, pause 250 ms, delay = interval + jitter clamped to 8–150 ms; jitter is the 90th percentile, at index `ceil(n * 9 / 10) - 1` of the sorted list; interval is the lower median, index `(n - 1) >> 1`, of `at` gaps ≤ 250 ms, 0 when there are none.
- Times inside `Track` are ms. `at` is the sender's monotonic clock: `performance.now()` on the web, `ProcessInfo.processInfo.systemUptime * 1000` on the Mac.
- Connection problems are never shown to the user beyond one passive status line: "Direct with N of M people" ("person" when M is 1).
- Code matches its surroundings: two-space indent, short doc comments only where the code does not say it, no new dependencies.
- Commit messages follow the repo's style (one plain sentence saying what changed, e.g. "Play others' cursors back through a jitter buffer") and carry no claude.ai session links.
- Tests: `node --test web/test/*.test.js` and `swift test --package-path BreezyKit` must pass after every task.

## Review Focus

- Older clients in the same space send `cursor` and `live` without `at` or `seq`: their bodies are always accepted and drawn at their arrival time (test in Tasks 3 and 4).
- A cursor that hides or moves to another board mid-glide jumps; it never glides across boards (test in Tasks 3 and 4).
- An offer reaching a connection that is itself offering to the sender (simultaneous reconnects) is ignored, with no second peer connection (test in Tasks 8 and 11).
- A peer connection that fails and recovers through `restartIce()` reports `open` again even though the data channel never closed (test in Task 9).
- A body that arrives over a channel but is neither `cursor` nor `live` (a forged `pushed`, `offer` or `presence`) is ignored (test in Tasks 10 and 12).

---

## File structure

| File | Responsibility |
|---|---|
| `web/sync/track.js`, `BreezyKit/Sources/BreezyKit/Track.swift` | Adaptive playback buffer for one value |
| `BreezyKit/Tests/Fixtures/track.json` | Shared Track vectors |
| `web/sync/live.js`, `BreezyKit/Sources/BreezyKit/Live.swift` | Stamping, tracks, sampled queries, routing, roster |
| `web/sync/direct.js`, `BreezyKit/Sources/BreezyKit/Direct.swift` | Signalling state machine over a `PeerTransport` |
| `web/sync/rtc.js` | `PeerTransport` over `RTCPeerConnection` |
| `Breezy/Live/peer.html`, `Breezy/Live/WebPeerTransport.swift` | `PeerTransport` over a hidden WKWebView |
| `web/library.js`, `web/style.css` | Web frame loop, status line |
| `Breezy/Canvas/CanvasView.swift`, `Breezy/Canvas/PresenceView.swift`, `Breezy/Library/Library.swift` | Mac frame loop, status line, transport wiring |
| `web/test/helpers/fake-transport.js`, `BreezyKit/Tests/BreezyKitTests/LiveFakes.swift` | Fake transports |
| `scripts/direct-e2e.mjs` | Two headless Chromiums against local relay and server |

Work happens on branch `webrtc` (it holds the spec). Each phase ends with a PR; ask the user before pushing.

---

# Phase 1: playback buffer and drawing every frame

### Task 1: Track in JS with the shared fixture

**Files:**
- Create: `BreezyKit/Tests/Fixtures/track.json`
- Create: `web/sync/track.js`
- Test: `web/test/track.test.js`

**Interfaces:**
- Produces: `class Track { push(at, arrival, value: number[]); sample(now): number[]; playing(now): boolean; delay: number; offset: number }`, exported constants `WINDOW_MS = 2000`, `PAUSE_MS = 250`, `MIN_DELAY_MS = 8`, `MAX_DELAY_MS = 150`.

- [ ] **Step 1: Write the fixture**

`BreezyKit/Tests/Fixtures/track.json` (each sample is `[at, arrival, value]`, each query `[now, value]`, each playing `[now, bool]`):

```json
{
  "cases": [
    {
      "name": "steady",
      "samples": [[0, 1000, [0, 0]], [50, 1050, [10, -10]], [100, 1100, [20, -20]]],
      "delay": 50,
      "queries": [[1000, [0, 0]], [1100, [10, -10]], [1125, [15, -15]], [1200, [20, -20]]],
      "playing": [[1149, true], [1150, false]]
    },
    {
      "name": "jitter",
      "samples": [[0, 1000, [0]], [10, 1010, [1]], [20, 1020, [2]], [30, 1035, [3]], [40, 1040, [4]], [50, 1050, [5]],
                  [60, 1060, [6]], [70, 1075, [7]], [80, 1080, [8]], [90, 1090, [9]], [100, 1100, [10]]],
      "delay": 15,
      "queries": [[1000, [0]], [1100, [8.5]], [1115, [10]]],
      "playing": [[1114, true], [1115, false]]
    },
    {
      "name": "pause",
      "samples": [[0, 1000, [0]], [50, 1050, [10]], [2050, 3050, [30]]],
      "delay": 50,
      "queries": [[3050, [10]], [3075, [20]], [3100, [30]]]
    },
    {
      "name": "single",
      "samples": [[0, 1000, [5]]],
      "delay": 8,
      "queries": [[1000, [5]]],
      "playing": [[1007, true], [1008, false]]
    },
    {
      "name": "clamped",
      "samples": [[0, 1000, [0]], [10, 1300, [10]]],
      "delay": 150,
      "queries": [[1100, [0]], [1155, [5]], [1160, [10]]]
    },
    {
      "name": "stale",
      "samples": [[50, 1050, [10]], [0, 1060, [0]]],
      "delay": 8,
      "queries": [[1100, [10]]]
    }
  ]
}
```

- [ ] **Step 2: Write the failing test**

`web/test/track.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { Track } from "../sync/track.js";
import { fixture } from "./helpers/fixture.js";

for (const c of fixture("track.json").cases) {
  test(`track: ${c.name}`, () => {
    const t = new Track();
    for (const [at, arrival, value] of c.samples) t.push(at, arrival, value);
    assert.equal(t.delay, c.delay);
    for (const [now, value] of c.queries) assert.deepEqual(t.sample(now), value, `at ${now}`);
    for (const [now, playing] of c.playing ?? []) assert.equal(t.playing(now), playing, `playing at ${now}`);
  });
}
```

- [ ] **Step 3: Run it to see it fail**

Run: `node --test web/test/track.test.js`
Expected: FAIL, cannot find module `../sync/track.js`.

- [ ] **Step 4: Implement**

`web/sync/track.js`:

```js
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
```

- [ ] **Step 5: Run the tests**

Run: `node --test web/test/track.test.js`
Expected: 6 tests pass.

- [ ] **Step 6: Commit**

```bash
git add BreezyKit/Tests/Fixtures/track.json web/sync/track.js web/test/track.test.js
git commit --message "Add a track that plays one sender's samples back through an adaptive buffer on the web"
```

### Task 2: Track in Swift

**Files:**
- Create: `BreezyKit/Sources/BreezyKit/Track.swift`
- Test: `BreezyKit/Tests/BreezyKitTests/TrackTests.swift`

**Interfaces:**
- Consumes: `BreezyKit/Tests/Fixtures/track.json` from Task 1; `fixture(_:)` from `Fixtures.swift`.
- Produces: `public struct Track: Equatable, Sendable { public init(); public mutating func push(at: Double, arrival: Double, value: [Double]); public func sample(_ now: Double) -> [Double]; public func playing(_ now: Double) -> Bool; public private(set) var delay: Double; public private(set) var offset: Double }`.

- [ ] **Step 1: Write the failing test**

`BreezyKit/Tests/BreezyKitTests/TrackTests.swift`:

```swift
import Foundation
import Testing
@testable import BreezyKit

@Test func tracksPlayBackAsTheWebDoes() throws {
  let cases = try #require(try JSONSerialization.jsonObject(with: fixture("track.json")) as? [String: Any])["cases"] as! [[String: Any]]
  for c in cases {
    let name = c["name"] as! String
    var t = Track()
    for s in c["samples"] as! [[Any]] {
      t.push(at: (s[0] as! NSNumber).doubleValue, arrival: (s[1] as! NSNumber).doubleValue, value: (s[2] as! [NSNumber]).map(\.doubleValue))
    }
    #expect(t.delay == (c["delay"] as! NSNumber).doubleValue, "\(name)")
    for q in c["queries"] as! [[Any]] {
      #expect(t.sample((q[0] as! NSNumber).doubleValue) == (q[1] as! [NSNumber]).map(\.doubleValue), "\(name) at \(q[0])")
    }
    for q in c["playing"] as? [[Any]] ?? [] {
      #expect(t.playing((q[0] as! NSNumber).doubleValue) == (q[1] as! Bool), "\(name) playing at \(q[0])")
    }
  }
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `swift test --package-path BreezyKit --filter tracksPlayBackAsTheWebDoes`
Expected: build error, `cannot find 'Track' in scope`.

- [ ] **Step 3: Implement**

`BreezyKit/Sources/BreezyKit/Track.swift`:

```swift
import Foundation

/// One sender's samples of one value, played back a little late so that it moves smoothly; see the WebRTC design.
/// Times are ms: `at` on the sender's clock, `arrival` and `now` on this device's.
public struct Track: Equatable, Sendable {
  public static let window = 2000.0
  public static let pause = 250.0
  public static let minDelay = 8.0
  public static let maxDelay = 150.0

  struct Sample: Equatable, Sendable {
    var at: Double
    var arrival: Double
    var value: [Double]
  }

  var samples: [Sample] = []
  public private(set) var offset = 0.0
  public private(set) var delay = Track.minDelay

  public init() {}

  private func recent(_ upTo: Double) -> [Sample] { samples.filter { $0.arrival > upTo - Self.window } }

  /// The lower median of the gaps between consecutive `at` up to `pause`; 0 without any.
  private static func interval(_ s: [Sample]) -> Double {
    let gaps = zip(s, s.dropFirst()).map { $1.at - $0.at }.filter { $0 <= pause }.sorted()
    return gaps.isEmpty ? 0 : gaps[(gaps.count - 1) / 2]
  }

  /// What the sender had at its time `at`, arriving at `arrival`; older than the last, it is dropped.
  public mutating func push(at: Double, arrival: Double, value: [Double]) {
    if let last = samples.last {
      guard at > last.at else { return }
      // after a pause the value sat still until just before this sample, rather than drifting all the way
      if arrival - last.arrival > Self.pause {
        let hold = at - Self.interval(recent(last.arrival))
        if hold > last.at && hold < at { samples.append(Sample(at: hold, arrival: arrival - (at - hold), value: last.value)) }
      }
    }
    samples.append(Sample(at: at, arrival: arrival, value: value))
    let r = recent(arrival)
    samples.removeFirst(max(0, samples.count - r.count - 2))
    offset = r.map { $0.arrival - $0.at }.min()!
    let late = r.map { $0.arrival - $0.at - offset }.sorted()
    let jitter = late[(late.count * 9 + 9) / 10 - 1]
    delay = min(Self.maxDelay, max(Self.minDelay, Self.interval(r) + jitter))
  }

  /// The value at `now`, played back `delay` late, between the samples either side; never past the last.
  public func sample(_ now: Double) -> [Double] {
    guard let first = samples.first, let last = samples.last else { return [] }
    let t = now - offset - delay
    if t <= first.at { return first.value }
    for i in 1..<samples.count where t < samples[i].at {
      let a = samples[i - 1], b = samples[i], k = (t - a.at) / (b.at - a.at)
      return zip(a.value, b.value).map { $0 + ($1 - $0) * k }
    }
    return last.value
  }

  /// Whether playback has yet to reach the last sample.
  public func playing(_ now: Double) -> Bool { samples.last.map { now - offset - delay < $0.at } ?? false }
}
```

`(n * 9 + 9) / 10` is `ceil(n * 9 / 10)` in integers.

- [ ] **Step 4: Run the tests**

Run: `swift test --package-path BreezyKit --filter tracksPlayBackAsTheWebDoes`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add BreezyKit/Sources/BreezyKit/Track.swift BreezyKit/Tests/BreezyKitTests/TrackTests.swift
git commit --message "Add the playback track to BreezyKit, held to the web's vectors"
```

### Task 3: Stamp, sequence and play back cursors and live edits on the web

**Files:**
- Modify: `web/sync/live.js`
- Test: `web/test/live.test.js`

**Interfaces:**
- Consumes: `Track` from Task 1.
- Produces: `new Live({ ..., clock = () => performance.now() })`; `live.animating(): boolean`; `cursors(board)` and `overlay(board)` now return values sampled at `clock()`; outgoing `cursor` and `live` bodies carry `at` (ms, `clock()`) and `seq` (integer, from 1, one counter per `Live`); internal `sendFast(body)`, used by Task 10.

- [ ] **Step 1: Pass the test clock to Live**

In `web/test/live.test.js`, make the `live()` helper pass `clock: clock.now` beside `now: clock.now`:

```js
function live(relay, clock, { name = "Ana", dev = device(), k = keys } = {}) {
  return new Live({ relay: "wss://relay.example/", space: SPACE, keys: k, me: { device: dev, name }, socket: () => relay.connect(), now: clock.now, clock: clock.now, schedule: clock.schedule });
}
```

- [ ] **Step 2: Write the failing tests**

Append to `web/test/live.test.js`:

```js
const opened = async (text) => JSON.parse(new TextDecoder().decode(await keys.openLive(decode(JSON.parse(text).body))));

test("cursors and live edits carry the sender's time and a sequence number", async () => {
  const { relay, clock, a } = await two();
  a.sendCursor("B1", 1, 1);
  await relay.run();
  clock.advance(50);
  a.hold(["c1"]);
  a.sendLive("B1", moved, null);
  await relay.run();
  const bodies = await Promise.all(relay.frames.filter((f) => f.text.includes('"body"')).slice(-2).map((f) => opened(f.text)));
  assert.deepEqual(bodies.map((b) => [b.t, b.seq]), [["cursor", 1], ["live", 2]]);
  assert.equal(bodies[1].at - bodies[0].at, 50);
});

test("cursors play back smoothly between updates", async () => {
  const { relay, clock, a, b } = await two();
  for (const x of [0, 10, 20]) {
    a.sendCursor("B1", x, 0);
    await relay.run();
    clock.advance(50);
  }
  // the buffer is one 50 ms interval: 50 ms after the last arrived, playback is halfway between the last two
  clock.advance(-25);
  assert.deepEqual(b.cursors("B1").map((c) => c.x), [15]);
  assert.ok(b.animating());
  clock.advance(100);
  assert.deepEqual(b.cursors("B1").map((c) => c.x), [20]);
  assert.ok(!b.animating());
});

test("a cursor on another board jumps there", async () => {
  const { relay, clock, a, b } = await two();
  for (const x of [0, 10]) {
    a.sendCursor("B1", x, 0);
    await relay.run();
    clock.advance(50);
  }
  a.sendCursor("B2", 500, 500);
  await relay.run();
  assert.deepEqual(b.cursors("B2").map((c) => [c.x, c.y]), [[500, 500]]);
});

test("dragged positions play back; text shows on arrival", async () => {
  const { relay, clock, a, b } = await two();
  a.hold(["c1"]);
  for (const [x, text] of [[0, "a"], [10, "ab"], [20, "abc"]]) {
    a.sendLive("B1", { c1: { pos: [x, 0], text } }, null);
    await relay.run();
    clock.advance(50);
  }
  clock.advance(-25);
  assert.deepEqual(b.overlay("B1").get("c1"), { pos: [15, 0], text: "abc" });
});

test("duplicates and late bodies are dropped; bodies without seq or at are taken", async () => {
  const { relay, clock, a, b } = await two();
  a.sendCursor("B1", 5, 5);
  await relay.run();
  const late = relay.frames.at(-1);
  clock.advance(200);
  a.sendCursor("B1", 9, 9);
  await relay.run();
  // the first cursor again, as an unordered channel may deliver it late
  relay.received(relay.sockets.find((s) => s.id === late.from), late.text);
  await relay.run();
  clock.advance(200);
  assert.deepEqual(b.cursors("B1").map((c) => c.x), [9]);
  // as a client from before this design sends it
  await a.send({ t: "cursor", board: "B1", x: 3, y: 3 });
  await relay.run();
  clock.advance(200);
  assert.deepEqual(b.cursors("B1").map((c) => c.x), [3]);
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `node --test web/test/live.test.js`
Expected: the five new tests FAIL (`seq` undefined, `animating` not a function, cursor x 20 rather than 15).

- [ ] **Step 4: Implement in `web/sync/live.js`**

1. Import: `import { Track } from "./track.js";`
2. Constructor: add `clock = () => performance.now()` to the destructured options and to `Object.assign`; add `this.seq = 0;`.
3. Peer record (in `heard`, the `?? { ... }` default): add `cursorTrack: null, motion: new Map(), seqs: {}`. `motion` is keyed `` `${id} ${field}` ``.
4. Add near the top:

```js
/** The live fields that move, played back through a track. */
const MOVING = ["pos", "size", "w"];
const numbers = (v) => (Number.isFinite(v) ? [v] : Array.isArray(v) && v.every(Number.isFinite) ? v : null);
```

5. In `heard(from, b)`, after `p.heard = now;`, add:

```js
    const arrival = this.clock();
    const at = Number.isFinite(b?.at) ? b.at : arrival;
    // a body older than one already taken from this connection, over either pipe, is dropped
    if ((b?.t === "cursor" || b?.t === "live") && Number.isInteger(b.seq)) {
      if (b.seq <= (p.seqs[b.t] ?? 0)) return;
      p.seqs[b.t] = b.seq;
    }
```

6. Replace the `cursor` case with:

```js
      case "cursor": {
        const c = pointOf(b);
        if (!c || c.board !== p.cursor?.board) p.cursorTrack = null;
        if (c) (p.cursorTrack ??= new Track()).push(at, arrival, [c.x, c.y]);
        [p.cursor, p.cursorAt] = [c, now];
        break;
      }
```

7. Replace the `live` case with:

```js
      case "live": {
        const board = typeof b.board === "string" ? b.board : null;
        if (board !== p.overlayBoard) p.motion.clear();
        p.overlayBoard = board;
        for (const [id, f] of Object.entries(b.items ?? {})) {
          if (!f || typeof f !== "object") continue;
          p.overlay.set(id, { ...p.overlay.get(id), ...pick(f) });
          for (const k of MOVING) {
            const v = numbers(f[k]);
            if (!v) continue;
            const key = `${id} ${k}`;
            if (!p.motion.has(key)) p.motion.set(key, new Track());
            p.motion.get(key).push(at, arrival, v);
          }
        }
        p.caret = caretOf(b.caret);
        break;
      }
```

8. In `dropReleased()`, after the loop that deletes overlay ids, drop their tracks:

```js
      for (const key of [...p.motion.keys()]) if (!p.overlay.has(key.slice(0, key.indexOf(" ")))) p.motion.delete(key);
```

9. Stamp outgoing cursors and live edits. Add:

```js
  /** A cursor or live body, stamped with this device's time and the next sequence number. */
  sendFast(body) {
    return this.send({ ...body, at: this.clock(), seq: ++this.seq });
  }
```

In `sendCursor` change the gate's `this.send({ t: "cursor", ... })` to `this.sendFast({ t: "cursor", ... })`; in `sendLive` change `this.lastLive && this.send(this.lastLive)` to `this.lastLive && this.sendFast(this.lastLive)`; in `tick()` change the heartbeat line to:

```js
      (this.lastLive ? this.sendFast(this.lastLive) : Promise.resolve(false)).then((ok) => ok || this.sendFast(minimal));
```

10. Sample on the way out. Replace `overlay(board)` and `cursors(board)`, and add `animating()`:

```js
  /** Others' live fields on `board` as they play back now, leaving out what this device holds: its own gesture draws
   * from its model. */
  overlay(board) {
    const now = this.clock();
    const out = new Map();
    for (const p of this.peers.values()) {
      if (p.overlayBoard !== board) continue;
      for (const [id, f] of p.overlay) {
        if (this.mine.has(id)) continue;
        const shown = { ...f };
        for (const k of MOVING) {
          const t = p.motion.get(`${id} ${k}`);
          if (t && k in f) shown[k] = k === "w" ? t.sample(now)[0] : t.sample(now);
        }
        out.set(id, shown);
      }
    }
    return out;
  }

  cursors(board) {
    const now = this.clock();
    return [...this.peers].filter(([, p]) => p.person && p.cursor?.board === board).map(([key, p]) => {
      const [x, y] = p.cursorTrack?.sample(now) ?? [p.cursor.x, p.cursor.y];
      return { key, person: p.person, x, y };
    });
  }

  /** Whether any cursor or live edit is still playing back, so that the board draws again next frame. */
  animating() {
    const now = this.clock();
    for (const p of this.peers.values()) {
      if (p.cursor && p.cursorTrack?.playing(now)) return true;
      for (const t of p.motion.values()) if (t.playing(now)) return true;
    }
    return false;
  }
```

- [ ] **Step 5: Run all web tests**

Run: `node --test web/test/*.test.js`
Expected: the new tests pass. An existing test that reads `cursors()` or `overlay()` right after several sends now sees the buffered value. In "cursors go at most twenty times a second", add `clock.advance(200);` before `assert.deepEqual(b.cursors("B1").map((c) => c.x), [3]);`. Fix any other such test the same way: advance the clock 200 ms (past the largest possible delay of 150 ms) before reading. Change nothing else in old tests.

- [ ] **Step 6: Commit**

```bash
git add web/sync/live.js web/test/live.test.js
git commit --message "Stamp cursors and live edits with the sender's time and a sequence number, and play them back through tracks on the web"
```

### Task 4: The same in Live.swift

**Files:**
- Modify: `BreezyKit/Sources/BreezyKit/Live.swift`
- Test: `BreezyKit/Tests/BreezyKitTests/LiveTests.swift`, `BreezyKit/Tests/BreezyKitTests/LiveFakes.swift`

**Interfaces:**
- Consumes: `Track` from Task 2.
- Produces: `Live.init(..., uptime: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime * 1000 }, ...)` (after `now:`); `public var animating: Bool`; `cursors(on:)` and `overlay(on:)` sampled at `uptime()`; private `sendFast(_:)`, used by Task 12.

- [ ] **Step 1: Pass the test clock**

In `LiveTests.swift`'s `live(...)` helper add `uptime: { clock.now.timeIntervalSince1970 * 1000 },` after `now: { clock.now },`.

- [ ] **Step 2: Write the failing tests**

Append to `LiveTests.swift`:

```swift
@MainActor private func bodies(_ relay: FakeRelay, last n: Int) throws -> [[String: JSONValue]] {
  try relay.frames.filter { $0.text.contains("\"body\"") }.suffix(n).map { f in
    let m = try JSONDecoder().decode([String: JSONValue].self, from: Data(f.text.utf8))
    return try JSONDecoder().decode([String: JSONValue].self, from: keys().openLive(Base64URL.decode(m["body"]!.string!)!))
  }
}

@MainActor @Test func cursorsAndLiveEditsCarryTheSendersTimeAndASequenceNumber() throws {
  let (relay, clock, a, _) = two()
  a.sendCursor(board: "B1", x: 1, y: 1)
  relay.run()
  clock.advance(0.05)
  a.hold(["c1"])
  a.sendLive(board: "B1", items: moved, caret: nil)
  relay.run()
  let b = try bodies(relay, last: 2)
  #expect(b.map { $0["t"]?.string } == ["cursor", "live"])
  #expect(b.map { $0["seq"]?.number } == [1, 2])
  #expect(abs(b[1]["at"]!.number! - b[0]["at"]!.number! - 50) < 0.001)
}

@MainActor @Test func cursorsPlayBackSmoothlyBetweenUpdates() {
  let (relay, clock, a, b) = two()
  for x in [0.0, 10, 20] {
    a.sendCursor(board: "B1", x: x, y: 0)
    relay.run()
    clock.advance(0.05)
  }
  clock.advance(-0.025)
  #expect(b.cursors(on: "B1").map { $0.cursor.x } == [15])
  #expect(b.animating)
  clock.advance(0.1)
  #expect(b.cursors(on: "B1").map { $0.cursor.x } == [20])
  #expect(!b.animating)
}

@MainActor @Test func aCursorOnAnotherBoardJumpsThere() {
  let (relay, clock, a, b) = two()
  for x in [0.0, 10] {
    a.sendCursor(board: "B1", x: x, y: 0)
    relay.run()
    clock.advance(0.05)
  }
  a.sendCursor(board: "B2", x: 500, y: 500)
  relay.run()
  #expect(b.cursors(on: "B2").map { [$0.cursor.x, $0.cursor.y] } == [[500, 500]])
}

@MainActor @Test func draggedPositionsPlayBackAndTextShowsOnArrival() {
  let (relay, clock, a, b) = two()
  a.hold(["c1"])
  for (x, text) in [(0.0, "a"), (10, "ab"), (20, "abc")] {
    a.sendLive(board: "B1", items: ["c1": ["pos": .array([.number(x), .number(0)]), "text": .string(text)]], caret: nil)
    relay.run()
    clock.advance(0.05)
  }
  clock.advance(-0.025)
  #expect(b.overlay(on: "B1")["c1"] == ["pos": .array([.number(15), .number(0)]), "text": .string("abc")])
}

@MainActor @Test func duplicatesAndLateBodiesAreDroppedAndUnstampedOnesTaken() {
  let (relay, clock, a, b) = two()
  a.sendCursor(board: "B1", x: 5, y: 5)
  relay.run()
  let late = relay.frames.last!
  clock.advance(0.2)
  a.sendCursor(board: "B1", x: 9, y: 9)
  relay.run()
  relay.resend(late)
  relay.run()
  clock.advance(0.2)
  #expect(b.cursors(on: "B1").map { $0.cursor.x } == [9])
}
```

Unstamped bodies from older clients: Swift's `send` is private, so cover them on the web side only (Task 3 does). The Swift code path is the same `b["at"]?.number ?? arrival` and `fresh` guard.

Add to `FakeRelay` in `LiveFakes.swift`:

```swift
  /// Hands everyone else a frame `from` sent before, again.
  func resend(_ f: (from: String, text: String)) {
    guard let s = sockets.first(where: { $0.id == f.from }) else { return }
    received(s, f.text)
  }
```

- [ ] **Step 3: Run them to see them fail**

Run: `swift test --package-path BreezyKit --filter LiveTests`
Expected: build error on `uptime:`, then failures.

- [ ] **Step 4: Implement in `Live.swift`**

1. `Peer`: add
```swift
  /// The last `seq` taken of each kind of body.
  var seqs: [String: Int] = [:]
  var cursorTrack: Track?
  /// Tracks of the overlay's moving fields, keyed "id field".
  var motion: [String: Track] = [:]
```
2. `Live`: add `static let moving = ["pos", "size", "w"]`, `private let uptime: () -> Double`, `private var seq = 0`; add the `uptime` init parameter after `now` and assign it.
3. Add:

```swift
  private static func numbers(_ v: JSONValue?) -> [Double]? {
    if let n = v?.number, n.isFinite { return [n] }
    guard let a = v?.array else { return nil }
    let ns = a.compactMap(\.number)
    return ns.count == a.count && ns.allSatisfy(\.isFinite) ? ns : nil
  }

  /// Whether `b` is newer than the last body of its kind from this peer, over either pipe; one without `seq` is.
  private static func fresh(_ p: inout Peer, _ b: [String: JSONValue]) -> Bool {
    guard let t = b["t"]?.string, let n = b["seq"]?.number else { return true }
    guard Int(n) > p.seqs[t] ?? 0 else { return false }
    p.seqs[t] = Int(n)
    return true
  }
```

4. In `heard`, after `p.heard = t`:

```swift
    let arrival = uptime()
    let at = b["at"]?.number ?? arrival
    guard !["cursor", "live"].contains(b["t"]?.string) || Self.fresh(&p, b) else {
      peers[from] = p
      return
    }
```

Replace the `cursor` case:

```swift
    case "cursor":
      let c = Self.cursor(.object(b))
      if c == nil || c?.board != p.cursor?.board { p.cursorTrack = nil }
      if let c {
        if p.cursorTrack == nil { p.cursorTrack = Track() }
        p.cursorTrack!.push(at: at, arrival: arrival, value: [c.x, c.y])
      }
      p.cursor = c
      p.cursorAt = t
```

Replace the `live` case:

```swift
    case "live":
      let board = b["board"]?.string
      if board != p.overlayBoard { p.motion = [:] }
      p.overlayBoard = board
      for (id, f) in b["items"]?.object ?? [:] {
        guard let f = f.object else { continue }
        p.overlay[id, default: [:]].merge(f.filter { Records.liveFieldNames.contains($0.key) || $0.key == "kind" }) { $1 }
        for k in Self.moving {
          guard let v = Self.numbers(f[k]) else { continue }
          p.motion["\(id) \(k)", default: Track()].push(at: at, arrival: arrival, value: v)
        }
      }
      p.caret = Self.caret(b["caret"])
```

5. `dropReleased()`: after `p.overlay = p.overlay.filter { held.contains($0.key) }` add
```swift
      p.motion = p.motion.filter { p.overlay[String($0.key.prefix { $0 != " " })] != nil }
```
6. Stamp. Add
```swift
  /// A cursor or live body, stamped with this device's time and the next sequence number.
  @discardableResult private func sendFast(_ body: [String: JSONValue]) -> Bool {
    var b = body
    seq += 1
    b["at"] = .number(uptime())
    b["seq"] = .number(Double(seq))
    return send(b)
  }
```
and use `sendFast` in `flushCursor`, `flushLive`, and both heartbeat sends in `tick()`.

7. Sample on the way out:

```swift
  /// Others' live fields on `board` as they play back now, leaving out what this device holds: its own gesture draws
  /// from its model.
  public func overlay(on board: String) -> [String: LiveFields] {
    let t = uptime()
    var out: [String: LiveFields] = [:]
    for p in peers.values where p.overlayBoard == board {
      for (id, f) in p.overlay where !mine.contains(id) {
        var shown = f
        for k in Self.moving where f[k] != nil {
          guard let v = p.motion["\(id) \(k)"]?.sample(t) else { continue }
          shown[k] = k == "w" ? .number(v[0]) : .array(v.map(JSONValue.number))
        }
        out[id] = shown
      }
    }
    return out
  }

  public func cursors(on board: String) -> [(key: String, person: Person, cursor: Cursor)] {
    let t = uptime()
    return peers.compactMap { k, p in
      guard let person = p.person, let c = p.cursor, c.board == board else { return nil }
      let v = p.cursorTrack?.sample(t) ?? [c.x, c.y]
      return (k, person, Cursor(board: board, x: v[0], y: v[1]))
    }.sorted { $0.key < $1.key }
  }

  /// Whether any cursor or live edit is still playing back, so that the board draws again next frame.
  public var animating: Bool {
    let t = uptime()
    return peers.values.contains { p in (p.cursor != nil && p.cursorTrack?.playing(t) == true) || p.motion.values.contains { $0.playing(t) } }
  }
```

- [ ] **Step 5: Run all BreezyKit tests**

Run: `swift test --package-path BreezyKit`
Expected: new tests pass. In `cursorsGoAtMostTwentyTimesASecond` add `clock.advance(0.2)` before the expectation of `[3]`; fix any other test that reads `cursors(on:)` or `overlay(on:)` right after several sends the same way, and nothing else.

- [ ] **Step 6: Commit**

```bash
git add BreezyKit/Sources/BreezyKit/Live.swift BreezyKit/Tests/BreezyKitTests/LiveTests.swift BreezyKit/Tests/BreezyKitTests/LiveFakes.swift
git commit --message "Stamp cursors and live edits and play them back through tracks in BreezyKit"
```

### Task 5: Draw others every frame on the web

**Files:**
- Modify: `web/library.js` (`liveChanged`, new `animate`)
- Modify: `web/style.css:249` and `web/style.css:290`

**Interfaces:**
- Consumes: `live.animating()` from Task 3.

- [ ] **Step 1: Add the frame loop**

In `web/library.js`, add after `showPresence()`:

```js
  /** Others' cursors and live edits, each frame while they still play back. */
  animate() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (!this.live || !this.id) return;
      this.showPresence();
      if (this.live.animating()) this.animate();
    });
  }
```

and in `liveChanged(g)`, after `if (g === this.group) this.showPresence();` add `if (g === this.group && g.live?.animating()) this.animate();`.

`showPresence()` invalidates the view, whose render calls `presence.place()` and draws `view.shown()`, which samples the overlay at the current time.

- [ ] **Step 2: Drop the cursor's CSS glide**

`web/style.css:290` becomes `.presence .cursor { position: absolute; left: 0; top: 0; }`; remove `.presence .cursor` from the reduced-motion list on line 249.

- [ ] **Step 3: Run the web tests**

Run: `node --test web/test/*.test.js`
Expected: PASS.

- [ ] **Step 4: Check by hand**

Run `server/dev.sh`, `npm --prefix relay run dev` and `npx --yes live-server@1.2.2 web --port=58565 --no-browser`. In Safari and in a second Safari private window, create a space on `http://127.0.0.1:58566/sync.php`, join it from the other, open one board in both. Move the pointer in one: the other's cursor follows without stepping; pan the board while the other moves: the cursor stays put on the board rather than trailing. Drag a card: it moves smoothly on the other side.

- [ ] **Step 5: Commit**

```bash
git add web/library.js web/style.css
git commit --message "Draw others' cursors and live edits every frame on the web, rather than gliding a fixed 60 ms"
```

### Task 6: Draw others every frame on the Mac

**Files:**
- Modify: `Breezy/Canvas/CanvasView.swift` (presence properties near line 65, `presenceChanged` near line 316)
- Modify: `Breezy/Canvas/PresenceView.swift` (`show`)
- Modify: `Breezy/Library/Library.swift` (`wire`, `liveChanged`)

**Interfaces:**
- Consumes: `Live.animating`, sampled `cursors(on:)` / `overlay(on:)` from Task 4.
- Produces: `CanvasView.presenceNow: (() -> (CanvasPresence, Bool)?)?`, `CanvasView.animatePresence()`.

- [ ] **Step 1: Display link on the canvas**

In `CanvasView.swift`, beside `var presence`:

```swift
  /// Others' presence as it shows now, and whether it still moves; asked each frame while it does.
  var presenceNow: (() -> (CanvasPresence, Bool)?)?
  private var presenceLink: CADisplayLink?

  /// Draws others' cursors and live edits each frame until they stop moving.
  func animatePresence() {
    guard presenceLink == nil, window != nil else { return }
    let link = displayLink(target: self, selector: #selector(presenceFrame))
    link.add(to: .main, forMode: .common)
    presenceLink = link
  }

  @objc private func presenceFrame(_ link: CADisplayLink) {
    guard let now = presenceNow?() else { return stopPresence() }
    presence = now.0
    if !now.1 { stopPresence() }
  }

  private func stopPresence() {
    presenceLink?.invalidate()
    presenceLink = nil
  }
```

If `CanvasView` already overrides `viewDidMoveToWindow`, add `if window == nil { stopPresence() }` there; otherwise add:

```swift
  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    if window == nil { stopPresence() }
  }
```

- [ ] **Step 2: Skip the height pass when only positions move**

In `presenceChanged(from:)`, replace the condition that recomputes `overlayHeights` so it runs only when text, width, the set of overlaid items, holds or selections changed; layout still runs on any overlay change:

```swift
  private func presenceChanged(from old: CanvasPresence) {
    let taken = Set(presence.taken.keys)
    if !selection.isDisjoint(with: taken) { selection.subtract(taken) }
    let sizing = { (o: [String: LiveFields]) in o.mapValues { [$0["text"], $0["w"]] } }
    if sizing(presence.overlay) != sizing(old.overlay) || presence.taken != old.taken || presence.seen != old.seen {
      overlayHeights = [:]
      for c in shown.cards where presence.overlay[c.id]?["text"] != nil || presence.overlay[c.id]?["w"] != nil || board.card(c.id) == nil {
        overlayHeights[c.id] = Double(TextMetrics.frontHeight(c.text, width: CGFloat(c.w)))
      }
    }
    if presence.overlay != old.overlay || presence.taken != old.taken || presence.seen != old.seen {
      placeLanes()
      layoutCards()
    } else {
      showPresence()
    }
  }
```

- [ ] **Step 3: No more Core Animation glide**

In `PresenceView.show`, replace the four `CATransaction` setup lines and the comment above them with:

```swift
      CATransaction.begin()
      // positions come from playback every frame
      CATransaction.setDisableActions(true)
```

- [ ] **Step 4: Wire the library**

In `Library.wire(_:)` add:

```swift
    canvas.presenceNow = { [weak self] in
      guard let live = self?.spaces.group(of: id)?.live else { return nil }
      return (CanvasPresence(live, board: id), live.animating)
    }
```

In `liveChanged(_:)`, inside the `for d in documents` loop after setting `presence`, add:

```swift
      if g.live?.animating == true { d.windowController?.canvas.animatePresence() }
```

- [ ] **Step 5: Build and test**

Run: `xcodegen generate && xcodebuild -project Breezy.xcodeproj -scheme Breezy -configuration Debug -derivedDataPath build build 2>&1 | tail -3` and `swift test --package-path BreezyKit`
Expected: `** BUILD SUCCEEDED **`, tests pass.

- [ ] **Step 6: Check by hand**

With the three local servers from Task 5, run the Mac app on a scratch library (`build/Build/Products/Debug/Breezy.app/Contents/MacOS/Breezy -BreezyStore <dir> -ApplePersistenceIgnoreState YES`) joined to the same space as a Safari window (a `Spaces/<space id>.json` holding `server`, `space`, `secret`, `cursor`, `records`, `held`, `unreadable` and `resync` joins it without the dialog). Move the pointer in Safari: the Mac's copy moves without stepping; drag a card in Safari: it slides on the Mac; type in it: text shows as typed.

- [ ] **Step 7: Commit**

```bash
git add Breezy/Canvas/CanvasView.swift Breezy/Canvas/PresenceView.swift Breezy/Library/Library.swift
git commit --message "Draw others' cursors and live edits every frame on the Mac, from a display link"
```

### Task 7: Phase 1 pull request

- [ ] **Step 1: Full verification**

Run: `node --test web/test/*.test.js && swift test --package-path BreezyKit`
Expected: all pass.

- [ ] **Step 2: Ask the user, then push and open the PR**

After the user agrees: `git push --set-upstream origin webrtc` and `gh pr create --title "Play others' cursors and drags back smoothly, every frame" --body "<what changed, in a few lines; the spec's link; no session links>"`. Continue Phase 2 on a branch from this one: `git switch --create webrtc-direct`.

---

# Phase 2: the direct pipe

### Task 8: Direct, the signalling state machine, on the web

**Files:**
- Create: `web/sync/direct.js`
- Create: `web/test/helpers/fake-transport.js`
- Test: `web/test/direct.test.js`

**Interfaces:**
- Produces:
  - The transport contract (JS): `create(id)`, `offer(id, restart): Promise<sdp>`, `answer(id, sdp): Promise<sdp>`, `accept(id, sdp): Promise<void>`, `add(id, { candidate, mid, index })`, `send(id, text): boolean`, `close(id)`, and callbacks it calls: `onCandidate(id, candidate | null)`, `onState(id, "open" | "closed" | "failed")`, `onMessage(id, text)`.
  - `new Direct(transport, { now, relay(to, body), message(from, text), change() })` with `welcome(ids)`, `heard(from, body)` for `offer`/`answer`/`ice`, `leave(id)`, `reset()`, `tick()`, `isOpen(id)`, `send(id, text)`. Constants `OPEN_TIMEOUT_MS = 10_000`, `RESTART_MS = 2_000`, `MAX_RESTARTS = 3`.

- [ ] **Step 1: Write the fake transport**

`web/test/helpers/fake-transport.js`:

```js
/** A PeerTransport that records what Direct asks of it. Answers and accepts resolve at once, or on `release()` while
 * `deferred`; `onOffer` candidates are gathered while an offer is made, as a browser may. */
export class FakeTransport {
  constructor() {
    this.log = [];
    this.sent = [];
    this.deferred = false;
    this.waiting = [];
    this.onOffer = [];
    this.onCandidate = () => {};
    this.onState = () => {};
    this.onMessage = () => {};
  }

  create(id) {
    this.log.push(`create ${id}`);
  }

  async offer(id, restart) {
    this.log.push(`offer ${id}${restart ? " restart" : ""}`);
    for (const c of this.onOffer) this.onCandidate(id, c);
    return `offer-sdp ${id}`;
  }

  answer(id, sdp) {
    this.log.push(`answer ${id} ${sdp}`);
    return this.later(`answer-sdp ${id}`);
  }

  accept(id, sdp) {
    this.log.push(`accept ${id} ${sdp}`);
    return this.later();
  }

  add(id, c) {
    this.log.push(`add ${id} ${c.candidate}`);
  }

  send(id, text) {
    this.sent.push({ id, text });
    return true;
  }

  close(id) {
    this.log.push(`close ${id}`);
  }

  later(v) {
    return this.deferred ? new Promise((r) => this.waiting.push(() => r(v))) : Promise.resolve(v);
  }

  release() {
    for (const r of this.waiting.splice(0)) r();
  }
}
```

- [ ] **Step 2: Write the failing tests**

`web/test/direct.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { Direct, OPEN_TIMEOUT_MS, RESTART_MS } from "../sync/direct.js";
import { FakeTransport } from "./helpers/fake-transport.js";

const settle = () => new Promise((r) => setImmediate(r));

function direct() {
  let t = 1_000_000;
  const transport = new FakeTransport(), relayed = [], messages = [];
  let changes = 0;
  const d = new Direct(transport, { now: () => t, relay: (to, b) => relayed.push({ to, ...b }), message: (from, text) => messages.push({ from, text }), change: () => changes++ });
  return { d, transport, relayed, messages, advance: (ms) => (t += ms), changes: () => changes };
}

test("the newcomer offers to everyone already here, its candidates after its offer", async () => {
  const { d, transport, relayed } = direct();
  transport.onOffer = [{ candidate: "c1", mid: "0", index: 0 }];
  d.welcome(["p1", "p2"]);
  await settle();
  assert.deepEqual(transport.log, ["create p1", "offer p1", "create p2", "offer p2"]);
  assert.deepEqual(relayed.map((b) => `${b.t} ${b.to}`), ["offer p1", "ice p1", "offer p2", "ice p2"]);
  assert.deepEqual(relayed[1], { to: "p1", t: "ice", candidate: "c1", mid: "0", index: 0 });
});

test("an offer is answered; candidates that come early wait for the remote description", async () => {
  const { d, transport, relayed } = direct();
  transport.deferred = true;
  d.heard("p1", { t: "offer", sdp: "o" });
  d.heard("p1", { t: "ice", candidate: "c1", mid: "0", index: 0 });
  await settle();
  assert.deepEqual(transport.log, ["create p1", "answer p1 o"]);
  transport.release();
  await settle();
  assert.deepEqual(transport.log, ["create p1", "answer p1 o", "add p1 c1"]);
  assert.deepEqual(relayed, [{ to: "p1", t: "answer", sdp: "answer-sdp p1" }]);
});

test("an answer is accepted, then early candidates are added", async () => {
  const { d, transport } = direct();
  d.welcome(["p1"]);
  await settle();
  d.heard("p1", { t: "ice", candidate: "c1", mid: "0", index: 0 });
  d.heard("p1", { t: "answer", sdp: "a" });
  await settle();
  assert.deepEqual(transport.log, ["create p1", "offer p1", "accept p1 a", "add p1 c1"]);
});

test("an offer to a connection that offered itself is ignored", async () => {
  const { d, transport, relayed } = direct();
  d.welcome(["p1"]);
  await settle();
  d.heard("p1", { t: "offer", sdp: "o" });
  await settle();
  assert.deepEqual(transport.log, ["create p1", "offer p1"]);
  assert.deepEqual(relayed.map((b) => b.t), ["offer"]);
});

test("open channels carry messages; others do not", async () => {
  const { d, transport, messages, changes } = direct();
  d.welcome(["p1"]);
  await settle();
  transport.onMessage("p1", "early");
  transport.onState("p1", "open");
  assert.ok(d.isOpen("p1"));
  assert.equal(changes(), 1);
  transport.onMessage("p1", "hello");
  assert.deepEqual(messages, [{ from: "p1", text: "hello" }]);
  assert.ok(d.send("p1", "x"));
  assert.ok(!d.send("p2", "x"));
  assert.deepEqual(transport.sent, [{ id: "p1", text: "x" }]);
});

test("a channel that does not open within 10 s is given up", async () => {
  const { d, transport, advance } = direct();
  d.welcome(["p1"]);
  await settle();
  advance(OPEN_TIMEOUT_MS - 1);
  d.tick();
  assert.ok(!transport.log.includes("close p1"));
  advance(1);
  d.tick();
  assert.ok(transport.log.includes("close p1"));
  assert.ok(!d.isOpen("p1"));
});

test("the offerer restarts ICE on failure, up to three times, 2 s apart", async () => {
  const { d, transport, advance } = direct();
  d.welcome(["p1"]);
  await settle();
  transport.onState("p1", "open");
  for (let i = 0; i < 4; i++) {
    transport.onState("p1", "failed");
    advance(RESTART_MS);
    d.tick();
    await settle();
  }
  assert.equal(transport.log.filter((l) => l === "offer p1 restart").length, 3);
  assert.ok(!d.isOpen("p1"));
});

test("the answerer waits for the offerer to restart", async () => {
  const { d, transport, advance } = direct();
  d.heard("p1", { t: "offer", sdp: "o" });
  await settle();
  transport.onState("p1", "open");
  transport.onState("p1", "failed");
  advance(RESTART_MS);
  d.tick();
  await settle();
  assert.ok(!transport.log.some((l) => l.startsWith("offer")));
  assert.ok(!transport.log.includes("close p1"));
});

test("leave and reset close connections", async () => {
  const { d, transport } = direct();
  d.welcome(["p1", "p2"]);
  await settle();
  d.leave("p1");
  d.reset();
  assert.deepEqual(transport.log.filter((l) => l.startsWith("close")), ["close p1", "close p2"]);
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `node --test web/test/direct.test.js`
Expected: FAIL, cannot find module `../sync/direct.js`.

- [ ] **Step 4: Implement**

`web/sync/direct.js`:

```js
// Direct data channels to a space's other connections, beside the relay, for cursors and live edits, as BreezyKit's
// Direct; see the WebRTC design. Offers, answers and candidates go through the relay; the transport does WebRTC.
export const OPEN_TIMEOUT_MS = 10_000;
export const RESTART_MS = 2_000;
export const MAX_RESTARTS = 3;

const iceOf = (b) =>
  typeof b.candidate === "string" ? { candidate: b.candidate, mid: typeof b.mid === "string" ? b.mid : null, index: Number.isInteger(b.index) ? b.index : null } : null;

export class Direct {
  /** `relay(to, body)` sends through the relay; `message(from, text)` is a sealed body that came direct; `change()`
   * follows a channel opening or closing. */
  constructor(transport, { now, relay, message, change }) {
    Object.assign(this, { transport, now, relay, message, change });
    /** Connection id → { id, offerer, open, everOpen, since, restarts, restartAt, remote, inbox, ready, outbox }. */
    this.links = new Map();
    transport.onCandidate = (id, c) => this.gathered(id, c);
    transport.onState = (id, state) => this.state(id, state);
    transport.onMessage = (id, text) => this.links.get(id)?.open && this.message(id, text);
  }

  isOpen(id) {
    return this.links.get(id)?.open ?? false;
  }

  send(id, text) {
    return this.isOpen(id) && this.transport.send(id, text);
  }

  /** This connection is new to the space: it offers to each of `ids`, so two sides never offer at once. */
  welcome(ids) {
    this.reset();
    for (const id of ids) this.offer(this.link(id, true));
  }

  link(id, offerer) {
    this.transport.create(id);
    const l = { id, offerer, open: false, everOpen: false, since: this.now(), restarts: 0, restartAt: null, remote: false, inbox: [], ready: false, outbox: [] };
    this.links.set(id, l);
    return l;
  }

  async offer(l, restart = false) {
    l.ready = false;
    l.remote = false;
    const sdp = await this.transport.offer(l.id, restart).catch(() => null);
    if (sdp === null || this.links.get(l.id) !== l) return;
    this.relay(l.id, { t: "offer", sdp });
    this.flushOut(l);
  }

  /** An offer, answer or candidate from connection `from`, through the relay. */
  async heard(from, b) {
    let l = this.links.get(from);
    if (b.t === "offer" && typeof b.sdp === "string") {
      if (l?.offerer) return;
      l ??= this.link(from, false);
      l.since = this.now();
      l.ready = false;
      l.remote = false;
      const sdp = await this.transport.answer(from, b.sdp).catch(() => null);
      if (sdp === null || this.links.get(from) !== l) return;
      this.remoteSet(l);
      this.relay(from, { t: "answer", sdp });
      this.flushOut(l);
    } else if (b.t === "answer" && typeof b.sdp === "string" && l?.offerer) {
      const ok = await this.transport.accept(from, b.sdp).then(() => true, () => false);
      if (ok && this.links.get(from) === l) this.remoteSet(l);
    } else if (b.t === "ice" && l) {
      const c = iceOf(b);
      if (!c) return;
      if (l.remote) this.transport.add(from, c);
      else l.inbox.push(c);
    }
  }

  remoteSet(l) {
    l.remote = true;
    for (const c of l.inbox.splice(0)) this.transport.add(l.id, c);
  }

  /** A candidate this side gathered: after its offer or answer has gone, never before. */
  gathered(id, c) {
    const l = this.links.get(id);
    if (!l) return;
    const body = { t: "ice", ...(c ?? { candidate: null, mid: null, index: null }) };
    if (l.ready) this.relay(id, body);
    else l.outbox.push(body);
  }

  flushOut(l) {
    l.ready = true;
    for (const b of l.outbox.splice(0)) this.relay(l.id, b);
  }

  state(id, s) {
    const l = this.links.get(id);
    if (!l) return;
    const was = l.open;
    l.open = s === "open";
    if (l.open) [l.everOpen, l.restarts] = [true, 0];
    if (s === "failed" && l.offerer && l.restarts < MAX_RESTARTS && l.restartAt === null) l.restartAt = this.now() + RESTART_MS;
    if (was !== l.open) this.change();
  }

  /** About once a second: restarts what failed, and gives up on what never opened. */
  tick() {
    const now = this.now();
    for (const l of [...this.links.values()]) {
      if (l.restartAt !== null && now >= l.restartAt) {
        l.restartAt = null;
        l.restarts++;
        l.since = now;
        this.offer(l, true);
      } else if (!l.everOpen && l.restartAt === null && now - l.since >= OPEN_TIMEOUT_MS) {
        this.leave(l.id);
      }
    }
  }

  leave(id) {
    const l = this.links.get(id);
    if (!l) return;
    this.links.delete(id);
    this.transport.close(id);
    if (l.open) this.change();
  }

  reset() {
    for (const id of [...this.links.keys()]) this.leave(id);
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `node --test web/test/direct.test.js`
Expected: 9 tests pass.

- [ ] **Step 6: Commit**

```bash
git add web/sync/direct.js web/test/direct.test.js web/test/helpers/fake-transport.js
git commit --message "Add direct channels' signalling over the relay on the web"
```

### Task 9: RTCPeerConnection transport on the web

**Files:**
- Create: `web/sync/rtc.js`
- Test: `web/test/rtc.test.js`

**Interfaces:**
- Consumes: the transport contract from Task 8.
- Produces: `class RTCTransport` implementing it; `ICE_SERVERS`.

- [ ] **Step 1: Write the failing test**

`web/test/rtc.test.js` puts a fake `RTCPeerConnection` on `globalThis`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

class FakeChannel {
  readyState = "connecting";
  send(text) {
    this.sent = text;
  }
}

class FakePC {
  static made = [];
  connectionState = "new";
  constructor(config) {
    this.config = config;
    FakePC.made.push(this);
  }
  createDataChannel(label, options) {
    this.options = options;
    return (this.channel = new FakeChannel());
  }
  restartIce() {
    this.restarted = true;
  }
  async setLocalDescription() {
    this.localDescription = { sdp: this.remote ? "answer" : "offer" };
  }
  async setRemoteDescription(d) {
    this.remote = d;
  }
  async addIceCandidate(c) {
    this.added = c;
  }
  close() {
    this.closed = true;
  }
  set(state, channel) {
    this.connectionState = state;
    this.channel.readyState = channel;
    this.onconnectionstatechange?.();
  }
}
globalThis.RTCPeerConnection = FakePC;
const { RTCTransport, ICE_SERVERS } = await import("../sync/rtc.js");

test("each peer gets a negotiated, unordered channel without retransmits, over Cloudflare's STUN", () => {
  new RTCTransport().create("p1");
  const pc = FakePC.made.at(-1);
  assert.deepEqual(pc.config, { iceServers: ICE_SERVERS });
  assert.deepEqual(ICE_SERVERS, [{ urls: "stun:stun.cloudflare.com:3478" }]);
  assert.deepEqual(pc.options, { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
});

test("offers, answers, candidates and messages pass through", async () => {
  const t = new RTCTransport(), got = [];
  t.onMessage = (id, text) => got.push([id, text]);
  t.onCandidate = (id, c) => got.push([id, c]);
  t.create("p1");
  const pc = FakePC.made.at(-1);
  assert.equal(await t.offer("p1", false), "offer");
  await t.accept("p1", "remote");
  assert.deepEqual(pc.remote, { type: "answer", sdp: "remote" });
  t.add("p1", { candidate: "c", mid: "0", index: 0 });
  assert.deepEqual(pc.added, { candidate: "c", sdpMid: "0", sdpMLineIndex: 0 });
  pc.onicecandidate({ candidate: { candidate: "x", sdpMid: "0", sdpMLineIndex: 0 } });
  pc.onicecandidate({ candidate: null });
  pc.channel.onmessage({ data: "hi" });
  assert.deepEqual(got, [["p1", { candidate: "x", mid: "0", index: 0 }], ["p1", null], ["p1", "hi"]]);
});

test("a connection that recovers after a restart reports open again, though its channel never closed", async () => {
  const t = new RTCTransport(), states = [];
  t.onState = (id, s) => states.push(s);
  t.create("p1");
  const pc = FakePC.made.at(-1);
  pc.set("connected", "open");
  pc.set("failed", "open");
  await t.offer("p1", true);
  assert.ok(pc.restarted);
  pc.set("connected", "open");
  assert.deepEqual(states, ["open", "failed", "open"]);
});

test("send says whether it went; close forgets the peer", () => {
  const t = new RTCTransport();
  t.create("p1");
  const pc = FakePC.made.at(-1);
  assert.equal(t.send("p1", "x"), false);
  pc.set("connected", "open");
  assert.equal(t.send("p1", "x"), true);
  t.close("p1");
  assert.ok(pc.closed);
  assert.equal(t.send("p1", "x"), false);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test web/test/rtc.test.js`
Expected: FAIL, cannot find module `../sync/rtc.js`.

- [ ] **Step 3: Implement**

`web/sync/rtc.js`:

```js
// Direct's transport over the browser's RTCPeerConnection; see the WebRTC design. Breezy/Live/peer.html is its twin
// in the Mac app's web view.
export const ICE_SERVERS = [{ urls: "stun:stun.cloudflare.com:3478" }];

export class RTCTransport {
  constructor() {
    this.peers = new Map();
    this.onCandidate = () => {};
    this.onState = () => {};
    this.onMessage = () => {};
  }

  create(id) {
    this.close(id);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const ch = pc.createDataChannel("live", { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    const mine = () => this.peers.get(id)?.pc === pc;
    // a restart that recovers leaves the channel open, so open is the connection's state as much as the channel's
    const report = () => mine() && this.onState(id, pc.connectionState === "failed" ? "failed" : pc.connectionState === "connected" && ch.readyState === "open" ? "open" : "closed");
    pc.onicecandidate = (e) => mine() && this.onCandidate(id, e.candidate && { candidate: e.candidate.candidate, mid: e.candidate.sdpMid, index: e.candidate.sdpMLineIndex });
    pc.onconnectionstatechange = report;
    ch.onopen = report;
    ch.onclose = report;
    ch.onmessage = (e) => mine() && this.onMessage(id, String(e.data));
    this.peers.set(id, { pc, ch });
  }

  async offer(id, restart) {
    const { pc } = this.peers.get(id);
    if (restart) pc.restartIce();
    await pc.setLocalDescription();
    return pc.localDescription.sdp;
  }

  async answer(id, sdp) {
    const { pc } = this.peers.get(id);
    await pc.setRemoteDescription({ type: "offer", sdp });
    await pc.setLocalDescription();
    return pc.localDescription.sdp;
  }

  async accept(id, sdp) {
    await this.peers.get(id).pc.setRemoteDescription({ type: "answer", sdp });
  }

  add(id, c) {
    this.peers.get(id)?.pc.addIceCandidate({ candidate: c.candidate, sdpMid: c.mid, sdpMLineIndex: c.index }).catch(() => {});
  }

  send(id, text) {
    const p = this.peers.get(id);
    if (p?.pc.connectionState !== "connected" || p.ch.readyState !== "open") return false;
    p.ch.send(text);
    return true;
  }

  close(id) {
    const p = this.peers.get(id);
    this.peers.delete(id);
    p?.pc.close();
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test web/test/rtc.test.js`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add web/sync/rtc.js web/test/rtc.test.js
git commit --message "Add a WebRTC transport for direct channels on the web"
```

### Task 10: Route cursors and live edits over open channels on the web

**Files:**
- Modify: `web/sync/live.js`
- Modify: `web/sync/spaces.js:51` and `web/sync/spaces.js:107` (pass `peerTransport` through)
- Modify: `web/library.js` (`statusLines`, `liveChanged`)
- Test: `web/test/live.test.js`

**Interfaces:**
- Consumes: `Direct` (Task 8), `RTCTransport` (Task 9), `sendFast` (Task 3), `FakeTransport` (Task 8).
- Produces: `new Live({ ..., peerTransport })` (a factory; default `() => new RTCTransport()` when `RTCPeerConnection` exists, else none); `DIRECT_SEND_MS = 8`; `live.sendMs`; `live.directStatus(): string | null`; `new Spaces(storage, states, { ..., peerTransport })`.

- [ ] **Step 1: Write the failing tests**

Append to `web/test/live.test.js` (add `import { FakeTransport } from "./helpers/fake-transport.js";` at the top):

```js
/** `n` devices with fake transports, all on board B1, the last one the newcomer. */
async function direct(n = 2) {
  const relay = new FakeRelay(), clock = new Clock();
  const ts = [], ls = [];
  for (let i = 0; i < n; i++) {
    const t = new FakeTransport();
    const l = new Live({ relay: "wss://relay.example/", space: SPACE, keys, me: { device: device(), name: `P${i}` }, socket: () => relay.connect(), now: clock.now, clock: clock.now, schedule: clock.schedule, peerTransport: () => t });
    l.connect();
    await relay.run();
    l.setPresence({ board: "B1", selection: [] });
    await relay.run();
    ts.push(t);
    ls.push(l);
  }
  /** Opens the channel between devices i and j, both ways. */
  const open = (i, j) => {
    ts[i].onState(ls[j].id, "open");
    ts[j].onState(ls[i].id, "open");
  };
  const bodyFrames = () => relay.frames.filter((f) => f.text.includes('"body"') && !f.text.includes('"to"')).length;
  return { relay, clock, ts, ls, open, bodyFrames };
}

test("the newcomer offers through the relay and the others answer", async () => {
  const { ts, ls } = await direct();
  assert.deepEqual(ts[1].log.slice(0, 2), [`create ${ls[0].id}`, `offer ${ls[0].id}`]);
  assert.deepEqual(ts[0].log.slice(0, 2), [`create ${ls[1].id}`, `answer ${ls[1].id} offer-sdp ${ls[0].id}`]);
  assert.ok(ts[1].log.includes(`accept ${ls[0].id} answer-sdp ${ls[1].id}`));
});

test("with every channel open, cursors go only direct and every frame", async () => {
  const { relay, clock, ts, ls, open, bodyFrames } = await direct();
  open(0, 1);
  assert.equal(ls[0].sendMs, 8);
  const before = bodyFrames();
  ls[0].sendCursor("B1", 1, 1);
  await relay.run();
  clock.advance(8);
  ls[0].sendCursor("B1", 2, 2);
  await relay.run();
  assert.equal(bodyFrames(), before);
  assert.equal(ts[0].sent.length, 2);
  for (const { text } of ts[0].sent) ts[1].onMessage(ls[0].id, text);
  await relay.run();
  clock.advance(200);
  assert.deepEqual(ls[1].cursors("B1").map((c) => c.x), [2]);
});

test("with a channel short, cursors go to the relay too", async () => {
  const { relay, ts, ls, open, bodyFrames } = await direct(3);
  open(0, 1);
  assert.equal(ls[0].sendMs, 50);
  const before = bodyFrames();
  ls[0].sendCursor("B1", 1, 1);
  await relay.run();
  assert.equal(bodyFrames(), before + 1);
  assert.deepEqual(ts[0].sent.map((s) => s.id), [ls[1].id]);
});

test("while holding, the heartbeat goes to the relay even with every channel open", async () => {
  const { relay, clock, ls, open, bodyFrames } = await direct();
  open(0, 1);
  ls[0].hold(["c1"]);
  ls[0].sendLive("B1", moved, null);
  await relay.run();
  const before = bodyFrames();
  clock.advance(5000);
  ls[0].tick();
  await relay.run();
  assert.equal(bodyFrames(), before + 1);
});

test("only cursors and live edits are taken from a channel", async () => {
  const { relay, ts, ls, open } = await direct();
  open(0, 1);
  const pushes = [];
  ls[1].onPushed = (v) => pushes.push(v);
  const sealed = encode(await keys.sealLive(new TextEncoder().encode(JSON.stringify({ t: "pushed", version: 9 }))));
  ts[1].onMessage(ls[0].id, sealed);
  await relay.run();
  assert.deepEqual(pushes, []);
});

test("a peer leaving closes its connection; the status line counts open channels", async () => {
  const { relay, ts, ls, open } = await direct();
  assert.equal(ls[0].directStatus(), "Direct with 0 of 1 person");
  open(0, 1);
  assert.equal(ls[0].directStatus(), "Direct with 1 of 1 person");
  ls[1].close();
  await relay.run();
  assert.ok(ts[0].log.includes(`close ${ls[1].id}`));
  assert.equal(ls[0].directStatus(), null);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test web/test/live.test.js`
Expected: the six new tests FAIL.

- [ ] **Step 3: Implement in `web/sync/live.js`**

1. Imports: `import { Direct } from "./direct.js";` and `import { RTCTransport } from "./rtc.js";`. Export `export const DIRECT_SEND_MS = 8;` beside `SEND_MS`.
2. `Gate.run`: use `this.live.sendMs` in place of `SEND_MS`.
3. Constructor: add the option `peerTransport = typeof RTCPeerConnection === "function" ? () => new RTCTransport() : null` and:

```js
    /** The other connections in the space, as the relay names them. */
    this.roster = new Set();
    this.direct = peerTransport && new Direct(peerTransport(), {
      now,
      relay: (to, body) => this.send(body, to),
      message: (from, text) => (this.in = this.in.then(() => this.opened(from, text, true)).catch(() => {})),
      change: () => this.onChange(),
    });
```

4. `reset()`: add `this.roster.clear();` and `this.direct?.reset();`.
5. `received`: in `welcome` add, before `this.sendPresence()`:
```js
        this.roster = new Set(Array.isArray(m.peers) ? m.peers.filter((p) => typeof p === "string") : []);
        this.direct?.welcome([...this.roster]);
```
In `join` add `this.roster.add(m.id);` before `return this.sendPresence(m.id);`. In `leave` add `this.roster.delete(m.id); this.direct?.leave(m.id);`. Replace the body-handling tail (from `if (typeof m?.from !== "string" ...` to the end of the method) with:
```js
    if (typeof m?.from === "string" && typeof m.body === "string") await this.opened(m.from, m.body, false);
```
and add:
```js
  /** A sealed body from connection `from`, through the relay or, `direct`, over its channel, which carries only
   * cursors and live edits. */
  async opened(from, body, direct) {
    let b;
    try {
      b = JSON.parse(dec.decode(await this.keys.openLive(decode(body))));
    } catch {
      return;
    }
    if (!this.connected) return;
    if (["offer", "answer", "ice"].includes(b?.t)) return direct || this.direct?.heard(from, b);
    if (direct && b?.t !== "cursor" && b?.t !== "live") return;
    this.heard(from, b);
  }
```
6. `tick()`: add `this.direct?.tick();` after the ping block.
7. Split sealing from `send` and route `sendFast`:

```js
  /** `body` sealed, as base64url; null when too big to send. */
  async seal(body) {
    const sealed = encode(await this.keys.sealLive(enc.encode(JSON.stringify(body))));
    return sealed.length > MAX_FRAME - 100 ? null : sealed;
  }

  send(body, to) {
    if (!this.connected) return Promise.resolve(false);
    const ws = this.ws;
    const sent = this.out.then(async () => {
      const sealed = await this.seal(body);
      if (!sealed || ws !== this.ws || ws.readyState !== 1) return false;
      ws.send(JSON.stringify(to ? { to, body: sealed } : { body: sealed }));
      return true;
    }).catch(() => false);
    this.out = sent;
    return sent;
  }

  /** Whether every other connection has an open channel. */
  get allDirect() {
    return this.roster.size > 0 && [...this.roster].every((id) => this.direct?.isOpen(id));
  }

  get sendMs() {
    return this.allDirect ? DIRECT_SEND_MS : SEND_MS;
  }

  /** A cursor or live body, stamped: over every open channel, and to the relay unless all are open; `relayOnly` for the
   * holder's heartbeat, which keeps the holds there. */
  sendFast(body, { relayOnly = false } = {}) {
    if (!this.connected) return Promise.resolve(false);
    const stamped = { ...body, at: this.clock(), seq: ++this.seq };
    const ws = this.ws;
    const sent = this.out.then(async () => {
      const sealed = await this.seal(stamped);
      if (!sealed || ws !== this.ws) return false;
      if (!relayOnly) for (const id of this.roster) this.direct?.send(id, sealed);
      if ((relayOnly || !this.allDirect) && ws.readyState === 1) ws.send(JSON.stringify({ body: sealed }));
      return true;
    }).catch(() => false);
    this.out = sent;
    return sent;
  }
```

In `tick()`'s heartbeat, pass `{ relayOnly: true }` to both `sendFast` calls.

8. Status line:

```js
  /** "Direct with 1 of 2 people", for the status lines, while anyone else is here. */
  directStatus() {
    const people = [...this.roster].filter((id) => this.peers.get(id)?.person);
    if (!people.length) return null;
    const open = people.filter((id) => this.direct?.isOpen(id)).length;
    return `Direct with ${open} of ${people.length} ${people.length === 1 ? "person" : "people"}`;
  }
```

- [ ] **Step 4: Pass the transport through Spaces, show the status line**

`web/sync/spaces.js`: add `peerTransport` to the constructor's options, keep it as `this.peerTransport`, and in `setRelay` pass `...(this.peerTransport !== undefined ? { peerTransport: this.peerTransport } : {})` to `new Live(...)` as `socket` is passed. `web/test/spaces.test.js` needs no change: in Node `RTCPeerConnection` is undefined, so Live has no `Direct`.

`web/library.js`:
- `statusLines()` returns `[...unsaved lines, ...sync lines, ...(this.live?.directStatus() ? [this.live.directStatus()] : [])]`.
- `liveChanged(g)`: add `if (g === this.group) this.app.ui.updateSync();`.

- [ ] **Step 5: Run all web tests**

Run: `node --test web/test/*.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/sync/live.js web/sync/spaces.js web/library.js web/test/live.test.js
git commit --message "Send cursors and live edits over direct channels when they are open, every frame, and fall back to the relay on the web"
```

### Task 11: Direct in BreezyKit

**Files:**
- Create: `BreezyKit/Sources/BreezyKit/Direct.swift`
- Modify: `BreezyKit/Tests/BreezyKitTests/LiveFakes.swift` (add `FakeTransport`)
- Test: `BreezyKit/Tests/BreezyKitTests/DirectTests.swift`

**Interfaces:**
- Produces:

```swift
public struct IceCandidate: Equatable, Sendable { public var candidate: String; public var mid: String?; public var index: Int? }
public enum PeerState: String, Sendable { case open, closed, failed }
@MainActor public protocol PeerTransport: AnyObject {
  var onCandidate: ((String, IceCandidate?) -> Void)? { get set }
  var onState: ((String, PeerState) -> Void)? { get set }
  var onMessage: ((String, String) -> Void)? { get set }
  func create(_ peer: String)
  func offer(_ peer: String, restart: Bool, _ done: @escaping @MainActor (String?) -> Void)
  func answer(_ peer: String, offer: String, _ done: @escaping @MainActor (String?) -> Void)
  func accept(_ peer: String, answer: String, _ done: @escaping @MainActor (Bool) -> Void)
  func add(_ peer: String, candidate: IceCandidate)
  @discardableResult func send(_ peer: String, _ text: String) -> Bool
  func close(_ peer: String)
}
@MainActor public final class Direct {
  public static let openTimeout: TimeInterval = 10, restartDelay: TimeInterval = 2, maxRestarts = 3
  public init(transport: PeerTransport, now: @escaping () -> Date, relay: @escaping (String, [String: JSONValue]) -> Void,
              message: @escaping (String, String) -> Void, change: @escaping () -> Void)
  public func isOpen(_ id: String) -> Bool
  @discardableResult public func send(_ id: String, _ text: String) -> Bool
  public func welcome(_ ids: [String])
  public func heard(_ from: String, _ b: [String: JSONValue])
  public func tick()
  public func leave(_ id: String)
  public func reset()
}
```

- [ ] **Step 1: Add the fake**

In `LiveFakes.swift`:

```swift
/// A PeerTransport that records what Direct asks of it. Answers and accepts complete at once, or on `release()` while
/// `deferred`; `onOffer` candidates are gathered while an offer is made, as a browser may.
@MainActor final class FakeTransport: PeerTransport {
  var onCandidate: ((String, IceCandidate?) -> Void)?
  var onState: ((String, PeerState) -> Void)?
  var onMessage: ((String, String) -> Void)?
  var log: [String] = []
  var sent: [(id: String, text: String)] = []
  var deferred = false
  var waiting: [() -> Void] = []
  var onOffer: [IceCandidate] = []

  func create(_ peer: String) { log.append("create \(peer)") }

  func offer(_ peer: String, restart: Bool, _ done: @escaping @MainActor (String?) -> Void) {
    log.append("offer \(peer)\(restart ? " restart" : "")")
    for c in onOffer { onCandidate?(peer, c) }
    done("offer-sdp \(peer)")
  }

  func answer(_ peer: String, offer: String, _ done: @escaping @MainActor (String?) -> Void) {
    log.append("answer \(peer) \(offer)")
    later { done("answer-sdp \(peer)") }
  }

  func accept(_ peer: String, answer: String, _ done: @escaping @MainActor (Bool) -> Void) {
    log.append("accept \(peer) \(answer)")
    later { done(true) }
  }

  func add(_ peer: String, candidate: IceCandidate) { log.append("add \(peer) \(candidate.candidate)") }

  func send(_ peer: String, _ text: String) -> Bool {
    sent.append((peer, text))
    return true
  }

  func close(_ peer: String) { log.append("close \(peer)") }

  private func later(_ work: @escaping () -> Void) { if deferred { waiting.append(work) } else { work() } }

  func release() {
    let w = waiting
    waiting = []
    w.forEach { $0() }
  }
}
```

- [ ] **Step 2: Write the failing tests**

`BreezyKit/Tests/BreezyKitTests/DirectTests.swift`, the same cases as `web/test/direct.test.js`:

```swift
import Foundation
import Testing
@testable import BreezyKit

@MainActor private final class Rig {
  var now = Date(timeIntervalSince1970: 1_000_000)
  let transport = FakeTransport()
  var relayed: [[String: JSONValue]] = []
  var messages: [(String, String)] = []
  var changes = 0
  lazy var direct = Direct(
    transport: transport, now: { [unowned self] in now },
    relay: { [unowned self] to, b in relayed.append(b.merging(["to": .string(to)]) { $1 }) },
    message: { [unowned self] in messages.append(($0, $1)) }, change: { [unowned self] in changes += 1 })
  func tag(_ b: [String: JSONValue]) -> String { "\(b["t"]!.string!) \(b["to"]!.string!)" }
}

private let c1 = IceCandidate(candidate: "c1", mid: "0", index: 0)
private let ice: [String: JSONValue] = ["t": .string("ice"), "candidate": .string("c1"), "mid": .string("0"), "index": .number(0)]

@MainActor @Test func theNewcomerOffersToEveryoneItsCandidatesAfterItsOffer() {
  let r = Rig()
  r.transport.onOffer = [c1]
  r.direct.welcome(["p1", "p2"])
  #expect(r.transport.log == ["create p1", "offer p1", "create p2", "offer p2"])
  #expect(r.relayed.map(r.tag) == ["offer p1", "ice p1", "offer p2", "ice p2"])
  #expect(r.relayed[1] == ice.merging(["to": .string("p1")]) { $1 })
}

@MainActor @Test func anOfferIsAnsweredAndEarlyCandidatesWait() {
  let r = Rig()
  r.transport.deferred = true
  r.direct.heard("p1", ["t": .string("offer"), "sdp": .string("o")])
  r.direct.heard("p1", ice)
  #expect(r.transport.log == ["create p1", "answer p1 o"])
  r.transport.release()
  #expect(r.transport.log == ["create p1", "answer p1 o", "add p1 c1"])
  #expect(r.relayed == [["t": .string("answer"), "sdp": .string("answer-sdp p1"), "to": .string("p1")]])
}

@MainActor @Test func anAnswerIsAcceptedThenEarlyCandidatesAdded() {
  let r = Rig()
  r.direct.welcome(["p1"])
  r.transport.deferred = true
  r.direct.heard("p1", ice)
  r.direct.heard("p1", ["t": .string("answer"), "sdp": .string("a")])
  r.transport.release()
  #expect(r.transport.log == ["create p1", "offer p1", "accept p1 a", "add p1 c1"])
}

@MainActor @Test func anOfferToAConnectionThatOfferedIsIgnored() {
  let r = Rig()
  r.direct.welcome(["p1"])
  r.direct.heard("p1", ["t": .string("offer"), "sdp": .string("o")])
  #expect(r.transport.log == ["create p1", "offer p1"])
}

@MainActor @Test func openChannelsCarryMessages() {
  let r = Rig()
  r.direct.welcome(["p1"])
  r.transport.onMessage?("p1", "early")
  r.transport.onState?("p1", .open)
  #expect(r.direct.isOpen("p1") && r.changes == 1)
  r.transport.onMessage?("p1", "hello")
  #expect(r.messages.map(\.1) == ["hello"])
  #expect(r.direct.send("p1", "x") && !r.direct.send("p2", "x"))
}

@MainActor @Test func aChannelThatDoesNotOpenIn10sIsGivenUp() {
  let r = Rig()
  r.direct.welcome(["p1"])
  r.now += Direct.openTimeout - 0.001
  r.direct.tick()
  #expect(!r.transport.log.contains("close p1"))
  r.now += 0.001
  r.direct.tick()
  #expect(r.transport.log.contains("close p1"))
}

@MainActor @Test func theOffererRestartsUpToThreeTimes() {
  let r = Rig()
  r.direct.welcome(["p1"])
  r.transport.onState?("p1", .open)
  for _ in 0..<4 {
    r.transport.onState?("p1", .failed)
    r.now += Direct.restartDelay
    r.direct.tick()
  }
  #expect(r.transport.log.filter { $0 == "offer p1 restart" }.count == 3)
}

@MainActor @Test func theAnswererWaitsForTheOffererToRestart() {
  let r = Rig()
  r.direct.heard("p1", ["t": .string("offer"), "sdp": .string("o")])
  r.transport.onState?("p1", .open)
  r.transport.onState?("p1", .failed)
  r.now += Direct.restartDelay
  r.direct.tick()
  #expect(!r.transport.log.contains { $0.hasPrefix("offer") } && !r.transport.log.contains("close p1"))
}

@MainActor @Test func leaveAndResetClose() {
  let r = Rig()
  r.direct.welcome(["p1", "p2"])
  r.direct.leave("p1")
  r.direct.reset()
  #expect(r.transport.log.filter { $0.hasPrefix("close") } == ["close p1", "close p2"])
}
```

- [ ] **Step 3: Run them to see them fail**

Run: `swift test --package-path BreezyKit --filter DirectTests`
Expected: build error, `cannot find type 'PeerTransport'`.

- [ ] **Step 4: Implement**

`BreezyKit/Sources/BreezyKit/Direct.swift`:

```swift
import Foundation

/// A candidate address for a direct connection, as WebRTC gathers it.
public struct IceCandidate: Equatable, Sendable {
  public var candidate: String
  public var mid: String?
  public var index: Int?

  public init(candidate: String, mid: String?, index: Int?) {
    self.candidate = candidate
    self.mid = mid
    self.index = index
  }
}

public enum PeerState: String, Sendable { case open, closed, failed }

/// WebRTC data channels to other connections, as `Direct` drives them; the app puts a web view behind it, tests a fake.
@MainActor public protocol PeerTransport: AnyObject {
  var onCandidate: ((String, IceCandidate?) -> Void)? { get set }
  var onState: ((String, PeerState) -> Void)? { get set }
  var onMessage: ((String, String) -> Void)? { get set }
  func create(_ peer: String)
  func offer(_ peer: String, restart: Bool, _ done: @escaping @MainActor (String?) -> Void)
  func answer(_ peer: String, offer: String, _ done: @escaping @MainActor (String?) -> Void)
  func accept(_ peer: String, answer: String, _ done: @escaping @MainActor (Bool) -> Void)
  func add(_ peer: String, candidate: IceCandidate)
  @discardableResult func send(_ peer: String, _ text: String) -> Bool
  func close(_ peer: String)
}

/// Direct data channels to a space's other connections, beside the relay, for cursors and live edits; see the WebRTC
/// design. Offers, answers and candidates go through the relay.
@MainActor public final class Direct {
  public static let openTimeout: TimeInterval = 10
  public static let restartDelay: TimeInterval = 2
  public static let maxRestarts = 3

  private final class Link {
    let offerer: Bool
    var open = false, everOpen = false, remote = false, ready = false
    var since: Date
    var restarts = 0
    var restartAt: Date?
    var inbox: [IceCandidate] = []
    var outbox: [[String: JSONValue]] = []

    init(offerer: Bool, since: Date) {
      self.offerer = offerer
      self.since = since
    }
  }

  private let transport: PeerTransport
  private let now: () -> Date
  private let relay: (String, [String: JSONValue]) -> Void
  private let message: (String, String) -> Void
  private let change: () -> Void
  private var links: [String: Link] = [:]

  public init(transport: PeerTransport, now: @escaping () -> Date, relay: @escaping (String, [String: JSONValue]) -> Void,
              message: @escaping (String, String) -> Void, change: @escaping () -> Void) {
    self.transport = transport
    self.now = now
    self.relay = relay
    self.message = message
    self.change = change
    transport.onCandidate = { [weak self] in self?.gathered($0, $1) }
    transport.onState = { [weak self] in self?.state($0, $1) }
    transport.onMessage = { [weak self] id, text in
      guard let self, links[id]?.open == true else { return }
      self.message(id, text)
    }
  }

  public func isOpen(_ id: String) -> Bool { links[id]?.open ?? false }

  @discardableResult public func send(_ id: String, _ text: String) -> Bool { isOpen(id) && transport.send(id, text) }

  /// This connection is new to the space: it offers to each of `ids`, so two sides never offer at once.
  public func welcome(_ ids: [String]) {
    reset()
    for id in ids { offer(id, link(id, offerer: true)) }
  }

  private func link(_ id: String, offerer: Bool) -> Link {
    transport.create(id)
    let l = Link(offerer: offerer, since: now())
    links[id] = l
    return l
  }

  private func offer(_ id: String, _ l: Link, restart: Bool = false) {
    l.ready = false
    l.remote = false
    transport.offer(id, restart: restart) { [weak self] sdp in
      guard let self, let sdp, links[id] === l else { return }
      relay(id, ["t": .string("offer"), "sdp": .string(sdp)])
      flushOut(id, l)
    }
  }

  /// An offer, answer or candidate from connection `from`, through the relay.
  public func heard(_ from: String, _ b: [String: JSONValue]) {
    let l = links[from]
    switch b["t"]?.string {
    case "offer":
      guard let sdp = b["sdp"]?.string, l?.offerer != true else { return }
      let l = l ?? link(from, offerer: false)
      l.since = now()
      l.ready = false
      l.remote = false
      transport.answer(from, offer: sdp) { [weak self] answer in
        guard let self, let answer, links[from] === l else { return }
        remoteSet(from, l)
        relay(from, ["t": .string("answer"), "sdp": .string(answer)])
        flushOut(from, l)
      }
    case "answer":
      guard let sdp = b["sdp"]?.string, let l, l.offerer else { return }
      transport.accept(from, answer: sdp) { [weak self] ok in
        guard let self, ok, links[from] === l else { return }
        remoteSet(from, l)
      }
    case "ice":
      guard let l, let c = b["candidate"]?.string else { return }
      let candidate = IceCandidate(candidate: c, mid: b["mid"]?.string, index: b["index"]?.number.map { Int($0) })
      if l.remote { transport.add(from, candidate: candidate) } else { l.inbox.append(candidate) }
    default:
      return
    }
  }

  private func remoteSet(_ id: String, _ l: Link) {
    l.remote = true
    let inbox = l.inbox
    l.inbox = []
    for c in inbox { transport.add(id, candidate: c) }
  }

  /// A candidate this side gathered: after its offer or answer has gone, never before.
  private func gathered(_ id: String, _ c: IceCandidate?) {
    guard let l = links[id] else { return }
    let body: [String: JSONValue] = [
      "t": .string("ice"), "candidate": c.map { .string($0.candidate) } ?? .null,
      "mid": c?.mid.map(JSONValue.string) ?? .null, "index": c?.index.map { .number(Double($0)) } ?? .null,
    ]
    if l.ready { relay(id, body) } else { l.outbox.append(body) }
  }

  private func flushOut(_ id: String, _ l: Link) {
    l.ready = true
    let out = l.outbox
    l.outbox = []
    for b in out { relay(id, b) }
  }

  private func state(_ id: String, _ s: PeerState) {
    guard let l = links[id] else { return }
    let was = l.open
    l.open = s == .open
    if l.open {
      l.everOpen = true
      l.restarts = 0
    }
    if s == .failed, l.offerer, l.restarts < Self.maxRestarts, l.restartAt == nil { l.restartAt = now().addingTimeInterval(Self.restartDelay) }
    if was != l.open { change() }
  }

  /// About once a second: restarts what failed, and gives up on what never opened.
  public func tick() {
    let t = now()
    for (id, l) in links {
      if let at = l.restartAt, t >= at {
        l.restartAt = nil
        l.restarts += 1
        l.since = t
        offer(id, l, restart: true)
      } else if !l.everOpen, l.restartAt == nil, t.timeIntervalSince(l.since) >= Self.openTimeout {
        leave(id)
      }
    }
  }

  public func leave(_ id: String) {
    guard let l = links.removeValue(forKey: id) else { return }
    transport.close(id)
    if l.open { change() }
  }

  public func reset() { for id in links.keys.sorted() { leave(id) } }
}
```

- [ ] **Step 5: Run the tests**

Run: `swift test --package-path BreezyKit --filter DirectTests`
Expected: 9 tests pass.

- [ ] **Step 6: Commit**

```bash
git add BreezyKit/Sources/BreezyKit/Direct.swift BreezyKit/Tests/BreezyKitTests/DirectTests.swift BreezyKit/Tests/BreezyKitTests/LiveFakes.swift
git commit --message "Add direct channels' signalling over the relay to BreezyKit, behind a peer transport"
```

### Task 12: Route over open channels in Live.swift

**Files:**
- Modify: `BreezyKit/Sources/BreezyKit/Live.swift`
- Modify: `BreezyKit/Sources/BreezyKit/Spaces.swift:45-55` and `:107` (pass `peerTransport` through)
- Modify: `Breezy/Library/Library.swift:59-61` (`statusLines`)
- Test: `BreezyKit/Tests/BreezyKitTests/LiveTests.swift`

**Interfaces:**
- Consumes: `Direct`, `PeerTransport`, `FakeTransport` (Task 11); `sendFast` (Task 4).
- Produces: `Live.init(..., transport: PeerTransport? = nil)` (last parameter); `Live.directSendInterval = 0.008`; `public var directStatus: String?`; `Spaces.init(..., peerTransport: (@MainActor () -> PeerTransport)? = nil)`.

- [ ] **Step 1: Write the failing tests**

Append to `LiveTests.swift`, the same cases as Task 10:

```swift
/// `n` devices with fake transports, all on board B1, the last one the newcomer.
@MainActor private func direct(_ n: Int = 2) -> (FakeRelay, Clock, [FakeTransport], [Live]) {
  let relay = FakeRelay(), clock = Clock()
  var ts: [FakeTransport] = [], ls: [Live] = []
  for i in 0..<n {
    let t = FakeTransport()
    let l = Live(relay: "wss://relay.example/", space: space, keys: keys(), me: Person(device: newID(), name: "P\(i)"),
                 socket: { relay.connect($0) }, now: { clock.now }, uptime: { clock.now.timeIntervalSince1970 * 1000 },
                 schedule: { clock.schedule($0, $1) }, transport: t)
    l.connect()
    relay.run()
    l.setPresence(board: "B1", selection: [])
    relay.run()
    ts.append(t)
    ls.append(l)
  }
  return (relay, clock, ts, ls)
}

@MainActor private func open(_ ts: [FakeTransport], _ ls: [Live], _ i: Int, _ j: Int) {
  ts[i].onState?(ls[j].id!, .open)
  ts[j].onState?(ls[i].id!, .open)
}

@MainActor private func broadcasts(_ relay: FakeRelay) -> Int { relay.frames.filter { $0.text.contains("\"body\"") && !$0.text.contains("\"to\"") }.count }

@MainActor @Test func theNewcomerOffersThroughTheRelay() {
  let (_, _, ts, ls) = direct()
  #expect(Array(ts[1].log.prefix(2)) == ["create \(ls[0].id!)", "offer \(ls[0].id!)"])
  #expect(Array(ts[0].log.prefix(2)) == ["create \(ls[1].id!)", "answer \(ls[1].id!) offer-sdp \(ls[0].id!)"])
}

@MainActor @Test func withEveryChannelOpenCursorsGoOnlyDirect() {
  let (relay, clock, ts, ls) = direct()
  open(ts, ls, 0, 1)
  let before = broadcasts(relay)
  ls[0].sendCursor(board: "B1", x: 1, y: 1)
  clock.advance(Live.directSendInterval)
  ls[0].sendCursor(board: "B1", x: 2, y: 2)
  relay.run()
  #expect(broadcasts(relay) == before)
  #expect(ts[0].sent.count == 2)
  for s in ts[0].sent { ts[1].onMessage?(ls[0].id!, s.text) }
  clock.advance(0.2)
  #expect(ls[1].cursors(on: "B1").map { $0.cursor.x } == [2])
}

@MainActor @Test func withAChannelShortCursorsGoToTheRelayToo() {
  let (relay, _, ts, ls) = direct(3)
  open(ts, ls, 0, 1)
  let before = broadcasts(relay)
  ls[0].sendCursor(board: "B1", x: 1, y: 1)
  relay.run()
  #expect(broadcasts(relay) == before + 1)
  #expect(ts[0].sent.map(\.id) == [ls[1].id!])
}

@MainActor @Test func theHeartbeatGoesToTheRelayEvenWithEveryChannelOpen() {
  let (relay, clock, ts, ls) = direct()
  open(ts, ls, 0, 1)
  ls[0].hold(["c1"])
  ls[0].sendLive(board: "B1", items: moved, caret: nil)
  relay.run()
  let before = broadcasts(relay)
  clock.advance(5)
  ls[0].tick()
  relay.run()
  #expect(broadcasts(relay) == before + 1)
}

@MainActor @Test func onlyCursorsAndLiveEditsAreTakenFromAChannel() throws {
  let (relay, _, ts, ls) = direct()
  open(ts, ls, 0, 1)
  var pushes: [Int] = []
  ls[1].onPushed = { pushes.append($0) }
  let sealed = Base64URL.encode(try keys().sealLive(Data(#"{"t":"pushed","version":9}"#.utf8)))
  ts[1].onMessage?(ls[0].id!, sealed)
  relay.run()
  #expect(pushes.isEmpty)
}

@MainActor @Test func aPeerLeavingClosesItsConnectionAndTheStatusCountsOpenChannels() {
  let (relay, _, ts, ls) = direct()
  #expect(ls[0].directStatus == "Direct with 0 of 1 person")
  open(ts, ls, 0, 1)
  #expect(ls[0].directStatus == "Direct with 1 of 1 person")
  let gone = ls[1].id!
  ls[1].close()
  relay.run()
  #expect(ts[0].log.contains("close \(gone)"))
  #expect(ls[0].directStatus == nil)
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `swift test --package-path BreezyKit --filter LiveTests`
Expected: build error on `transport:`.

- [ ] **Step 3: Implement in `Live.swift`**

1. Add `public static let directSendInterval: TimeInterval = 0.008`.
2. Properties: `private var roster: Set<String> = []` and `private var direct: Direct?`.
3. `init`: add the last parameter `transport: PeerTransport? = nil`; at the end of `init`:

```swift
    if let transport {
      direct = Direct(
        transport: transport, now: now, relay: { [weak self] to, b in self?.send(b, to: to) },
        message: { [weak self] from, text in self?.opened(from, text, direct: true) }, change: { [weak self] in self?.onChange?() })
    }
```

4. `reset()`: add `roster = []` and `direct?.reset()`.
5. `received`: in `welcome`, before `sendPresence()`:
```swift
      roster = Set((m["peers"]?.array ?? []).compactMap(\.string))
      direct?.welcome(roster.sorted())
```
In `join`: `roster.insert(who)` before `sendPresence(to: who)`. In `leave`: `roster.remove(who)` and `direct?.leave(who)`. Replace the `default:` branch with:
```swift
    default:
      guard let from = m["from"]?.string, let body = m["body"]?.string else { return }
      opened(from, body, direct: false)
```
and add:
```swift
  /// A sealed body from connection `from`, through the relay or, `direct`, over its channel, which carries only cursors
  /// and live edits.
  private func opened(_ from: String, _ body: String, direct isDirect: Bool) {
    guard connected, let sealed = Base64URL.decode(body), let plain = try? keys.openLive(sealed),
          let b = try? JSONDecoder().decode([String: JSONValue].self, from: plain)
    else { return }
    switch b["t"]?.string {
    case "offer", "answer", "ice": if !isDirect { direct?.heard(from, b) }
    case "cursor", "live": heard(from, b)
    default: if !isDirect { heard(from, b) }
    }
  }
```
6. `tick()`: `direct?.tick()` after the ping block. Heartbeat sends become `sendFast(..., relayOnly: true)`.
7. Sealing and routing:

```swift
  /// `body` sealed, as base64url; nil when too big to send.
  private func seal(_ body: [String: JSONValue]) -> String? {
    guard let plain = try? Self.encoder.encode(JSONValue.object(body)), let sealed = try? keys.sealLive(plain) else { return nil }
    let b = Base64URL.encode(sealed)
    return b.count <= Self.maxFrame - 100 ? b : nil
  }

  @discardableResult private func send(_ body: [String: JSONValue], to: String? = nil) -> Bool {
    guard connected, let b = seal(body) else { return false }
    var f: [String: JSONValue] = ["body": .string(b)]
    if let to { f["to"] = .string(to) }
    frame(f)
    return true
  }

  /// Whether every other connection has an open channel.
  private var allDirect: Bool { !roster.isEmpty && roster.allSatisfy { direct?.isOpen($0) == true } }
  private var gateInterval: TimeInterval { allDirect ? Self.directSendInterval : Self.sendInterval }

  /// A cursor or live body, stamped: over every open channel, and to the relay unless all are open; `relayOnly` for
  /// the holder's heartbeat, which keeps the holds there.
  @discardableResult private func sendFast(_ body: [String: JSONValue], relayOnly: Bool = false) -> Bool {
    guard connected else { return false }
    var b = body
    seq += 1
    b["at"] = .number(uptime())
    b["seq"] = .number(Double(seq))
    guard let sealed = seal(b) else { return false }
    if !relayOnly { for id in roster { direct?.send(id, sealed) } }
    if relayOnly || !allDirect { frame(["body": .string(sealed)]) }
    return true
  }
```

In `sendCursor` and `sendLive` replace `Self.sendInterval` with `gateInterval`.

8. Status line:

```swift
  /// "Direct with 1 of 2 people", for the status lines, while anyone else is here.
  public var directStatus: String? {
    let people = roster.filter { peers[$0]?.person != nil }
    guard !people.isEmpty else { return nil }
    let open = people.filter { direct?.isOpen($0) == true }.count
    return "Direct with \(open) of \(people.count) \(people.count == 1 ? "person" : "people")"
  }
```

- [ ] **Step 4: Spaces and the Mac's status lines**

`Spaces.swift`: add `peerTransport: (@MainActor () -> PeerTransport)? = nil` after `socket` in `init`, keep it in `private let peerTransport`, and build the live layer with it:

```swift
      let transport = peerTransport?()
      let live = socket.map { Live(relay: relay, space: space, keys: keys, me: me, socket: $0, transport: transport) }
        ?? Live(relay: relay, space: space, keys: keys, me: me, transport: transport)
```

`Library.swift` `statusLines`:

```swift
  var statusLines: [String] {
    spaces.groups.filter { $0.space != nil }.flatMap { g in (g.engine.status.lines() + [g.live?.directStatus].compactMap { $0 }).map { "\(g.name) — \($0)" } }
  }
```

- [ ] **Step 5: Run all tests and build**

Run: `swift test --package-path BreezyKit && xcodebuild -project Breezy.xcodeproj -scheme Breezy -configuration Debug -derivedDataPath build build 2>&1 | tail -1`
Expected: tests pass, `** BUILD SUCCEEDED **`.

- [ ] **Step 6: Commit**

```bash
git add BreezyKit/Sources/BreezyKit/Live.swift BreezyKit/Sources/BreezyKit/Spaces.swift BreezyKit/Tests/BreezyKitTests/LiveTests.swift Breezy/Library/Library.swift
git commit --message "Send cursors and live edits over direct channels when they are open, and fall back to the relay, in BreezyKit"
```

### Task 13: Two headless Chromiums, direct, then falling back

**Files:**
- Create: `scripts/direct-e2e.mjs`
- Modify: `README.md` (one line under the relay commands)

**Interfaces:**
- Consumes: the web app with Tasks 8–10; `server/dev.sh`; `npm --prefix relay run dev`; `inviteLink` from `web/sync/crypto.js`; the status line from Task 10; `[data-sheet="ok"]` in `web/sheet.js`.

- [ ] **Step 1: Write the script**

`scripts/direct-e2e.mjs`. It needs no npm packages: Node 24's global `WebSocket` speaks the DevTools protocol.

```js
#!/usr/bin/env node
// Two headless Chromiums in one space on this Mac, against server/dev.sh and the relay under wrangler dev: their direct
// channel opens, cursors stop reaching the relay, and closing the channel falls back to it. Needs real Chromium (not
// ungoogled-chromium); BREEZY_CHROMIUM names one, else Playwright's is used: node scripts/direct-e2e.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir, homedir } from "node:os";
import { join, extname } from "node:path";
import { randomBytes } from "node:crypto";
import { inviteLink } from "../web/sync/crypto.js";

const root = new URL("..", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (n) => randomBytes(n).toString("base64url");
const children = [], dirs = [];
const cleanup = () => {
  for (const c of children) c.kill();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
};
process.on("exit", cleanup);

function chromium() {
  if (process.env.BREEZY_CHROMIUM) return process.env.BREEZY_CHROMIUM;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  const dir = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().at(-1);
  const app = join(cache, dir, "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium");
  if (!existsSync(app)) throw new Error("no Chromium: set BREEZY_CHROMIUM");
  return app;
}

async function waitFor(what, test, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await test()) return;
  throw new Error(`timed out: ${what}`);
}

// the web app, without live-server's reloads
const types = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const web = createServer((req, res) => {
  const path = join(root, "web", new URL(req.url, "http://x").pathname.replace(/\/$/, "/index.html"));
  if (!existsSync(path)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream" }).end(readFileSync(path));
}).listen(58565, "127.0.0.1");
process.on("exit", () => web.close());

const relayState = mkdtempSync(join(tmpdir(), "breezy-e2e-relay-"));
dirs.push(relayState);
children.push(spawn("npx", ["--prefix", join(root, "relay"), "wrangler", "dev", "--port", "58568", "--persist-to", relayState], { cwd: join(root, "relay"), stdio: "ignore" }));
children.push(spawn(join(root, "server/dev.sh"), { stdio: "ignore" }));
await waitFor("relay", () => fetch("http://127.0.0.1:58568/").then(() => true, () => false), 60_000);
await waitFor("server", () => fetch("http://127.0.0.1:58566/sync.php").then(() => true, () => false));

/** A browser with its own profile, and a DevTools session on its page. */
async function browser(name) {
  const dir = mkdtempSync(join(tmpdir(), `breezy-e2e-${name}-`));
  dirs.push(dir);
  children.push(spawn(chromium(), ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--webrtc-ip-handling-policy=default", "--window-size=1200,800", "about:blank"], { stdio: "ignore" }));
  await waitFor(`${name} DevTools`, () => existsSync(join(dir, "DevToolsActivePort")));
  const port = readFileSync(join(dir, "DevToolsActivePort"), "utf8").split("\n")[0];
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(pages.find((p) => p.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let next = 0;
  const pending = new Map(), listeners = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id !== undefined) pending.get(m.id)?.(m);
    else for (const l of listeners) l(m);
  };
  const send = (method, params = {}) => new Promise((r) => {
    const id = ++next;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const run = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await send("Page.enable");
  await send("Network.enable");
  // every peer connection the page makes, so that the test can close them
  await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__pcs = []; const P = RTCPeerConnection; window.RTCPeerConnection = function (...a) { const pc = new P(...a); __pcs.push(pc); return pc; }; RTCPeerConnection.prototype = P.prototype;" });
  const go = async (url) => {
    await send("Page.navigate", { url });
    await sleep(500);
  };
  const click = (selector) => run(`document.querySelector(${JSON.stringify(selector)})?.click(), !!document.querySelector(${JSON.stringify(selector)})`);
  const status = () => run(`document.querySelector(".menu.more .status")?.textContent ?? ""`);
  return { name, send, run, go, click, status, listeners };
}

const space = b64(16), secret = b64(32);
const link = inviteLink({ server: "http://127.0.0.1:58566/sync.php", space, secret, name: "E2E" });
const hash = link.slice(link.indexOf("#join="));

async function join(b, name) {
  await b.go("http://127.0.0.1:58565/");
  await b.run(`import("/sync/idb.js").then((m) => m.saveState("me", { device: ${JSON.stringify(b64(16))}, name: ${JSON.stringify(name)} }))`);
  await b.go("about:blank");
  await b.go(`http://127.0.0.1:58565/${hash}`);
  await waitFor(`${name} join prompt`, () => b.click('[data-sheet="ok"]'));
}

const a = await browser("a"), b = await browser("b");
await join(a, "Ana");
await waitFor("New Board", () => a.click("section.boards-group:has(header .edit) button.new"));
await a.run(`document.querySelector(".sheet input").value = "E2E"`);
await a.click('[data-sheet="ok"]');
await waitFor("the board on a", () => a.click(".boards-list li[data-board] button"));
await join(b, "Bo");
await waitFor("the board on b", () => b.click(".boards-list li[data-board] button"));
await waitFor("a channel", async () => (await a.status()).includes("Direct with 1 of 1 person"), 20_000);
console.log("open:", await a.status());

/** Body frames a sends to the relay while its mouse crosses the board. */
async function framesWhileMoving() {
  let frames = 0;
  const count = (m) => m.method === "Network.webSocketFrameSent" && m.params.response.payloadData.includes('"body"') && frames++;
  a.listeners.push(count);
  for (let i = 0; i < 40; i++) {
    await a.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 300 + i * 10, y: 400 });
    await sleep(16);
  }
  await sleep(300);
  a.listeners.splice(a.listeners.indexOf(count), 1);
  return frames;
}

const direct = await framesWhileMoving();
if (direct > 2) throw new Error(`${direct} body frames reached the relay with the channel open`);
await waitFor("a's cursor on b", () => b.run(`!!document.querySelector(".presence .cursor")`));
console.log("direct: relay body frames while moving:", direct);

await b.run("__pcs.forEach((pc) => pc.close())");
await waitFor("the fall back", async () => (await a.status()).includes("Direct with 0 of 1 person"));
const relayed = await framesWhileMoving();
if (relayed < 5) throw new Error(`only ${relayed} body frames reached the relay after the channel closed`);
console.log("fallback: relay body frames while moving:", relayed);
console.log("ok");
process.exit(0);
```

- [ ] **Step 2: Run it**

Run: `chmod +x scripts/direct-e2e.mjs && node scripts/direct-e2e.mjs`
Expected: lines `open: …Direct with 1 of 1 person`, `direct: relay body frames while moving: 0` (at most 2), `fallback: relay body frames while moving: N` with N ≥ 5, then `ok`.

If a selector misses (the script times out naming the step), read the code that renders it (`web/library.js` `renderGroup`/`renderBoard`, `web/sheet.js`) and fix the selector in the script, not the app. If `server/dev.sh` already runs on 58566 or the relay on 58568, stop them first.

- [ ] **Step 3: Document**

In `README.md`, after the `npm --prefix relay run dev` line:

```
node scripts/direct-e2e.mjs    # two headless Chromiums: direct channel, then falling back to the relay; needs php and Playwright's Chromium
```

- [ ] **Step 4: Commit**

```bash
git add scripts/direct-e2e.mjs README.md
git commit --message "Check direct channels and their fall back to the relay with two headless Chromiums"
```

### Task 14: Phase 2 pull request

- [ ] **Step 1: Full verification**

Run: `node --test web/test/*.test.js && swift test --package-path BreezyKit && node scripts/direct-e2e.mjs`
Expected: all pass, `ok`.

- [ ] **Step 2: By hand: phone and Safari**

With the local servers from Task 5 and `live-server` reachable from the phone at `http://<Mac's address>:58565` (Safari on the phone needs a secure context for WebRTC; if `RTCPeerConnection` is missing there over http, test this step against the deployed site after merge instead), join one space from the phone and from Safari on the Mac. Within a few seconds the ⋯ menu's status says "Direct with 1 of 1 person". Move a finger: the Mac's copy keeps up.

- [ ] **Step 3: Ask the user, then push and open the PR**

Base it on the Phase 1 branch if that PR is still open. Continue Phase 3 on `webrtc-mac` from this branch.

---

# Phase 3: the Mac bridge

### Task 15: Spike the WKWebView bridge (throwaway)

**Files:** a throwaway directory outside the repo, e.g. the session scratchpad; nothing is committed. Branch `spike/mac-webrtc` only if code needs to be shared.

This task answers four questions and ends with a written verdict. Stop and report to the user if any answer is "no".

- [ ] **Step 1: Write the probe**

`probe.swift`, a command-line AppKit program with a hidden WKWebView, no window. It loads one page three ways in turn: (a) `loadHTMLString(html, baseURL: URL(string: "https://peer.breezy.invalid/"))`, (b) `loadFileURL` of the page written to a temp directory, (c) a `WKURLSchemeHandler` for `breezy-peer://page`. Configuration: `config.preferences.inactiveSchedulingPolicy = .none`, a `WKScriptMessageHandler` named `probe`.

The page:
1. Posts `isSecureContext` and `typeof RTCPeerConnection`.
2. Makes two `RTCPeerConnection`s with `{ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] }` and negotiated channels as in `web/sync/rtc.js`, connects them to each other in the page, and posts the type (`host`, `srflx`) and address form (`.local` or IP) of every candidate gathered.
3. Exposes `ping(n)`: sends `n` over channel 1; channel 2 echoes; channel 1's `onmessage` posts it back through `probe`. Also exposes `pagePings(count)`: the same 1000 round trips timed with `performance.now()` inside the page, returning p50/p95.

Swift times 1000 sequential `ping` calls, from `callAsyncJavaScript("ping(n)", ...)` to the `probe` message, with `ProcessInfo.processInfo.systemUptime`, and prints p50/p95 beside `pagePings(1000)`'s.

Run it with `swiftc -o probe probe.swift && ./probe` from Terminal, and switch to another app while it runs: the probe has no window and is never the active app, which is the case to test.

- [ ] **Step 2: Record the answers**

1. Which loads give `isSecureContext === true` and an `RTCPeerConnection`? Pick the first of (a), (b), (c) that does.
2. Were `host` (`.local`) and `srflx` candidates gathered without camera or microphone permission?
3. Did the pings run at full speed with no window and the probe inactive (p95 within a few ms of the in-page p95 throughout)?
4. **Budget:** Swift p95 − page p95 ≤ 1 ms.

- [ ] **Step 3: Report**

Tell the user the four answers with the numbers. If all pass, Task 16 proceeds with the chosen load; if (a) was not the one, change the `load` line in Task 16 accordingly. If the budget or (1)–(3) fail, stop: the fallback is Google's WebRTC framework behind the same `PeerTransport`, which needs its own plan.

### Task 16: WebPeerTransport

**Files:**
- Create: `Breezy/Live/peer.html`
- Create: `Breezy/Live/WebPeerTransport.swift`
- Modify: `Breezy/Library/Library.swift:23` (`Spaces(directory:me:)` gains `peerTransport:`)

**Interfaces:**
- Consumes: `PeerTransport`, `IceCandidate`, `PeerState` (Task 11); `Spaces.init(peerTransport:)` (Task 12); the load chosen in Task 15.
- Produces: `WebPeerTransport()`, one per space, all sharing one `PeerPage`.

- [ ] **Step 1: The page**

`Breezy/Live/peer.html` (XcodeGen copies it as a resource, since `Breezy` is the target's source directory). Keep it in step with `web/sync/rtc.js`:

```html
<!doctype html>
<meta charset="utf-8">
<title>Breezy peers</title>
<script>
// Direct channels for the Mac app, which has no RTCPeerConnection of its own: WebPeerTransport calls these functions
// and hears back through the "peer" message handler. web/sync/rtc.js is its twin; see the WebRTC design.
const ICE_SERVERS = [{ urls: "stun:stun.cloudflare.com:3478" }];
const peers = new Map();
const post = (m) => webkit.messageHandlers.peer.postMessage(m);

function create(id) {
  close(id);
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const ch = pc.createDataChannel("live", { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
  const mine = () => peers.get(id)?.pc === pc;
  const report = () => mine() && post({ id, kind: "state", state: pc.connectionState === "failed" ? "failed" : pc.connectionState === "connected" && ch.readyState === "open" ? "open" : "closed" });
  pc.onicecandidate = (e) => mine() && post({ id, kind: "candidate", candidate: e.candidate && { candidate: e.candidate.candidate, mid: e.candidate.sdpMid, index: e.candidate.sdpMLineIndex } });
  pc.onconnectionstatechange = report;
  ch.onopen = report;
  ch.onclose = report;
  ch.onmessage = (e) => mine() && post({ id, kind: "message", text: String(e.data) });
  peers.set(id, { pc, ch });
}

async function offer(id, restart) {
  const { pc } = peers.get(id);
  if (restart) pc.restartIce();
  await pc.setLocalDescription();
  return pc.localDescription.sdp;
}

async function answer(id, sdp) {
  const { pc } = peers.get(id);
  await pc.setRemoteDescription({ type: "offer", sdp });
  await pc.setLocalDescription();
  return pc.localDescription.sdp;
}

async function accept(id, sdp) {
  await peers.get(id).pc.setRemoteDescription({ type: "answer", sdp });
  return true;
}

function add(id, c) {
  peers.get(id)?.pc.addIceCandidate({ candidate: c.candidate, sdpMid: c.mid, sdpMLineIndex: c.index }).catch(() => {});
}

function send(id, text) {
  const p = peers.get(id);
  if (p?.pc.connectionState !== "connected" || p.ch.readyState !== "open") return false;
  p.ch.send(text);
  return true;
}

function close(id) {
  const p = peers.get(id);
  peers.delete(id);
  p?.pc.close();
}
</script>
```

- [ ] **Step 2: The transport**

`Breezy/Live/WebPeerTransport.swift`:

```swift
import BreezyKit
import WebKit

/// `PeerTransport` over WebRTC in a hidden web view, as macOS gives apps no RTCPeerConnection; see the WebRTC design.
/// Each transport keys its peers with a prefix of its own in the one page they share.
@MainActor final class WebPeerTransport: PeerTransport {
  var onCandidate: ((String, IceCandidate?) -> Void)?
  var onState: ((String, PeerState) -> Void)?
  var onMessage: ((String, String) -> Void)?
  let prefix = UUID().uuidString + " "
  private let page = PeerPage.shared

  init() { page.register(self) }

  private func key(_ peer: String) -> String { prefix + peer }

  func create(_ peer: String) { page.call("create(id)", ["id": key(peer)]) }

  func offer(_ peer: String, restart: Bool, _ done: @escaping @MainActor (String?) -> Void) {
    page.call("return await offer(id, restart)", ["id": key(peer), "restart": restart]) { done($0 as? String) }
  }

  func answer(_ peer: String, offer: String, _ done: @escaping @MainActor (String?) -> Void) {
    page.call("return await answer(id, sdp)", ["id": key(peer), "sdp": offer]) { done($0 as? String) }
  }

  func accept(_ peer: String, answer: String, _ done: @escaping @MainActor (Bool) -> Void) {
    page.call("return await accept(id, sdp)", ["id": key(peer), "sdp": answer]) { done($0 as? Bool ?? false) }
  }

  func add(_ peer: String, candidate c: IceCandidate) {
    page.call("add(id, c)", ["id": key(peer), "c": ["candidate": c.candidate, "mid": c.mid as Any, "index": c.index as Any]])
  }

  /// Hands the text to the page; whether the channel was open shows in `onState`, so this reports only that it went.
  func send(_ peer: String, _ text: String) -> Bool {
    page.call("send(id, text)", ["id": key(peer), "text": text])
    return true
  }

  func close(_ peer: String) { page.call("close(id)", ["id": key(peer)]) }

  /// A message from the page about one of this transport's peers.
  func heard(_ peer: String, _ m: [String: Any]) {
    switch m["kind"] as? String {
    case "candidate":
      let c = (m["candidate"] as? [String: Any]).flatMap { c in
        (c["candidate"] as? String).map { IceCandidate(candidate: $0, mid: c["mid"] as? String, index: (c["index"] as? NSNumber)?.intValue) }
      }
      onCandidate?(peer, c)
    case "state":
      if let s = (m["state"] as? String).flatMap(PeerState.init) { onState?(peer, s) }
    case "message":
      if let t = m["text"] as? String { onMessage?(peer, t) }
    default:
      break
    }
  }
}

/// The hidden page that runs every peer connection, loaded once; calls made before it loads wait for it.
@MainActor final class PeerPage: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  static let shared = PeerPage()
  private let web: WKWebView
  private var loaded = false
  private var waiting: [() -> Void] = []
  private var transports: [String: () -> WebPeerTransport?] = [:]

  private override init() {
    let config = WKWebViewConfiguration()
    // Breezy is rarely the active app while two screens sit side by side
    config.preferences.inactiveSchedulingPolicy = .none
    web = WKWebView(frame: .zero, configuration: config)
    super.init()
    // the web view copied its configuration, but shares its content controller
    web.configuration.userContentController.add(self, name: "peer")
    web.navigationDelegate = self
    let url = Bundle.main.url(forResource: "peer", withExtension: "html")!
    // the load Task 15 chose; this is (a)
    web.loadHTMLString(try! String(contentsOf: url, encoding: .utf8), baseURL: URL(string: "https://peer.breezy.invalid/"))
  }

  func register(_ t: WebPeerTransport) { transports[t.prefix] = { [weak t] in t } }

  func call(_ js: String, _ args: [String: Any], _ done: (@MainActor (Any?) -> Void)? = nil) {
    guard loaded else { return waiting.append { [weak self] in self?.call(js, args, done) } }
    web.callAsyncJavaScript(js, arguments: args, in: nil, in: .page) { result in
      MainActor.assumeIsolated { done?(try? result.get()) }
    }
  }

  nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    MainActor.assumeIsolated {
      loaded = true
      let w = waiting
      waiting = []
      w.forEach { $0() }
    }
  }

  nonisolated func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    MainActor.assumeIsolated {
      guard let m = message.body as? [String: Any], let id = m["id"] as? String, let space = id.firstIndex(of: " ") else { return }
      let prefix = String(id[...space])
      guard let t = transports[prefix]?() else { return transports[prefix] = nil }
      t.heard(String(id[id.index(after: space)...]), m)
    }
  }
}
```

If Task 15 chose (b) or (c), replace the `loadHTMLString` line with that load.

- [ ] **Step 3: Give the library the transport**

`Library.swift:23`: `spaces = try Spaces(directory: directory, me: Self.me(), peerTransport: { WebPeerTransport() })`.

- [ ] **Step 4: Build and run the tests**

Run: `xcodegen generate && xcodebuild -project Breezy.xcodeproj -scheme Breezy -configuration Debug -derivedDataPath build build 2>&1 | tail -1 && swift test --package-path BreezyKit`
Expected: `** BUILD SUCCEEDED **`, tests pass. Check `build/Build/Products/Debug/Breezy.app/Contents/Resources/peer.html` exists.

- [ ] **Step 5: By hand, Mac and Safari**

With the local servers from Task 5, the Mac app on a scratch library and a Safari window in one space: within a few seconds the Breezy menu's status lines say "<space> — Direct with 1 of 1 person", and Safari's ⋯ menu says the same. Move the pointer in Safari: the Mac's copy keeps up. Close the Safari window: the Mac's line goes away.

- [ ] **Step 6: Commit**

```bash
git add Breezy/Live/peer.html Breezy/Live/WebPeerTransport.swift Breezy/Library/Library.swift
git commit --message "Open direct channels from the Mac through WebRTC in a hidden web view"
```

### Task 17: Measure by hand and open the Phase 3 PR

- [ ] **Step 1: Film**

The Mac and the phone (the deployed web app, or the local one if Task 14 Step 2 worked over http) in one space on one Wi-Fi, side by side. Ask the user to film both screens with an iPhone at 240 fps slow motion while one moves a cursor or drags a card in steady strokes. Count frames between the real cursor and its remote copy at ten points.

Success: median ≤ 12 frames (50 ms at 240 fps) and no repeated positions during steady motion, both directions. Record the numbers in the PR.

- [ ] **Step 2: Network change**

Mid-drag on the phone, switch it from Wi-Fi to mobile data: the hold is released on the Mac within 10 s, and the phone comes back, direct or through the relay (its status line says which).

- [ ] **Step 3: Full verification**

Run: `node --test web/test/*.test.js && swift test --package-path BreezyKit && node scripts/direct-e2e.mjs`
Expected: all pass.

- [ ] **Step 4: Ask the user, then push and open the PR**

PR text: what changed, the measured frames, the spike's numbers. No session links.
