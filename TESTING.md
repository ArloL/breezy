# Testing

Bugs used to reach the owner first, by hand, some long after they were made. Here each kind of bug Breezy has had is a class, each class has levels that own it, and a level owns a class only once it is shown to fail on a bug of that class planted on purpose. `docs/escapes.md` counts what still gets through. The design behind this is `docs/superpowers/specs/2026-10-25-breezy-testing-strategy-design.md`.

## The quality goals, and what measures each

`docs/quality-goals.md` sets the goals; this is what holds each scenario today. A gap is a goal nothing fails for.

| Goal | Measured by | Gap |
|---|---|---|
| 1a first use from the invite | — | everything: install, join and open are run by the scenarios' harness, not as she would |
| 1b touch: drag, pan, pinch | the touch cases on the hub's phone, Chrome and Firefox on the Android emulator, and the iPhone; `lost-release` (L1) | whether a gesture surprises her |
| 1c writing: the keyboard never covers the line | the sight check after every step (B1), on the hub's iPhone and Android, each held to its phone by `scenarios/phone-contract.e2e.ts`, and on the emulator and the iPhone; Android keyboards' platform rows (L5, L6) | her keyboard through DevTools in the cases, not Android's own |
| 1d finding my new card ≤ 10 s | — | everything |
| 1e updates never interrupt an edit | `web/test/update.test.ts`, `web/test/owner.test.ts` (L1) | no case on a device |
| 2a drag, p95 frame ≤ 16.7 ms on Android | `scripts/bench.sh`, on the Mac | Android |
| 2b key to glyph ≤ 50 ms on Android | `scripts/feel.ts`, in desktop Chromium | Android |
| 2c launch ≤ 1.5 s | `scripts/launch.ts` nightly: a warm launch of a 500-card board in Chromium at a phone's size with its CPU slowed 4×, at most 1.5 s and no worse than the reference build; `uncached-heights` (L7) | the iPhone's and Android's own launch |
| 2d no measure worse than its baseline | `scripts/gate.ts` nightly | a plant shows it for launch alone (L7) |
| 3a both offline edits shown ≤ 10 s after | the offline case on real devices; the fuzzer's partitions | the Mac offline; the 10 s |
| 3b both edits to a card survive | the fuzzer's merge probes; `merge-local` (L1, L4) | |
| 3c fuzzer seeds and scenarios pass | Main | |
| 4a my card shows ≤ 5 s after her launch | the case "a card made while the other device was away shows on it within 5 s of its launch", on the browsers and Android | an hour away, as offline stands in for it; no plant shows it fails |
| 4b boards open and edit offline | the offline case on real devices; `no-snapshot` (L6) | the iPhone cannot go offline here |
| 4c sync.php or the relay down | the case "a card dragged into a lane while the servers are down…" on real devices, the iPhone among them, which stops both; the fuzzer's faults: captive portals, relay restarts | the Mac acting in it, as the case drags by touch; no plant shows it fails |

## Bug classes

Drawn from the fixes in Breezy's history; `docs/escapes.md` lists them by class.

| # | Class | Why it is quiet |
|---|---|---|
| B1 | **Out of sight**: what was just made, edited, found or selected is not on screen, or the keyboard covers it | the data is right; only eyes catch it |
| B2 | **Platform input mangled**: an input method, emoji, autocorrect, paste or focus leaving ends or corrupts an edit | one platform, one keyboard |
| B3 | **Gesture misread**: a tap, hold, drag or pinch does the wrong thing, or a stale one acts later | timing and load dependent |
| B4 | **Edit lost or undone across devices** | shows later, elsewhere |
| B5 | **Board won't open, or opens stale**: storage, service worker, second tab, update | only after the browser froze, cleared or updated something |
| B6 | **Feel regressed**: frames, key-to-glyph, launch | nothing fails; it gets worse |
| B7 | **Deploy broke production** | nobody sees it until they open the app |
| B8 | **Visual glitch**: flicker, cross-fade, wrong weight or ring | pixels only |

## Levels

| Level | What | Runs | Owns |
|---|---|---|---|
| L1 Core units | `web/test`, `BreezyKit/Tests`, `relay/test`, `server/test` | push | B3 rules, B4 merge and codecs, B5 store logic |
| L2 Conformance and contracts | `scenarios/conformance.test.ts`: the Swift and the web core play the same gestures to the same scene; `scenarios/contracts/field.ts`: the hub's field and each browser's keep one contract; `scenarios/phone-contract.e2e.ts`: the hub's phone measured against the iPhone's Home Screen app, by hand | push | honesty of the Swift mirror and of fakes |
| L3 Hub cases on fakes | `scenarios/cases.test.ts`: `scenarios/cases.ts` on the fuzzer's virtual time | push | B1, B3, B4 across devices |
| L4 Convergence fuzzer | `scripts/fuzz.ts`: seeds 1–10 on push, 120 new nightly | push, nightly | B4, B5's sync side |
| L5 Platform replays | `scenarios/platform/`: recorded traces replayed into each browser | push | B2 |
| L6 Real devices | `scenarios/browsers.e2e.ts`: Chromium, WebKit, Firefox, the Mac app, Chrome and Firefox on the Android emulator on push; Safari on the iOS Simulator, as an iPhone 17 and as the owner's iPhone 13 mini, acting with one finger and iOS's own keyboard through idb (`scripts/sim-hid.py`) and read through an agent in its page (`scenarios/agent.ts`), nightly in `.github/workflows/nightly.yaml`; and as the app added to the Home Screen (`ios-home`, added by `node scripts/ios.ts --home`), nightly too, on an iPhone 17 on iOS 27, whose share sheet's buttons it taps by where they are. The iPhone skips cases with two fingers, going offline or a busy phone, and those a case marks `notOnIphone` | push, nightly | B1, B2, B3, B5 as each platform really does them |
| L7 Long runs and measures | `scripts/feel.ts`, `scripts/launch.ts`, `scripts/bench.sh` and `scripts/gate.ts` nightly; `scripts/ios-chaos.ts` and `scripts/selftest.sh` by hand | nightly, by hand | B3 under load, B5 through the page's lifecycle, B6, B8 |
| L8 Production | `scripts/deploy.py`'s check of the site and `scripts/relay-check.ts`, after each deploy in `.github/workflows/main.yaml` | each deploy | B7 |
| Hand | the owner | always | whatever escapes, logged in `docs/escapes.md` |

`docs/superpowers/specs/2026-10-11-breezy-testability-design.md` says how scenarios drive every kind of device, `docs/platform-expectations.md` which platform input is tested where, and `docs/quality-goals.md` what all of it protects.

## Two jobs

The checks on every push guard: they block merging and must be red only for a bug. The nightly runs discover: they find what the fakes do not know yet. A flaky run is a bug of its level, fixed before new features. Main still gives a failing real-device case a second run and only warns when it then passes.

A case failing often on a pair can be put in `scenarios/quarantine.ts` by hand, with why and since when, until it is fixed: Main skips it there. `scripts/test/discipline.test.ts` keeps the cases to conditions rather than fixed waits, each wait they keep listed with why, and to driving devices only through `scenarios/device.ts`.

## How each level is proven

| Level | Proven by | Runs |
|---|---|---|
| L1 | plants (`scripts/plants.ts`), and a mutation score per module of the web core and of BreezyKit held to its floor in `scripts/mutation-floors.json` (`scripts/mutate.ts`, which keeps the survivors under build/mutation) | weekly, `.github/workflows/plants.yaml` and `.github/workflows/mutation.yaml` |
| L2 | the hub's field drifted on purpose, its keys telling the app nothing, fails its contract (`scenarios/field-contract.test.ts`) | push |
| L3, L4 | plants | weekly, `.github/workflows/plants.yaml` |
| L6 | plants, in Chromium | nightly, `.github/workflows/nightly.yaml` |
| L5 | not yet: `ime-keys` survives it | |
| L8 | `scripts/deploy-check.ts` runs the checks after a deploy against the site as built, served here with PHP; plants | weekly |
| L7 | the launch measure in turns with the same build unplanted (`uncached-heights`); feel and bench not yet | nightly, `.github/workflows/nightly.yaml` |

## Matrix

| Class | L1 | L2 | L3 | L4 | L5 | L6 | L7 | L8 |
|---|---|---|---|---|---|---|---|---|
| B1 | — | — | plant: reveal-current | — | — | claimed | — | — |
| B2 | plant: ime-keys | — | — | — | claimed | claimed | — | — |
| B3 | plant: lost-release | claimed | claimed | — | — | claimed | claimed | — |
| B4 | plant: merge-local | — | claimed | plant: pushed-skip, merge-local | — | claimed | — | — |
| B5 | plant: half-deploy | — | — | claimed | — | plant: no-snapshot | claimed | — |
| B6 | — | — | — | — | — | — | plant: uncached-heights | — |
| B7 | — | — | — | — | — | — | — | plant: half-uploaded |
| B8 | — | — | — | — | — | — | claimed | — |

A cell is owned only when it names a plant that `node scripts/plants.ts` shows the level failing on, and passing without (`order-all`, planted for the fuzzer, is not run there yet). `lost-release` puts back the half of `b3003b1` that a press ends a drag left open; the other half, a move with the button up, stays. `ime-keys` survives the replays (L5): their traces carry Esc and Enter only as Firefox on the Mac sends them while composing, as Process keys, and the bug it puts back was Chrome's and Safari's. `reveal-current` fails the iPhone in this Mac's simulator, but not on CI's, whose keyboard comes late enough to reveal the card again, nor in Chromium, so B1's L6 cell is claimed. `claimed` means the level has tests for the class but nothing shows they fail on it; `—` that it has none. B1 is checked after every step of every case (`scenarios/sight.ts`): once the board stands still, the card being edited shows whole, or of one too tall to, its caret's line. Search matches and selections are not checked yet, and the Mac reads its whole view as the board's.

## When a bug escapes

A bug found by hand, or by a nightly run, is fixed with:

1. a test at the lowest level that shows it;
2. if a fake was wrong, the fake taught;
3. a row in `docs/escapes.md`.

## Adding a plant

A plant is a past bug put back by name where it was fixed: `planted("name")` (`web/sync/plant.ts`, `BreezyKit/Sources/BreezyKit/Plant.swift`). `BREEZY_PLANT` sets it for Node, the hub's devices and the replays' pages, `SCENARIO_PLANT` for real devices once their board is open, and for their service worker, as the scenarios' server serves it. Add the plant, a row in `scripts/plants.ts` with the run of each level it proves, and the plant's name in those cells above; `node scripts/plants.ts` requires each run to pass without it and fail with it, weekly in `.github/workflows/plants.yaml`.
