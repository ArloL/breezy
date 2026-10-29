# Find size, state and fake-divergence bugs before the owner does — plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** the bugs the owner found by hand on 2026-10-26, and those like them, fail a check first: bugs of a size we don't run, of a combination of states no case reaches, or hidden by a fake that differs from its real device.

**Issue:** #185. **First step:** #195.

## Global Constraints

- Main stays within ten minutes, and the `web` job stays quick. Each step says what it adds, and where.
- A check is proven by a plant or a past bug put back (`TESTING.md`), before it is said to own anything.
- Real devices only nightly. Cheap levels first: what the hub or Chromium can show, they show.

## What got through, and what each option would have caught

Escapes since 2026-10-25 (`docs/escapes.md`), numbered here:

| # | Date | Escape | Class |
|---|---|---|---|
| 1 | 10-25 | home app, double tap at 25 %: caret off screen until the first key | B1 |
| 2 | 10-25 | Android, the name sheet's OK under Chrome's keyboard | B1 |
| 3 | 10-26 | Safari, iOS scrolled the fixed top bar off with the page | B8 |
| 4 | 10-26 | 13 mini, turned card with an empty back: caret under the top bar; the fake drew a back at front size | B1 |
| 5 | 10-27 | WebKit, the driver sent Ctrl for ⌘ | B3 (harness) |
| 6 | 10-27 | iPhone 17, the driver judged a double tap by its listener's clock | B3 (harness) |
| 7 | 10-28 | Safari, a case aimed into the status bar (#148), and a second passed vacuously | B3 (harness) |
| 8 | 10-28 | Firefox for Android's survey over the page | B3 (device) |
| 9, 10 | 10-28 | simctl's launch timeout; adb's key per runner | B5 (CI) |
| 11 | 10-28 | the relay refuses holds past 500 ids; its fakes granted them | B3 |
| 12 | 10-29 | Safari drops a back-forward-cached tab's Web Lock; the owner tests' Device kept it | B5 |
| 13 | 10-29 | edits up to 0.5 s before `pagehide` lost | B5 |

The options, grouped by where they act. Cost is CI time, code and flakiness. "Would have caught" lists rows above.

| Where | Option | Cost | Classes | Would have caught |
|---|---|---|---|---|
| **Real devices** (L6) | A1 More simulator sizes nightly: iPhone SE (375 × 667, no notch), Pro Max, landscape | ~35 min of macOS per size and kind, each night; the simulator's own flakes | B1, B8 at that size | 4 (as the 13 mini did once added) |
| | A2 Display Zoom and larger text on an existing simulator | a setting per job; same minutes as A1 | B1 | none yet; the owner's settings are unknown |
| | A3 The phone contract (`scenarios/phone-contract.e2e.ts`) nightly on each iPhone and Android job | ~1 min per job; no new runner | fake honesty of sizes | 7, as the Safari tab had no fake; it flags `PHONE`'s keyboard now (below) |
| **Fakes** (L2, L3) | B1 Hub phones as the real pages: Safari tab and 13 mini, page points, a board opened at ×0.75, cards made by a double tap and keys **(done, #195)** | 3.6 s in `sync`; ~130 lines | case aim, B1 at Safari's size | 7: with #148's fix taken out, it fails on the hub at the nightly's y ≈ −15 |
| | B2 ViewPort contract: every `ViewPort` method (`rectOf` turned, `caretRect` on an empty side, `topOf`, `area`) in Chromium at each hub screen, against `FakeView`, over generated states | one Chromium file, ~30 s in `web`; ~200 lines | fake honesty of geometry | 4 |
| | B3 `scripts/parity.ts` turned from a report into a gate, once a plant shows it fails on a fake that lies | a plant; no runtime | fake decisions | 4 (the real device decided `reveal caret/too tall`, the fake did not) |
| | B4 A seeded contract for each remaining fake, as `server/test/contract.test.mjs` holds FakeServer: FakeRelay against `wrangler dev`, the owner tests' Device against WebKit's page lifecycle | ~1 min each on `sync`; ~150 lines each | fake honesty of sync and lifecycle | 11, 12 |
| | B5 The hub's remaining harness shortcuts: a phone's `addLane` by op, where a real one taps + and Lane | small | case aim | none yet |
| **State space** (L3, L7) | C1 Drawn UI acts on the hub's phones: Turn, Done, find, zoom, pan, new card, lane, typing, as `scenarios/parity/steps.ts` draws mouse steps, the sight check after each; 20 seeds on push, 500 nightly | ~10 s on push; ~300 lines; seeded, so it shrinks and replays | B1, B3 combinations | 1, 4 |
| | C2 `scripts/ios-chaos.ts` nightly rather than by hand | ~20 min of macOS | B5 through the lifecycle | 12, 13 (it found them, run by hand) |
| **Invariants** (all levels) | D1 Harness self-guards: a tap off the screen or off the board fails (#148, #195); next, the element under a tap must be what the case meant, and a check must see the effect it waits for, not pass on none | small; no runtime | vacuous passes, case aim | 7 and its vacuous sibling; 8 (the survey under the tap) |
| | D2 A stronger sight check: the caret painted (pixels), a too-tall card's top edge shown, a sheet's focused control above the keyboard, the bars on screen | small per check; the pixel check needs a real browser | B1, B8 | 2, 3, 4 |
| **Sweeps** (L3, then Chromium) | E1 The hub's phone cases over a grid of screens: widths 320–440, heights 560–960, keyboards 250–420 | ~0.15 s per case and screen: 6 cases × 30 screens, one watcher, ≈ 30 s on `sync` | B1 at sizes not owned | 4, 7 |
| | E2 Chromium at phone sizes, its height shrunk as a keyboard would, with the real DOM | ~1 min per size set; Chromium does not scroll the visual viewport as iOS does | B1 the hub cannot draw | 2, 4; not 3 |
| **The field** (L8) | F1 Read the `sight broken` reports the owner's and partner's phones already send (`web/diag.ts`, `server/diag.php`): a nightly digest, opening an issue for any | ~50 lines; no device | B1 at their real sizes and settings | any B1 they hit, before they tell us; after the fact |
| **Process** | G1 For every escape, "Should have caught" names a level, and that level gets the plant | done (`docs/escapes.md`) | all | — |

No option reaches 9 and 10: they were the CI runners' own failures, and only real devices found them.

## Recommendation, in order

1. **B1, hub phones as the real pages** (#195). It was the cheapest and the evidence pointed at it. It also showed the hub's every device opening at ×1, where browsers open at ×0.75.
2. **D1, more self-guards**: the tapped element's check and effect-seen checks. Cheapest per bug; the last two guards each found a second case at once.
3. **A3, the phone contract nightly.** It keeps step 1 true without anyone running it by hand. Today it would fail: `PHONE`'s keyboard is 396 pt, while the nightly's iPhone 17 Home Screen app recorded 369 (board to 399, not 372), 27 pt past the contract's 24.
4. **B2, the ViewPort contract in Chromium**, at the hub's five phone screens. It covers the fake-geometry class behind #4.
5. **C1, drawn UI acts on hub phones**, on all five screens. It covers the combinations behind #1 and #4 for seconds of CI.
6. **E1, then E2: size sweeps**, hub first; Chromium for what the hub cannot draw.
7. **B3, parity as a gate**, once a plant (#4's fake put back) shows it fails.
8. **B4, contracts for FakeRelay and the lifecycle Device**, and **C2, iOS chaos nightly**.
9. **D2, a stronger sight check**, one check per escape class as it comes.
10. **F1, the field digest.** Cheap, but it finds a bug after a person has hit it.
11. **A1 and A2, more simulator sizes and settings.** The most expensive, so last: once 3–6 show which sizes break, run those.

## Tasks

### Step 1: hub phones as the real pages — #195
- [x] `SAFARI` and `SAFARI_MINI` in `web/test/fakes.ts`, from run 40843908664's recordings. Every phone in page points.
- [x] A tap off the page or the board fails on the hub. A phone makes its cards by editing them. A board opens through `App.load`.
- [x] Every hub phone case runs on both Safari kinds. #148 put back fails there.

### Step 2: self-guards
- [ ] `Device.tap`, on real devices: the element at the point (`elementFromPoint`) is the board, or the selector the case names; else fail, naming what was there.
- [ ] Each wait whose check passes when nothing happened (a scene unchanged since before the action) fails instead. Find them by making each case's action a no-op and listing the cases that still pass.

### Step 3: the phone contract nightly
- [ ] Run `scenarios/phone-contract.e2e.ts` after each iPhone job's scenarios and in the Android job, `timeout-minutes` bounded.
- [ ] Correct `PHONE`'s keyboard to what it measures.

### Steps 4–11
Each gets its own plan when it starts, judged against the escapes logged by then.
