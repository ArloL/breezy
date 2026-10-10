# Convergence fuzzing — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `node scripts/fuzz.mjs --seeds 1-50` drives web and Swift devices against the real `sync.php`, the real relay Worker and simulated direct channels over simulated networks, and fails with a replayable, shrunk trace when they do not converge.

**Architecture:** a Node hub runs a discrete-event simulation on virtual time. Web devices run in the hub's process with its timers, clock and `fetch` replaced, each device's work tagged through `AsyncLocalStorage`. Swift devices run in `breezy-sim`, a BreezyKit executable, which speaks JSON lines with the hub. The relay is `relay/src/worker.js`'s `Space`, run under a shim of the Durable Object API. The glue between engine, `Live`, holds and gestures moves into `Collab` in both languages, so that the fuzzer drives what the apps run.

**Tech stack:** Node 24 (`node:test`, `node:sqlite`, `AsyncLocalStorage`, `module.register`), Swift 6.4 / Swift Testing, PHP 8 built-in server on SQLite.

**Spec:** `docs/superpowers/specs/2026-10-10-breezy-convergence-fuzzing-design.md`

## Global constraints

- Production behaviour does not change: every seam defaults to what the apps do now.
- House style: comments state the current design, briefly; no change history in comments.
- Web code is plain ES modules without dependencies; Swift code builds with `swift build --package-path BreezyKit` and passes `swift test --package-path BreezyKit`.
- `node --test web/test/*.test.js`, `swift test --package-path BreezyKit`, `server/test.sh` and `relay/test.sh` pass after every task.
- Times on the wire between hub and sim are ms of virtual time as numbers; bytes are base64url.

## Review focus

1. A web or Swift device that never goes idle (a timer that re-arms at the same instant, a promise loop) must make the hub fail with "device N did not settle" rather than hang.
2. The same seed run twice gives the same trace hash; a nondeterministic source (wall clock, `Math.random`, real timers, thread pool order) shows up as a determinism test failure, not as flaky fuzz results.
3. A Swift task cancelled while its request is with the hub (engine `retryNow(changed:)`) gets `URLError(.cancelled)` and the hub drops the request's answer.
4. Healing must end gestures and thaw devices before checks, else a check fails on a hold that a frozen device still legitimately has.
5. Server state between seeds: each run gets a fresh SQLite database; a restored backup changes only that run's database.

## Wire protocol (hub ↔ device)

Both device kinds implement `command(c) → {out, next, reply?}` — the web adapter in-process, `breezy-sim` over stdin/stdout, one JSON object per line, answering each command once its devices are idle. `next` is `{dev: ms | null}`, each device's earliest timer. `out` lists what devices emitted while handling the command, in order.

Commands (`dev` is a device index):

| `cmd` | Fields | Effect |
|---|---|---|
| `new` | `dev`, `me: {device, name}`, `seed` | a device with no spaces; its ids come from `seed` |
| `time` | `t`, `skew: {dev: ms}` | virtual time is now `t`; a device's wall clock reads `t + skew[dev]`; nothing fires |
| `fire` | `dev` | runs the device's timers due at `t`, earliest first, including ones they schedule for no later than `t` |
| `op` | `dev`, `op` | an operation (below); `reply` carries its result |
| `http` | `dev`, `req`, `status`, `body` (b64) or `error: "offline" \| "unreachable"` | a request's answer |
| `ws-open` / `ws-msg` / `ws-close` | `dev`, `sock`, `text` or `bytes`, `code` | socket events |
| `peer-done` | `dev`, `call`, `value` | answers `offer`, `answer` (`value`: sdp or null) or `accept` (`value`: bool) |
| `peer-state` / `peer-msg` / `peer-candidate` | `dev`, `peer`, `state` / `text` or `bytes` / `candidate` | channel events |
| `state` | `dev` | `reply`: the device's snapshot (below) |

Events in `out`:

| `ev` | Fields |
|---|---|
| `http` | `dev`, `req`, `method`, `url`, `headers`, `body` (b64 or null) |
| `http-cancel` | `dev`, `req` |
| `ws-connect` / `ws-send` / `ws-close` | `dev`, `sock`, `url` / `text` or `bytes` |
| `peer-create` / `peer-offer` / `peer-answer` / `peer-accept` / `peer-add` / `peer-send` / `peer-close` | `dev`, `peer`, and `restart`, `sdp`, `call`, `candidate`, `text` or `bytes` as each needs |

Operations (`op.op`); an item is chosen as `sorted(ids)[n % count]` on the device's open board, so both languages pick the same:

| `op` | Fields | Does |
|---|---|---|
| `newSpace` | `server`, `name` | `spaces.newSpace`; `reply: {invite}` (the invite link) |
| `join` | `invite` | `spaces.join(Invite(link))` |
| `createBoard` | `title` | creates a board in the device's space; `reply: {board}` |
| `open` | `board` (id or null) | opens the board (one at a time): model, binding with a fixed height function, `Collab` session; null closes it |
| `show` | `visible` | `live.connect()` / `live.close()` and presence, as the apps do on visibility |
| `addCard` / `addLane` | `x`, `y` | `model.perform` |
| `color` | `n`, `count`, `color` | recolours `count` cards from item `n` on |
| `delete` | `n`, `count` | deletes `count` cards from item `n` on |
| `type` | `n`, `text` | press (hold) card `n`, `begin`, `update(setText)`, `end`, as an edit session |
| `press` | `n`, `count`, `lane` (bool) | holds `count` cards from item `n` on (or lane `n` and its cards) and begins a gesture |
| `drag` | `dx`, `dy` | `model.update(moveCards / moveLane)` from the gesture's start |
| `release` / `cancel` | | `model.end` / `model.cancel` |
| `undo` / `redo` | | the model's undo manager |
| `retry` | `changed` | `spaces.retryAll(changed)` |
| `resync` | | `engine.reset()` then `sync()` |

A device also keeps two timers of its own, as the apps do: `collab.tick()` every 1 s and `spaces.syncAll(polling: true)` every 5 s.

Snapshot (`state` reply), canonical so that web and Swift compare equal:

```json
{ "boards": {"<id>": {"title": "…", "cards": [{"id","x","y","w","text","notes","color"}], "lanes": [{"id","x","y","w","h","title"}]}},
  "pending": 0, "overlays": {"<board>": 0}, "mine": 0, "connected": true, "seen": ["<device id>"], "status": "synced" }
```

`cards` and `lanes` are in the store's order; `notes` and `title` are `""` when absent; numbers as the store has them.

---

### Task 1: `Collab` in both languages (subagent A)

**Files:**
- Create: `web/sync/collab.js`, `web/test/collab.test.js`, `BreezyKit/Sources/BreezyKit/Collab.swift`, `BreezyKit/Tests/BreezyKitTests/CollabTests.swift`
- Modify: `web/library.js` (glue at about lines 100–320 goes to `Collab`), `Breezy/Library/Library.swift` (about lines 25–60 and 160–215)

**Interfaces (produces):**

```js
// web/sync/collab.js
export class Collab {
  constructor(group, holds)            // group: a Spaces group (store, engine, live getter, space); holds: GestureHolds
  get busy()                           // a session's model is in a gesture
  open(id, model, binding, { caret = () => null, items } = {})  // → Session; items(start, board, mine, id) defaults to liveFields
  tick()                               // live.tick(), then holds.sweep for the group's space
}
// Session: hold(ids), edited() — after every model change, after binding.changed() — and close()
```

```swift
@MainActor public final class Collab {
  public init(group: Spaces.Group, holds: GestureHolds)
  public var busy: Bool { get }
  public func open(_ id: String, model: BoardModel, binding: BoardBinding, caret: @escaping () -> Caret? = { nil }) -> Session
  public func tick()
  @MainActor public final class Session { public func hold(_ ids: Set<String>); public func edited(); public func ended(); public func close() }
}
```

`Collab` sets `group.engine.holdBack` to: busy, the live layer connected, and it holds something. The Swift `Session` installs itself as `binding.afterEdit` and `binding.afterGesture`; the web app calls `session.edited()` from `model.onChange`, and `edited()` notices a gesture's end itself. Both follow one behaviour; where `library.js` and `Library.swift` differ today (`unfinished`/`gesturing` vs `afterGesture`), keep the web's rule that an edit ending no held gesture is an edit outside a gesture, and document the choice in both files' header comment.

- [ ] **Step 1:** Write mirrored tests, the same cases in `collab.test.js` and `CollabTests.swift`, on the existing fakes (`web/test/helpers/fake-relay.js`, `LiveFakes.swift`, `SyncFakes.swift`):
  - a recolour outside a gesture flushes, pushes at once and sends one `sendEdit` keyframe when the push goes now, and none behind a back-off;
  - a press holds; moves send `live` bodies; nothing is pushed until the end; the end flushes, pushes, then releases;
  - a gesture's end while another started on the same space does not release;
  - `tick` releases holds that no gesture or finish explains, on the second idle tick;
  - `holdBack` is true only during a gesture with the relay connected and something held.
- [ ] **Step 2:** Run them: `node --test web/test/collab.test.js` and `swift test --package-path BreezyKit --filter CollabTests`; expect failures for the missing types.
- [ ] **Step 3:** Implement `Collab` in both languages from the glue in `library.js` and `Library.swift`.
- [ ] **Step 4:** Make `library.js` and `Library.swift` use it, keeping only visibility, drawing and windows; the web app keeps `floated(...)` through `items`.
- [ ] **Step 5:** Run all suites: `node --test web/test/*.test.js`, `swift test --package-path BreezyKit`, and build the app: `xcodegen generate && xcodebuild -project Breezy.xcodeproj -scheme Breezy -derivedDataPath build build`.
- [ ] **Step 6:** Commit: "Move the glue between sync, the live layer and gestures into Collab, which the apps share with the fuzzer".

### Task 2: Swift seams and `breezy-sim` (subagent B)

**Files:**
- Modify: `BreezyKit/Package.swift` (executable target `breezy-sim`), `BreezyKit/Sources/BreezyKit/Spaces.swift` (`now`, `uptime`, `schedule` passed to every engine and `Live`), `Sync.swift` (`SyncEngine` takes `schedule` for `changed()`; `HTTPTransport` takes `send: (URLRequest) async throws -> (Data, URLResponse)`), `BoardBinding.swift` (`schedule` for its 0.3 s write-back and the gesture end's next turn), `Model.swift` (`newID` draws from a replaceable source)
- Create: `BreezyKit/Sources/breezy-sim/main.swift` and files beside it: `Host.swift` (command loop, idle detection), `SimDevice.swift`, `SimTransport.swift` (HTTP via `send`), `SimSocket.swift` (`LiveSocket`), `SimPeer.swift` (`PeerTransport`), `Snapshot.swift`
- Test: `BreezyKit/Tests/BreezyKitTests/SimHostTests.swift` (the host in-process, driven by scripted commands)

**Interfaces:** the wire protocol above; Swift devices are `Spaces` in a temporary directory each, with `Collab` from Task 1.

- [ ] **Step 1 (spike, gate):** idle detection and determinism. The host runs everything on the main actor; after a command it yields (`await Task.yield()`) in rounds until a round changes nothing — no event emitted, no timer added, no task woken — with a cap of 10,000 yields, past which it answers `{error: "did not settle"}`. Test: a script of `new`, `op newSpace`, then answering the device's HTTP requests from canned server replies, run twice in-process, gives byte-identical `out` streams. If yielding cannot settle reliably, count work instead: every `Task` the sim starts goes through a counter, and the host waits until all are suspended on the hub. Record which one was used in `Host.swift`'s header comment.
- [ ] **Step 2:** Seams with defaults (no behaviour change; existing tests pass untouched).
- [ ] **Step 3:** Proxies: `SimTransport` emits `http` with the request `HTTPTransport` built, waits for the `http` command, applies URLSession's 20 s `timeoutInterval` on virtual time (`URLError(.timedOut)`), and turns cancellation into `URLError(.cancelled)` plus an `http-cancel` event. `SimSocket` and `SimPeer` map the protocol one to one.
- [ ] **Step 4:** Operations and the snapshot, per the tables above (operations needing `Collab` once Task 1 is merged into this branch).
- [ ] **Step 5:** `swift build --package-path BreezyKit --product breezy-sim` and the tests pass; commit "Add breezy-sim, which runs Swift devices for the fuzzer on virtual time".

### Task 3: the hub (main session)

**Files:**
- Create: `scripts/fuzz.mjs` (CLI), `scripts/fuzz/hub.mjs` (event loop, scheduler, heal, checks), `scripts/fuzz/web-device.mjs` (in-process adapter), `scripts/fuzz/swift-devices.mjs` (child process adapter), `scripts/fuzz/virtual.mjs` (timers, clock, `AsyncLocalStorage`, patched crypto counting), `scripts/fuzz/relay.mjs` + `scripts/fuzz/cloudflare-shim.mjs` + `scripts/fuzz/loader.mjs` (the Worker's `Space` under a Durable Object shim), `scripts/fuzz/server.mjs` (`php -S` on a fresh SQLite database; backup and restore with `node:sqlite`), `scripts/fuzz/links.mjs` (link states and profiles), `scripts/fuzz/direct.mjs` (simulated channels), `scripts/fuzz/rng.mjs`
- Test: `scripts/fuzz/test/*.test.mjs`

- [ ] **Step 1:** `rng.mjs` (SplitMix64 as `SyncTests.swift` has it) and `virtual.mjs`: `setTimeout`, `clearTimeout`, `setInterval`, `Date.now`, `performance.now` and `crypto.getRandomValues` replaced for code running under a device's context; hub code keeps the originals. Test: timers fire in virtual order; a device's `Date.now` includes its skew.
- [ ] **Step 2:** `relay.mjs`: the Worker's `Space` loaded through a loader hook that maps `cloudflare:workers` to the shim; sockets stay in `getWebSockets()` after a server-side close until the device's close reaches the relay; `"ping"` answers `"pong"` without the object; alarms run on virtual time; `restart()` keeps attachments and storage and makes a new `Space`. Test: two sockets auth, a `replaces` drops the old one with its holds, and holds lapse after 10 s of silence.
- [ ] **Step 3:** `server.mjs`: forwards a device's request to `php -S` with `node:http` when the hub delivers it; `backup()` and `restore()` copy the database and give its spaces a new epoch. Test: a pull from a new space answers 200.
- [ ] **Step 4:** `web-device.mjs`: a web device is `Spaces` with in-memory storage, `transport` default (`HttpTransport` over the replaced `fetch`), `socket` and `peerTransport` proxies, a `Model`, `Binding` and `Collab`; it implements the same commands and snapshot as `breezy-sim`. Idle: rounds of `setImmediate` until no crypto call is pending and a round changes nothing.
- [ ] **Step 5:** `links.mjs` and `direct.mjs`: per device and destination (server, relay, each peer) a link with the spec's states and profiles; delivery times by state; order kept per connection; channels unordered and lossy. A channel opens once the offerer has accepted the answer and the link between the two is up.
- [ ] **Step 6:** `hub.mjs`: the loop — pick among due events with the seeded scheduler, operations and faults by weight; healing; checks; per-run timing of recovery after a tunnel for `--profile train`. Test: a 2-web-device run of 200 steps converges, and the same seed twice gives the same trace hash.
- [ ] **Step 7:** `swift-devices.mjs` once Task 2 lands; test: one web and one Swift device converge, deterministically.
- [ ] **Step 8:** Faults and operations from the spec's tables, each with a hub test that it happens and the run still converges.
- [ ] **Step 9:** Failure output to `build/fuzz/<seed>.json`, `--replay`, and shrinking by delta debugging over the trace's operations and faults. Test: a planted bug shrinks to at most 20 trace entries.
- [ ] **Step 10:** `--plant merge-local|pushed-any|no-replaces` through `globalThis.__breezyPlant` (web) and the `BREEZY_PLANT` environment variable (Swift), read only where the bug goes; a test runs each with the per-PR budget and expects a failure.
- [ ] **Step 11:** README: the command beside the others in Develop and Sync; commit.

### Task 4: run, fix, measure (main session)

- [ ] Run `--seeds 1-200` per profile; for each failure: replay, shrink, find the cause with superpowers:systematic-debugging, write a unit test in the owning language(s) that fails, fix, re-run the seed.
- [ ] Report: seeds and steps run per profile, failures found and fixed, recovery times after tunnels as 95 % CIs.
- [ ] Whole-branch review by a fresh reviewer; push; open a PR.
