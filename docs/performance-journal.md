# Performance journal

Hypotheses, experiments and results from tuning Breezy for feel and memory. Newest entries last. Numbers are main-thread milliseconds per benchmark step (median / 95th percentile / worst) or MB of physical footprint; "your board" is the 8-card board, "stress" the 500-card board from `scripts/make-stress-board.py`.

## How to measure

- **Benchmark:** `scripts/bench.sh LABEL RUNS BOARD...` then `python3 scripts/bench-summary.py`. Interleave the builds being compared, run for run, and compare 95 % CIs over five runs.
- **One phase:** `-BreezyBenchOnly zoom|pan|drag|type` repeats that phase five times, for profiling.
- **Profile:** `sample <pid> SECONDS 1 -file out.txt` while a phase runs; read the main thread's call tree. `sample Breezy 3 1 -wait` attaches from launch.
- **Memory by category:** `footprint -p <pid>`, `vmmap --summary <pid>`, `heap <pid> -sortBySize`. "Owned physical footprint (unmapped)" is IOSurfaces the app owns but has not mapped.
- **Pixels:** `-BreezyCapture out.png`, plus `-BreezyAppearance light|dark`, `-BreezyTurn any`, `-BreezyEdit any`; diff captures pixel by pixel against a baseline before calling a change free of visual cost.
- **Pitfalls:**
  - The window must be visible. With a locked screen or a sleeping display it is occluded and the app draws nothing (0 draws); check `draws` before trusting a run.
  - XCUITest cannot start with the display asleep ("Timed out while enabling automation mode"); `scripts/selftest.sh` covers the same scenarios.
  - Runs longer than ~30 s may catch AppKit's window snapshot (see below) in the peak.
  - Trackpad scroll events are applied later, on the display link; a pan step must move the clip view itself to be measured.
  - Steps run 50 ms apart. With 8 ms between them, as a pinch or pan delivers frames, every step is cheaper (zoom median 2.2 → 1.2 ms on your board), presumably because the CPU stays clocked up. Absolute numbers are pessimistic; a change whose effect depends on frame rate, such as a redraw limit, must be measured at 8 ms.

## Experiments

| # | Hypothesis | Experiment | Result | Kept |
|---|---|---|---|---|
| 1 | Core Animation backing stores hold more than one buffer per card | Ablate card layers; then draw into a `CGImage`, then into an `IOSurface` of our own | Cards cost ~22 MB at peak for 5.9 MB of bitmaps. `CGImage`: copied at commit, peak worse. `IOSurface`: peak 49.2 → 38.4 MB, pixels identical | IOSurface |
| 2 | A card's look includes its position, so moving it redraws it | Count draws in the drag phase | 60 → 0 draws, drag CPU 86 → 47 ms | yes |
| 3 | Drawing in the display's colour space saves conversion | Tag surfaces Display P3 | Zoom CPU 190 → 260 ms | no |
| 4 | The zoom readout's title relays out the toolbar | Ablate the title update; profile | The toolbar lays out its items through SwiftUI on every title change. Fixed-size `NSButton`: no change. Text drawn in a subview of the button: zoom median 7.7 → 4.5 ms | subview |
| 5 | Cards are dropped and recreated during a zoom | Count new layers per zoom | 400 new layers in 125 steps: a magnification moves the clip view's bounds twice and `layoutCards` ran on the half-way rect. Layout once per frame (`needsLayout`): median 4.5 → 2.2 ms, draws 463 → 112 | yes |
| 6 | Typing restyles all text and syncs the whole board twice per key | Profile typing | Restyle only when the title line lost its font; one board update per key; measure only changed cards: median 4.3 → 3.6 ms | yes |
| 7 | TextKit 2 costs more per key than TextKit 1 for a few lines | Same bench, editor built either way | 3.6 → 2.2 ms median. TextKit 1 also breaks lines as `TextMetrics` measures. Cost: Writing Tools falls back to its panel | TextKit 1 |
| 8 | Pre-loading TextInputUI removes the first-edit hitch | `dlopen` it 0.3 s after launch | No change (first edit still 13–20 ms): the hitch is cold text-system caches | no |
| 9 | The editor's text sits where the card draws it | Shift search between capture with and without editor | 1 pt lower in both TextKit versions; editor moved up 1 pt | yes |
| 10 | Card bitmaps survive while the app is hidden | Footprint while hidden | Layers released but 17 MB stayed: the window server keeps the last frame's surfaces. Marking them purgeable-volatile makes them reclaimable: stress hidden 50.6 → 33.1 MB | yes |
| 11 | Autosave blocks the main thread | Profile the drag phase | Writing and the Spotlight `mdwrite` wait (~5 ms) ran on the main thread. `canAsynchronouslyWrite` moves them off; NSDocument still marks the file used on the main thread (~6 ms) | yes |
| 12 | The grid pattern is rebuilt every zoom step | Profile; replace the pattern with replicator layers | 0.16 ms per step gone; dots differ ≤ 4/255 | yes |
| 13 | Many cards changing scale at once can be drawn in parallel | `concurrentPerform` over snapshots of card inputs | Stress zoom worst 58 → 36 ms. But worker threads drain no autorelease pool: +10 MB retained (standalone test: +270 MB per 2000 text drawings without a pool) → pool per item | yes |
| 14 | `kIOSurfaceColorSpace` as an ICC profile costs an IPC per surface at commit | Profile name vs profile vs untagged | Untagged shifts colours by up to 10/255; a name renders identically, marginally faster | name |
| 15 | Off-screen margin cards need not follow every scale change | Keep their bitmap until the zoom settles 0.3 s | Stress peak 105 → 88.7 MB, zoom p95 12.7 → 10.7 ms | yes |
| 16 | A hidden ring sublayer on every card doubles the layers to commit | Create the ring only while selected | Stress zoom p95 10.9 → 9.5 ms; captures of a selected card unchanged | yes |
| 17 | `layoutCards` bookkeeping (live-id `Set`, unchanged frames) slows pans on big boards | Generation marks instead of the `Set`; skip unchanged frames and z | Pan unchanged (2.1 ms median): drawing new cards and AppKit's scrolling dominate | no |
| 18 | Cards entering the off-screen margin need not be drawn in the frame they enter | Draw margin cards in the background, attach a frame or two later; visible ones still at once | Stress pan p95 4.0 → 2.4 ms, zoom worst 29 → 24 ms | yes |
| 19 | The toolbar's SF Symbol and the toolbar cost idle memory | Ablate each | Symbol ~0.5 MB (SVG parsing), whole toolbar ~3 MB | not acted on |
| 20 | `NSTextView` updates the font panel on every key | `usesFontPanel = false` | 6 % of typing samples, but no measurable change in step time | no |
| 21 | Visible cards that only change scale can show their old bitmap, stretched, until the sharp one is drawn | Background refinement for scale-only changes; `zoom-sharp` self-test (fails on a mutant that never shows the new bitmaps) | Zoom p95 / worst: stress 8.4 → 4.3 / 24 → 11 ms, your board 4.3 → 3.2 / 6 → 3.6 ms | yes |
| 22 | Launch leaves free heap pages that could be returned | `malloc_zone_pressure_relief` 0.7 s after launch | Idle unchanged (27.5–28.2 MB) | no |
| 23 | Warming the text system off-screen after launch shortens the first edit | Lay out and draw a text view at 0.5 s | First edit 16.9 → 13.6 ms but first key 9.3 → 10.6 ms: within noise | no |
| 24 | Where the stress board's remaining slow steps are | Log steps over 6 ms by part | Only the first zoom step (441 layers handed back) and cold clicks; every zoom step after the first is under 6 ms | — |
| 25 | Live resize is costly | New `resize` bench phase; toolbar styles; no toolbar | 7.5 ms per step on your board; `.unifiedCompact` 6.0, no toolbar 5.4: the toolbar lays out its items through SwiftUI, the rest is AppKit's window frame | not acted on (design) |
| 26 | Typesetting the zoom readout each step is the largest share of a zoom step the app controls | Redraw at most 30 times a second, with a trailing redraw | Invisible at the bench's 50 ms spacing; with steps 8 ms apart, median 1.54 → 1.21 ms, p95 2.39 → 2.09 ms | yes |
| 27 | Scrollers and their "more content" indicators cost per step | Hide both scrollers | Zoom 1.18 → 1.12 ms, pan unchanged: not worth a design change | no |

## Where it stands (2026-10-07)

`main` before this work (`fafd3a8`, with today's benchmark) against the branch, five interleaved runs, 95 % CIs:

| Your board | before | after |
|---|---|---|
| Zoom step, median / p95 / worst | 7.6 ± 0.6 / 10.4 ± 0.5 / 12.0 ± 0.5 ms | 2.2 ± 0.1 / 3.2 ± 0.1 / 3.8 ± 0.3 ms |
| Key while typing, median / p95 | 4.7 ± 0.1 / 6.1 ± 0.2 ms | 2.7 ± 0.1 / 4.2 ± 0.4 ms |
| Pan step, median | 1.0 ± 0.1 ms | 1.0 ± 0.1 ms |
| Resize step, median | 7.8 ± 0.2 ms | 8.0 ± 0.3 ms |
| Peak / idle / hidden | 41.8 / 27.9 / 30.9 MB | 37.6 / 27.8 / 29.6 MB |

On the stress board, zoom went from 13.8 / 25.6 / 40.8 to 3.2 / 4.4 / 8.7 ms and pan p95 from 3.8 to 2.4 ms. Its memory is not comparable: before, every card measured one line high (see below).

## Findings that were not ours to fix

- **Window snapshots.** About 30 s into activity AppKit's "NSPersistentUI Window Snapshotting" queue snapshots the window for restoration: a transient of ~25 MB. There is no public switch; turning off restoration would mean reimplementing reopened boards and scroll/zoom state.
- **AppKit per-step floor.** A zoom step spends ~0.4 ms in `NSScrollView` magnification and notifications, a pan step ~0.3 ms in scroll indicators and tracking areas. Replacing `NSScrollView` would lose responsive scrolling, which runs off the main thread.
- **Commit cost per new surface.** Core Animation registers each new `IOSurface` at commit (~0.04 ms each); 500 cards appearing at once cost ~20 ms whatever the drawing does.
- **Cold paths.** The first edit (~15 ms) and the first drag move (~7 ms) after launch warm text and animation caches; later ones are 2–5 ms.

## A bug found on the way

`TextMetrics.lines` discarded its `NSTextStorage` before reading the layout, so every card measured one line: multi-line cards were cut off. Found through memory: correctly sized cards made the stress board "use more". The `card-heights` self-test now guards it.

## Design decisions these numbers inform

- **Toolbar — decided, standard kept.** It costs ~3 MB idle and ~2.3 ms per resize step. `.unifiedCompact` saves 1.7 ms per resize step, but the difference cannot be felt and the labelled buttons are clearer; controls drawn on the canvas instead of a toolbar would save both.
- **TextKit 1 in the editor — decided, kept.** It saves 1.4 ms per key over TextKit 2; Writing Tools then opens in a panel instead of inline, which does not matter here: Writing Tools are not used, and typing feels the same either way.
- **Window restoration — decided, kept.** It brings the ~25 MB snapshot transient, but boards reopen after a restart where they were.

## Ideas not yet tried

- A texture atlas for small (zoomed-out) cards: one surface for many cards would cut the commit cost of hundreds of new cards.
- Cards appearing over a few frames, visible ones first, when hundreds come on screen at once.
- Drawing the zoom readout with a cached glyph run instead of `NSAttributedString` each step (~0.1 ms).
- Shorter move animations (0.22 s) for a snappier feel — a design decision.
