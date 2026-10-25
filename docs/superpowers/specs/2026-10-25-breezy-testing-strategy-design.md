# Breezy testing strategy — design

Bugs reach the owner first, by hand, on the Mac and the iPhone, and some take long to be found: a new card on iOS that the board does not bring into view is the kind this design exists to stop. It gives Breezy what `configurable-containers/TESTING.md` gives that repo: classes of bug drawn from Breezy's own history, levels that each own some of them, a matrix proving none is unowned, and a check on every level that it fails when it should.

## Intent

- **Preventative.** No current fire; the aim is that a bug the owner would notice fails a test first.
- **Two jobs, both stable.** A guard on every push that blocks merging, and a discovery net nightly on real devices that finds what fakes do not know yet. Both are held to a flake budget: a flaky run is a bug of its level, never noise.
- **Every level proven.** A level that cannot be shown to fail on a bug of each class it claims does not count as owning it.
- **Cost is no constraint yet.** The guard takes whatever it takes; it is cut back once quality is high.

Non-goals: replacing the existing levels, a dashboard service, testing on the physical phones in CI.

Anti-goals: a guard that is red for reasons other than a bug; a class "owned" by a level that has never caught a plant of it; real-device work that patches one flake at a time with no rule that stops the next.

## Platforms

| Who | Platform | In `docs/quality-goals.md` |
|---|---|---|
| owner | Mac app | yes |
| owner | Safari on iPhone, Home Screen web app | **no — add it** |
| partner | Chrome on a mid-range Android | yes |

## What the history says (sweep of 559 commits, 2026-10-25)

About 55 commits fix something a person would notice:

| Class | ~Fixes | Found by |
|---|---|---|
| out of sight, under the keyboard, flicker | 10 | hand |
| platform input | 11 | hand, then the platform-input work |
| gestures and timing | 11 | hand; 2 by the soak (`665b03d`, `ebc0280`) |
| sync and live | 15 | fuzzer, review, hand |
| storage on Safari/iOS | 5 | hand; 1 by iOS chaos (`f942f51`) |
| deploys | 2 | hand |

Of the ~170 commits since 2026-10-13, about three in four kept the real-device runs stable (emulator boots, Safari sessions, runner load, ports); in that time the soaks found 2 product bugs. The fuzzer is the only level with planted bugs it must catch (`e9d66df`, `6366c25`). The cases assume the board keeps an edited card "in sight of the keyboard" and tap there, but nothing asserts it, and Safari on the iOS Simulator only watches (`scenarios/ios.ts`): the iOS new-card bug escaped through both gaps.

## Bug classes

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

| Level | What exists | Runs | Owns |
|---|---|---|---|
| L1 Core units | `web/test`, `BreezyKit/Tests`, `relay/test`, `server/test` | push | B3 rules, B4 merge and codecs, B5 store logic |
| L2 Conformance and contracts | `scenarios/conformance.test.ts`; contract suites per port: **new** | push | honesty of fakes and of the Swift mirror |
| L3 Hub cases on fakes | `scenarios/*.test.ts` on virtual time | push | B1, B3, B4 across devices |
| L4 Convergence fuzzer | `scripts/fuzz.ts`: seeds 1–10 on push, 120 new nightly | push, nightly | B4, B5 sync side |
| L5 Platform replays | `scenarios/platform/*`, traces | push | B2 |
| L6 Real devices | `scenarios/browsers.e2e.ts`: desktop browsers, Mac app, Android emulator; **iPhone that acts: new** | push, nightly soaks | B1, B2, B3, B5 as the platform really does them |
| L7 Long runs and measures | soaks, `ios-chaos.ts`, `feel.ts`/`bench.sh`/`gate.ts`, `selftest.sh` | nightly, weekly | B3 under load, B5 lifecycle, B6, B8 |
| L8 Production | `025afc5`, `4d39793` deploy checks | each deploy | B7 |
| Hand | the owner | always | whatever escapes; logged |

`TESTING.md` (new, at the root) holds this table, the classes, the matrix of class × level with the plant that proves each cell, and how to add a case. It is the entry point; `docs/superpowers/specs/2026-10-11-breezy-testability-design.md` and `docs/platform-expectations.md` stay as the detail they are.

## Each level proven

| Level | Proof it can fail |
|---|---|
| L1 | mutation testing of the web core and BreezyKit, with a score floor per module |
| L2 | each contract suite run against the real adapter and the fake; a deliberately wrong fake must fail it |
| L3–L6 | plants: one or more per class the level owns, switched on by name as the fuzzer's are (`BREEZY_PLANT`, `__breezyPlant`), each required to fail the level |
| L7 | plants for B6 (a deliberate slowdown) and B8 (a deliberate repaint); the soaks' own flake rate |
| L8 | the deploy checks run in CI against a broken copy of the site served locally (PHP and the relay on the runner); there is no staging host (my call) |

A job (weekly, and on dispatch) runs every plant against its levels and fails on a survivor. The matrix in `TESTING.md` names each cell's plant; a cell without one is not owned.

## B1 as an invariant

B1 is checked after every step of every case, not by a case of its own. A device reports, beside its scene, what is visible: the visual viewport in world points, less the keyboard. After each step, the item in focus must lie inside it:

| Focus | Must be visible |
|---|---|
| a card being edited, or new | the whole card; of one taller than the view, its caret line (as `8f23365` on the Mac) |
| the current search match | the matching card, or its caret line if taller |
| a selection just made | the item pressed last |

It holds once the device stands still: three readings alike 50 ms apart, within 5 s of the step (my call, revised after review: judged at the first in-sight reading, the check passed while the camera was still carrying the card off screen). Flicker between steps is B8, not B1.

The iOS bug, reproduced in a Safari tab on the simulator: `App.beginEdit` springs to zoom 1 and reveals the card at once, measured at 25 %, where it fits; the zoom then ends about the card's top centre with the caret off screen. A reveal while the keyboard rises instead springs to the half-way zoom. The reveal now aims from where the camera is going.

Hub devices model the viewport and a keyboard that rises on edit; real devices read `visualViewport` and the Mac its scroll view. Until the contract suites exist (step 5), the hub's keyboard uses heights and timings measured once on each platform and written down beside the fake (my call), so step 2 does not wait for steps 3 and 5.

## The iPhone acts

Safari on the iOS Simulator gets touches fast and timed enough to act in every touch case, not only watch. Candidates: XCUITest driving MobileSafari with coordinate taps, `scripts/sim-touch.py` (idb), WebDriverAgent on the simulator. A spike picks one by whether a double tap's two touches land within the app's 300 ms on a loaded runner and whether the keyboard comes up as for a finger.

The owner uses the Home Screen app, whose viewport (no toolbars), storage and service worker differ from a Safari tab's. The spike must try adding the app to the simulator's Home Screen and driving it there; if that cannot be done, L6 runs in a Safari tab and the matrix marks standalone mode as uncovered for B1 and B5 (my call).

## Stability of real devices

- **Today's push guard stays as it is** — every real-device case on push, a second run that warns rather than blocks — until step 7 measures budgets; then the retry goes. No case leaves push for nightly: "smoke set" means the push cases that meet their budget (my call).
- **Soaks run nightly**, not weekly: desktop with the Mac app, Android, and iOS (my call; volume is no constraint). A nightly red, or a level over budget, is fixed before new features; it is not a required check, as it runs on hardware nobody controls.
- **Flake budget per level**, over the nightly soaks' last 30 days through `scripts/scenario-stats.ts`: L6 under 1 in 1,000 case runs (my call; to tune once measured). Over budget, the level is red.
- **Quarantine.** A real-device case over budget leaves the blocking push set until fixed, with an entry saying why; the set stays honest rather than retried into green.
- **Discipline as a fitness test**, as `configurable-containers/test/fitness/e2e-discipline.test.ts`: no fixed waits in cases (`scenarios/cases.ts` has 15 `wait(` calls today), conditions polled through `until`/`still`, one way to drive each device, each exception listed with its reason.
- Nightly red is fixed before new features. Stability work follows `CLAUDE.md`: draft PRs, measured with the soak workflows.

## The loop from escapes

Every bug found by hand or by L6/L7 is fixed with:

1. a test at the lowest level that shows it;
2. if a fake was wrong, the fake taught and its contract suite extended;
3. a line in `docs/escapes.md`: date, platform, class, the level that should have caught it, the test added.

A rule in `CLAUDE.md` makes this part of every such fix. Escapes per class per month is the measure of whether the strategy works. My call: seed `docs/escapes.md` from the sweep above, so there is a baseline.

## Order

Each is its own plan, in this order: the owner's pain first, then the frame that keeps it fixed.

1. `TESTING.md`, the matrix as it is today (with its empty cells), `docs/escapes.md` seeded, the `CLAUDE.md` rule, iPhone in the quality goals.
2. B1 invariant on hub and real devices; the iOS new-card bug reproduced and fixed through it. The bug: in the Home Screen app, a double tap on the board at 25 % zoom makes a card and zooms to 100 %, but the caret is off screen until the first key, which brings it into view. So the check must hold as soon as the editor opens, before any key; a case at 25 % zoom on a phone-sized hub device should show it before the iPhone acts (step 3), and the iPhone confirms it.
3. The iPhone acts (spike, then L6 on it).
4. Plants per level and the plant job.
5. Contract suites per port.
6. Mutation testing for L1.
7. Flake budgets, quarantine and the discipline fitness test.

## As built, 2026-10-25

| Step | What came of it |
|---|---|
| 1 | `TESTING.md`, `docs/escapes.md` (45 seeded), `scripts/test/docs.test.ts`, the `CLAUDE.md` rule |
| 2 | `scenarios/sight.ts` after every step; the hub's phone and keyboard; the iOS new-card bug fixed (`Camera.goal()`, `revealing()`) |
| 3 | the iPhone acts through idb, read by `scenarios/agent.ts`, in a tab on CI and from the Home Screen by hand; safaridriver was dropped, as it found no simulator session on this Mac |
| 4 | `scripts/plants.ts`: 8 plants, 10 runs, over B1, B2, B3, B4, B5 and B7, at L1, L3, L4, L6 and L8 |
| 5 | the field contract over the hub's field and three browsers'; the phone contract, which found the hub's phone 28 pt, 60 pt and 135 ms off the iPhone |
| 6 | `scripts/mutate.ts`, floors per module from 55 % to 100 %; its first run found `revealing()` thinly tested |
| 7 | `scripts/flake-budget.ts`, nightly soaks, `scenarios/quarantine.ts`, `scripts/test/discipline.test.ts` |

Not done: L7 has no plant (`feel.ts` hung on this Mac; the nightly runs it); B2 has none at L5, which needs a trace of Chrome's or Safari's Esc while composing, recorded through a real keyboard; mutation testing of BreezyKit; the Home Screen app on CI, as adding it takes taps by coordinates. Found on the way: iOS's keyboard drops a word after backspaces in any editable element (`docs/platform-expectations.md`), and the iPhone kept an edit waiting 15 s once in 18 runs, which its sync log will explain next time.

## Left to the builder

Mutation tools (Stryker's command runner suits `node --test`; Swift may need planted bugs or muter), plant naming, where the visible-viewport reading lives in the scene, the B8 method for the web (screenshot diffs in headless Chromium or frame counting), how results are summarised per run.
