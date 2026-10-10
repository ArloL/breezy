# Breezy convergence fuzzing — design

Mac and web devices that edit one board through flaky networks end with the same board, and nothing left on anyone's screen that the store does not hold. A seeded simulation drives both engines against the real `sync.php`, with the relay, direct channels and every network in between under its control; a failing seed replays exactly and shrinks to a short trace.

Each language already has a "four devices end the same" test: one seed, its own devices only, an in-memory server, and only going offline and resets as faults. Nothing makes a Mac's records meet the web's merge, loses a response after the server committed, or exercises `pushed`, overlays and direct channels under faults.

## Done

`node scripts/fuzz.mjs --seeds 1-50` passes, and finds a planted bug (see Checking the fuzzer) within the per-PR budget of under 2 minutes. Running it in CI belongs to the CI gates work.

## Shape

```
            scripts/fuzz.mjs  (hub: seed, virtual clock, links, scheduler, faults, checks)
           /        |            \                       \
   sync.php     relay sim       direct sim          web devices, in-process
 (php -S, SQLite) (fake-relay.js:  (PeerTransport      Swift devices in breezy-sim, a BreezyKit
                  real holds.js,    pairs)               executable: JSON lines over stdin/stdout
                  frames.js)
```

The hub is a discrete-event simulation. Every message between a device and the server, the relay or a peer goes through the hub, which delivers it at a time its link gives it; among events due at once, the seeded scheduler picks one: deliver a message, fire a device's timer, run an operation, or inject a fault. Time is virtual: devices read the hub's clock and schedule every timer through it, so minutes of app time take seconds.

After each event a device reports when it is idle, that is when all its work waits on the hub, with what it sent and its next timer. Web devices share the hub's event loop. Swift devices count their work in flight through an injected `spawn`; how `breezy-sim` tells that it is idle is the plan's first task, a spike, before anything builds on it.

The real Worker runtime and real WebRTC stay with `direct-e2e.mjs`. The server is the real `sync.php` on PHP's built-in server with a throwaway SQLite database, as `server/test.sh` runs it, one per run.

## Devices

`Collab`, in `web/sync/collab.js` and BreezyKit's `Collab.swift`, one per space group, takes the glue between the engine, `Live`, holds and gestures out of `web/library.js` and `Breezy/Library/Library.swift`:

- `holdBack`;
- asking for holds at a press, and sending what the gesture did before it held;
- `sendLive` during a gesture;
- an edit outside a gesture flushed and pushed at once, with `sendEdit` when its push goes now;
- `GestureHolds.finish` at a gesture's end;
- the tick each second with its sweep.

The apps keep visibility, drawing and windows. The two copies differ today (the web follows `gesturing` and `unfinished`, the Mac `afterGesture`); `Collab` has one behaviour with shared tests, and a difference that turns out to matter is fixed there.

Web devices run in the hub's process, whose timers, clocks, random bytes and `fetch` are replaced for code running under a device's context (`AsyncLocalStorage`), so the web code needs no seams. Their `CompressionStream` deflates in place, as zlib's own streams run on a thread pool, which settling cannot see.

Swift seams, each defaulting to what the app does now:

| Seam | Where |
|---|---|
| `now`, `uptime`, `schedule` | `Spaces` passes them to every `SyncEngine` and `Live`; `BoardBinding` takes `schedule` |
| `send` | `HTTPTransport`'s request, so that its own building, timeouts and decoding are fuzzed |
| `Randomness.source` | a task-local that ids, space secrets and nonces draw from when set; only the sim sets it |

`breezy-sim` hosts any number of Swift devices, each `Spaces` in its own directory with a `BoardModel`, `BoardBinding` and `Collab` for its open board, its relay and channels proxied to the hub. Every global-executor job runs on the main actor, in order, so that a device's work replays exactly and the host can tell when it is idle.

## Operations

4 devices by default, 2 web and 2 Swift (`--web N --swift N`). One makes the space; the others join at random times, some after edits exist. Operations, with seeded weights, go through `BoardModel`, the binding and `Collab` as the apps do:

- add, type into, recolour or delete a card; add or move a lane;
- select 50–300 cards and move, recolour or delete them at once, whose live bodies pass the relay's 64 KB limit;
- undo and redo;
- a drag: press (holds), moves over virtual time, then release or cancel;
- show or hide the app, which connects or closes `Live`;
- freeze for 5 s to 8 h, as iOS suspends a web app in the background or a Mac sleeps: nothing reaches the device and none of its timers fire, then everything due fires late at once;
- a full resync.

A run may include a long absence: one device goes offline for days of virtual time while the others make more than `PAGE_SIZE` records, so that it pages through them over its link when it comes back.

## Networks

Each device has its own link to the server, the relay and each peer, and each link changes state on its own: the relay can be reachable while the server is not, or the other way round, and a direct channel can work while both are down. A seeded state machine moves each link between states over virtual time:

| State | Latency each way | Loss | The device is told |
|---|---|---|---|
| good | 20–60 ms | none | — |
| degraded | 150 ms – 3 s, heavy-tailed | 2–10 %, as stalls | — |
| tunnel | nothing for 5–90 s | all | an offline event, or nothing |
| handover | — | open sockets go half-open; new ones take the new path | a network change, or nothing |
| upstream dead | requests hang | all | nothing: the link is up |
| flapping | handovers every 0.2–2 s for a while | — | a burst of network changes |

`--profile lan|office|train|tether|blocked-ws|mixed` sets the rates between states; `blocked-ws` keeps the relay unreachable, as behind a proxy that refuses WebSockets, and `mixed` gives each device its own profile, so someone on a train edits with someone in an office. HTTP requests and WebSocket frames keep their order within a connection, as TCP does; direct channels are unordered and lossy, as their `maxRetransmits: 0` channel is. A slow link delays a request by its size, so the stall rule of 5 s plus 1 ms per 20 bytes is met.

Faults, at low weights, on top:

| Fault | As when |
|---|---|
| a response lost after the server committed | the link went as the answer came back |
| a 5xx | the host struggles |
| a 200 with HTML, a 302, a truncated body, a failure at once | a captive portal or hotel Wi-Fi answers instead of the server; DNS or TLS fails |
| the relay drops a connection | |
| the relay restarts: every socket drops at once, and only what sockets' attachments hold survives | a Durable Object is evicted, or the relay is deployed |
| a direct channel closes mid-gesture, fails to open, or goes silent without closing | the network changes under it, and NAT rebinding leaves ICE to notice after about 30 s |
| a device's wall clock is off by up to minutes, or jumps forward or back | NTP corrects it, or someone sets it; monotonic clocks and timers are unaffected |
| the database is restored from a backup with a new epoch; rare, and `--no-restore` turns it off | |

## Checks

After `--steps`, the hub heals: no more operations or faults, every link good, every device thawed, online and showing, gestures ended. It runs the clock until every device is idle with no timer due within 35 s, past `GONE_MS`. Then:

- every device's boards are equal, compared in a canonical order;
- each open board shows its store's content, but for what stacking sets locally;
- nothing is pending;
- every board's overlay is empty;
- the relay holds nothing, and every device's `mine` is empty;
- every device sees each other one present.

Along the run, every 15 s, no hold may outlive its gesture: a device holding items 120 s after its last gesture, or a relay keeping a connection's holds 45 s after its device let go, fails the run, as holds keep the others from editing. The margins leave a finish its push over a dead network.

The hub reports how long after a tunnel or a dead upstream ends a device takes to sync and to be welcomed by the relay, as 95 % CIs over the run's seeds.

A refused token (401) is no fault here: the device stops syncing until it leaves the space, by design.

## Failures

A failing run writes its seed, its trace of operations, faults and link changes, and the first difference to `build/fuzz/<profile>-<seed>.json`. `--shrink` drops chunks of the trace by delta debugging while a replay still fails the same way, within 60 replays, and `--replay FILE` runs a written trace again. A replay draws network timings afresh, so it reproduces the failure, not every frame.

## Checking the fuzzer

`--plant NAME` turns on a bug through a test-only switch in both engines, which nothing else reads:

| Name | Bug | Found |
|---|---|---|
| `pushed-skip` | records a `pushed` brings are not applied, though the cursor moves past them | on every seed tried |
| `order-all` | order keys follow the model's order against the store's, the bug the fuzzer found first | 1 of 24 seeds with 3 web devices; it needs cards made at once |
| `merge-local` | a merge takes the local side of every field | never: the devices still converge, on the last writer's fields; see Not done |

A test runs `pushed-skip` with the per-PR budget, fails unless the fuzzer finds it, and shrinks the failure to at most 30 entries.

## Not done

| Idea | Why not |
|---|---|
| Checking that nothing typed is lost | The oracle must tell an overwrite after a sync from a lost edit; a project of its own. Until then a merge that drops one side's changes converges and passes, as `merge-local` shows |
| Real Chromium, the Mac app, `wrangler dev` and WebRTC under the fuzzer | Not deterministic: a failure could not be replayed or shrunk; `direct-e2e.mjs` covers the real stack |
| A fake server for speed | It would fuzz the fake; `sync.php` on SQLite is fast enough for the budgets |
| Two tabs of the web app on one device | Not a network fault: each tab loads the state once and saves all of it under the same key, so one can overwrite the other's unpushed edit. It needs a fix of its own, such as one tab holding a Web Lock and the others opening read-only |
