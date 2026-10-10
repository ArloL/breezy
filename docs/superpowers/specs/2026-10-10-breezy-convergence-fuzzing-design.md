# Breezy convergence fuzzing — design

Mac and web devices that edit one board through flaky networks end with the same board, and nothing left on anyone's screen that the store does not hold. A seeded simulation drives both engines against the real `sync.php`, with the relay, direct channels and every network in between under its control; a failing seed replays exactly and shrinks to a short trace.

Each language already has a "four devices end the same" test: one seed, its own devices only, an in-memory server, and only going offline and resets as faults. Nothing makes a Mac's records meet the web's merge, loses a response after the server committed, or exercises `pushed`, overlays and direct channels under faults.

## Done

`node scripts/fuzz.mjs --seeds 1-50` passes, and finds each planted bug (see Checking the fuzzer) within the per-PR budget of under 2 minutes. Running it in CI belongs to the CI gates work.

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

Seams, each defaulting to what the apps do now:

| Seam | Where |
|---|---|
| `schedule` and `now` | the engine's `soon` timer, `BoardBinding`'s write-back, the web `Saver`; `Live` takes them already |
| `spawn` | tasks that `Collab` and `Spaces` start, such as `Task { await engine.sync() }` |
| `newID` | seeded; nonces stay random, as no decision depends on them |

`breezy-sim` hosts any number of Swift devices, each a `Store`, `SyncEngine`, `Live` with `Direct`, `BoardModel`, `BoardBinding` and `Collab`, with transports that forward to the hub. These proxies replace `HTTPTransport` and the web's `HttpTransport`, so those classes' own stall timers are not fuzzed; the hub's stalls exercise how the engines answer one.

## Operations

4 devices by default, 2 web and 2 Swift (`--web N --swift N`). One makes the space; the others join at random times, some after edits exist. Operations, with seeded weights, go through `BoardModel`, the binding and `Collab` as the apps do:

- add, type into, recolour or delete a card; add or move a lane;
- undo and redo;
- a drag: press (holds), moves over virtual time, then release or cancel;
- show or hide the app, which connects or closes `Live`;
- a full resync.

## Networks

Each device has its own link to the server, the relay and each peer. A seeded state machine moves each link between states over virtual time:

| State | Latency each way | Loss | The device is told |
|---|---|---|---|
| good | 20–60 ms | none | — |
| degraded | 150 ms – 3 s, heavy-tailed | 2–10 %, as stalls | — |
| tunnel | nothing for 5–90 s | all | an offline event, or nothing |
| handover | — | open sockets go half-open; new ones take the new path | a network change, or nothing |
| upstream dead | requests hang | all | nothing: the link is up |
| flapping | handovers every 0.2–2 s for a while | — | a burst of network changes |

`--profile lan|office|train|tether|mixed` sets the rates between states; `mixed` gives each device its own, so someone on a train edits with someone in an office. HTTP requests and WebSocket frames keep their order within a connection, as TCP does; direct channels are unordered and lossy, as their `maxRetransmits: 0` channel is. A slow link delays a request by its size, so the stall rule of 5 s plus 1 ms per 20 bytes is met.

Faults, at low weights, on top: a response lost after the server committed; a 5xx; a 401; the relay dropping a connection; a direct channel closing mid-gesture or failing to open; a database restored from a backup with a new epoch (rare; `--no-restore` turns it off).

## Checks

After `--steps`, the hub heals: no more operations or faults, every link good, every device online and showing, gestures ended. It runs the clock until every device is idle with no timer due within 35 s, past `GONE_MS`. Then:

- every device's boards are equal, compared in a canonical order;
- nothing is pending;
- every board's overlay is empty;
- the relay holds nothing, and every device's `mine` is empty;
- every device sees each other one present.

With `--profile train`, the hub also reports how long after a tunnel ends each device takes to have every other's edits, as a 95 % CI per run.

## Failures

A failing run writes its seed, its trace of operations, faults and link changes, and the first difference to `build/fuzz/<seed>.json`, shrinks the trace by delta debugging while it still fails, and prints `node scripts/fuzz.mjs --replay build/fuzz/<seed>.json`.

## Checking the fuzzer

`--plant NAME` turns on a bug through a test-only switch in both engines, which nothing else reads:

| Name | Bug |
|---|---|
| `merge-local` | a merge takes the local side of every field |
| `pushed-any` | any `pushed` drops a preview, whatever its `seq` |
| `no-replaces` | `auth` leaves out `replaces` |

A test runs each with the per-PR budget and fails unless the fuzzer finds it.

## Not done

| Idea | Why not |
|---|---|
| Checking that nothing typed is lost | The oracle must tell an overwrite after a sync from a lost edit; a project of its own |
| Real Chromium, the Mac app, `wrangler dev` and WebRTC under the fuzzer | Not deterministic: a failure could not be replayed or shrunk; `direct-e2e.mjs` covers the real stack |
| A fake server for speed | It would fuzz the fake; `sync.php` on SQLite is fast enough for the budgets |
