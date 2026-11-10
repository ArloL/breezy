# Native Reference for the Trackpad's Edge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure how `WheelPan` stretches and rebounds at the board's edge against what AppKit's `NSScrollView` does with the same trackpad stroke, and learn from a spike whether letting Firefox scroll natively comes closer.

**Architecture:**
- **Reference app.** A minimal Mac app records the owner's strokes: each scroll event with its phases, and the clip view's origin every frame.
- **Replay helper.** A helper started once from Terminal.app (which holds Accessibility) posts a recorded stroke as `CGEvent`s into the reference app, to check the replay is faithful, or into Firefox on the dev server, which records the wheel events it made.
- **Fixture and test.** Pairs of AppKit curves and Firefox wheel events become a fixture. A Node test replays the wheel events through `WheelPan` on the fake clock and compares the two curves.

**Tech Stack:** Swift 5 / AppKit / XcodeGen (`project.yml`), CoreGraphics `CGEvent`, Node 24 TypeScript (`node --test`, type stripping), the dev server `scripts/serve-web.ts`.

**Spec:** `docs/superpowers/specs/2026-11-10-breezy-native-reference-design.md`

## Global Constraints

- **Board.** Both sides show an empty board at zoom 1: Freeform's margin, `MARGIN = 1194` pt, on every side of an empty board's origin, so 2,388 pt square.
- **Coordinates.** Camera from clip origin: `cam = MARGIN − clip` on each axis, where the reference's document is flipped with (0, 0) at the board's top-left.
- **Stage.** Both sides use the same stage. The default is 1200 × 762 pt; the reference takes it as `--stage WxH`, and Firefox's window is sized so the board element matches (the wheel stream's `stage` field says what it was).
- **Time.** t = 0 is a stroke's first scroll event, on both sides, in ms.
- **Localhost only.** Test against localhost (`npm run dev`, port 58565), never breezy.k5d.de. The replay helper listens on 127.0.0.1:58569 only, posts only scroll events, and exits after 3,600 s without a request.
- **Bounded waits.** Every wait has a deadline: the helper's requests, the replay CLI and the tests end on their own, and test files carry a whole-file deadline.
- **Branches.** Work starts on `try/bounded-canvas`. Once PR #271 merges, small PRs go off main; none merges with a red job.
- **Comments and options.** Comments only where something isn't obvious. Long CLI options where macOS supports them.

## Review Focus

1. **Natural scrolling flips signs.** A replayed stroke whose deltas come out negated would compare a pull against a push. Task 3's fidelity test asserts the recorded and the replayed deltas are equal, sign included.
2. **A stroke with no finger phase.** The owner's strokes may arrive as momentum alone, with no `began` (a flick caught mid-coast), and the recorder must still close them. Task 1 tests a stroke of momentum events only.
3. **Firefox sees the page late after navigating.** If the page isn't loaded when the replay starts, the first events are lost and the stream is short. Task 4 asserts the captured stream's event count is within 2 of the posted count, and refuses otherwise.
4. **A stale flight file.** With several Firefox pages open, the newest `build/flight/firefox *.json` may not be the replayed page. Task 4 names the page with `?reference=…&who=<id>`, and the replay reads that file only.
5. **A pull on both axes.** A diagonal stroke crosses one limit while drifting on the other. Task 5's measures work on the axis whose limit is crossed furthest, and the test includes a drifting stroke.

---

### Task 1: The reference app

**Files:**
- Create: `Reference/ReferenceApp.swift`: the app, the window, the scroll view and the keys.
- Create: `Reference/StrokeRecorder.swift`: pure; collects events and frames into strokes.
- Create: `ReferenceTests/StrokeRecorderTests.swift`
- Modify: `project.yml`: targets `BreezyReference` (macOS application, sources `Reference`, no dependencies, bundle id `local.breezy.reference`) and `BreezyReferenceTests` (`bundle.unit-test`, host `BreezyReference`); scheme `BreezyReference`.

**Interfaces:**
- Produces: `struct Stroke: Codable { name: String; stage: [Double]; start: [Double]; events: [[Double]]; frames: [[Double]] }`.
  - `stage` is [w, h] and `start` is the clip origin [x, y].
  - Each event is `[t, scrollingDeltaX, scrollingDeltaY, phase.rawValue, momentumPhase.rawValue]`.
  - Each frame is `[t, clipX, clipY]`.
  - Written to `build/reference/<name>-<n>.json`, as `JSONEncoder` writes it.
- Produces: `struct StrokeRecorder { init(name: String, stage: CGSize, start: CGPoint, restAfter: Double = 1500); mutating func event(t: Double, dx: Double, dy: Double, phase: UInt, momentum: UInt); mutating func frame(t: Double, origin: CGPoint) -> Stroke? }`.
  - `t` is in seconds, from `NSEvent.timestamp` or `CADisplayLink.timestamp`, both `CACurrentMediaTime`'s base.
  - The stroke's times are ms after its first event.
  - Frames before the first event are not kept.
  - `frame` returns the finished stroke once `restAfter` ms have passed with no event and the origin has stayed within 0.01 pt for 100 ms.

- [ ] **Step 1: Write the failing tests** in `StrokeRecorderTests`:
  - `testTimesFromFirstEvent`: events at 10.000 s and 10.008 s give event times `[0, 8]`.
  - `testFramesBeforeFirstEventDropped`
  - `testEndsAfterRestAndStillOrigin`: no stroke at 1,499 ms after the last event; a stroke at 1,600 ms with the origin still.
  - `testMomentumOnlyStrokeEnds`: phase 0 and momentum 1, 4, 8 only (Review Focus 2).
  - `testOriginStillMovingKeepsStrokeOpen`: a rebound still under way at 1,600 ms keeps it open.
- [ ] **Step 2: Run them to see them fail.** `xcodegen generate && xcodebuild test -project Breezy.xcodeproj -scheme BreezyReference -destination 'platform=macOS'`. Expected: build fails, `StrokeRecorder` is undefined.
- [ ] **Step 3: Implement `StrokeRecorder`.**
- [ ] **Step 4: Implement `ReferenceApp`.**
  - **Arguments.** `--stage 1200x762`, `--start 0,813`, `--name push-hold`.
  - **Window and scroll view.** A window whose content is exactly the stage. One `NSScrollView` with no scrollers, magnification off, and elasticity `.allowed` on both axes. Its document is a flipped 2388 × 2388 view drawn in a dot grid (25 pt), with a solid 4 pt red bar at x = 0, for the spike's capture.
  - **Recording.** `NSEvent.addLocalMonitorForEvents(matching: .scrollWheel)` feeds the recorder and passes the event on. A `CADisplayLink` feeds the clip's `bounds.origin` every frame.
  - **Each finished stroke** is written, and its path is printed on stdout.
  - **Keys.** `r` sets the clip to `start` without animating and arms a new stroke; `q` quits.
- [ ] **Step 5: Run the tests to see them pass.** Same command. Expected: `** TEST SUCCEEDED **`.
- [ ] **Step 6: Check it by hand.** Launch with `--start 0,813` and push right into the left edge. Expected: the board stretches past x = 0, a file appears in `build/reference/`, and its frames have clip x < 0 during the stretch, which proves the overscroll can be read from the clip view.
- [ ] **Step 7: Commit.**

### Task 2: The replay helper

**Files:**
- Create: `scripts/replay-helper.swift`: run with `swift scripts/replay-helper.swift` from Terminal.app.
- Create: `scripts/replay.ts`: the CLI that sends it strokes.
- Create: `scripts/test/replay.test.ts`

**Interfaces:**
- Consumes: `Stroke` events from Task 1.
- Produces: the helper's HTTP API on 127.0.0.1:58569.
  - `POST /replay` takes `{ app: string (bundle id), at: [x, y] (global screen point), events: number[][] }` and answers `{ posted: number }` once the last event is posted.
  - `GET /ping` answers 200.
  - Anything else gets 404. A request not from 127.0.0.1 is refused.
- Produces: `export function toCGPhases(phase: number, momentum: number): { scroll: number; momentum: number }` in `scripts/replay.ts`, and the same table in the helper. NSEvent → CG:
  - **Phase:** `began 1 → 1`, `changed 4 → 2`, `ended 8 → 4`, `cancelled 16 → 8`, `mayBegin 32 → 128`, `none 0 → 0`.
  - **Momentum:** `began 1 → 1`, `changed 4 → 2`, `ended 8 → 3`, `none 0 → 0`.
- Produces: `node scripts/replay.ts <stroke.json> --into reference|firefox [--who <id>]`. It prints the path it wrote: the reference's new stroke, or Task 4's capture.

- [ ] **Step 1: Write the failing test** `toCGPhases maps every NSEvent phase`. Assert the table above, and that unknown values throw.
- [ ] **Step 2: Run it.** `node --test scripts/test/replay.test.ts`. Expected: FAIL, the module is missing.
- [ ] **Step 3: Implement `toCGPhases`, and the CLI's `--into reference` path.**
  - Check `/ping`, failing in 2 s with "start the helper from Terminal.app: swift scripts/replay-helper.swift".
  - Launch the reference with `open -n` and `--args`, passing the stroke's `--stage`, `--start` and `--name <name>-replay`.
  - Post `/replay` with `app: "local.breezy.reference"`; the helper finds the window itself.
  - Wait for the new file in `build/reference/`, with a 20 s deadline.
- [ ] **Step 4: Implement the helper.**
  - **Server.** A `Network.framework` `NWListener` bound to 127.0.0.1.
  - **Each replay.** Activate the app by bundle id, warp the pointer to the centre of its frontmost window, and wait 300 ms. Then post each event with `CGEvent(scrollWheelEvent2Source:units: .pixel, wheelCount: 2, …)` at its recorded time, scheduled from `mach_absolute_time`, with these fields set:
    - `scrollWheelEventIsContinuous = 1`;
    - `scrollWheelEventPointDeltaAxis1 = dy` and `Axis2 = dx`, and the fixed-point delta fields to match;
    - `scrollWheelEventScrollPhase` and `scrollWheelEventMomentumPhase` from the table.
  - **Exit.** After 3,600 s without a request.
- [ ] **Step 5: Run the test to see it pass.** Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 3: Fidelity — a replay reproduces AppKit

**Files:**
- Create: `web/test/helpers/measures.ts`: shared by this task's script and Task 5's test.
- Create: `scripts/reference-check.ts`
- Create: `web/test/measures.test.ts`

**Interfaces:**
- Produces, in `measures.ts`:
  - `export type Curve = [t: number, x: number, y: number][]`, in camera coordinates.
  - `export interface Measures { stretch: number; overshoot: number; settle: number }`:
    - `stretch` is how far past the edge the camera is when the finger lifts, at the last event whose phase isn't 0, in pt;
    - `overshoot` is the furthest it ever is past the edge, in pt;
    - `settle` is the time, in ms, after which it stays within 0.5 pt of the edge.
  - `export function pastEdge(c: Curve, l: Limits): [t: number, p: number][]`: signed distance past the limit on the axis crossed furthest (Review Focus 5), positive outward.
  - `export function measure(c: Curve, l: Limits, liftAt: number): Measures`
  - `export function gap(a: Curve, b: Curve, l: Limits): number`: the largest |difference| of `pastEdge`, sampled every 8 ms over their common time, held between samples.
  - `export const fromClip = (frames: number[][]): Curve`: `cam = MARGIN − clip`.
  - `export function referenceLimits(stage: { w: number; h: number }): Limits`: `panLimits(boardOf({x:0,y:0,w:0,h:0}, null), 1, stage)`.
- Produces: `node scripts/reference-check.ts <recorded.json> <replayed.json>`. It prints each measure for both, and the gap. It exits 1 when the deltas differ (Review Focus 1) or a measure differs by more than the tolerance.

- [ ] **Step 1: Write the failing tests** in `measures.test.ts`:
  - `referenceLimits at 1200 × 762 are x 6..1194, y −432..1194`;
  - `fromClip maps clip 0 to the left limit`;
  - `measure of a hand-built curve`: up 0→40 pt by 200 ms, lift at 200, back under 0.5 pt at 420; expect stretch 40, overshoot 40, settle 420;
  - `pastEdge picks the axis crossed furthest` in a diagonal;
  - `gap of a curve with itself is 0, and with one shifted 10 pt is 10`.
- [ ] **Step 2: Run them.** `node --test web/test/measures.test.ts`. Expected: FAIL, the module is missing.
- [ ] **Step 3: Implement `measures.ts`.**
- [ ] **Step 4: Run them to see them pass.**
- [ ] **Step 5: Implement `reference-check.ts`.** The tolerance is the larger of each measure's spread over the owner's repeats of that stroke, from Task 6's recordings (`--repeats <glob>`), and 2 pt or 16 ms.
- [ ] **Step 6: Check one stroke, with the owner.** Start the helper, record one push-and-hold in the reference, replay it into the reference, and compare. Expected: exit 0.
  - **If the deltas differ only in sign,** fix the sign in the helper.
  - **If the measures differ beyond the tolerance,** stop: the spec's fallback applies (the owner strokes in Firefox while a `CGEventTap` records). Report it to the owner before going on.
- [ ] **Step 7: Commit.**

### Task 4: Firefox capture

**Files:**
- Modify: `web/sample.ts`: `export function referenceStart(search: string): Cam | null`, which reads `?reference=<x>,<y>`.
- Modify: `web/main.ts:98-110`: `?reference=<x>,<y>` opens an empty board that isn't kept (as `?stress` does), at camera `{x, y, zoom: 1}`. `?who=<id>` names the page's flight file instead of the random id.
- Modify: `scripts/serve-web.ts`:
  - `POST /goto?url=<path>` sends every page `data: goto <path>`.
  - `RELOAD`'s handler becomes `(e) => e.data.startsWith("goto ") ? location.replace(e.data.slice(5)) : location.reload()`.
- Modify: `scripts/replay.ts`: the `--into firefox` path.
- Test: `web/test/sample.test.ts`

**Interfaces:**
- Consumes: Task 2's helper and the `Stroke` format; `fromClip`'s inverse for the start camera.
- Produces: `build/reference/firefox/<name>-<n>.json` holding `{ stage: [w, h], from: [x, y, zoom], events: [t, dx, dy][] }`.
  - It is the last `input wheel` entry of `build/flight/firefox <who>.json`, with each event's camera dropped.
  - Deltas are stored as the browser's `deltaX/deltaY`, the sign `replay()` expects.

- [ ] **Step 1: Write the failing tests.**
  - `referenceStart("?reference=1194,381&who=a")` deep-equals `{x: 1194, y: 381, zoom: 1}`.
  - `referenceStart("?demo")` and `referenceStart("?reference=x")` are `null`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement the parameters and `/goto`.**
- [ ] **Step 4: Run it to see it pass.** Also `npm run check`. Expected: PASS, no type errors.
- [ ] **Step 5: Implement `--into firefox`.**
  1. Post `/goto?url=/?reference=<cam>&who=<id>` and wait 1.5 s.
  2. Replay into `org.mozilla.firefox`.
  3. Wait for `build/flight/firefox <id>.json` to hold a wheel stream newer than the replay, with a 12 s deadline: pages post every 5 s.
  4. Refuse if the stream's event count is more than 2 short of the stroke's (Review Focus 3).
  5. Write the capture.
- [ ] **Step 6: Check it by hand.** Replay Task 3's stroke into Firefox. Expected: a capture whose stage is the reference's. If it isn't, resize Firefox's window and repeat.
- [ ] **Step 7: Commit.**

### Task 5: The fixture and the comparison test

**Files:**
- Create: `scripts/reference-fixture.ts`: builds `web/test/appkit-edge.json` from `build/reference/*.json` and `build/reference/firefox/*.json`.
- Create: `web/test/appkit-edge.json`
- Create: `web/test/appkit-edge.test.ts`
- Modify: `TESTING.md`: name the test at the level that owns feel at the board's edge, the level `wheel.test.ts` sits at.

**Interfaces:**
- Consumes: `measure`, `gap`, `fromClip`, `referenceLimits` (Task 3); `replay` (`web/test/helpers/replay.ts`, `Gesture` shape `{ name, stage, from, restsAt, events: [t, dx, dy][] }`).
- Produces: the fixture `{ about: string, strokes: { name, stage: {w, h}, lift: number, appkit: Curve[], firefox: [t, dx, dy][] }[] }`.
  - `appkit` holds one curve per repeat.
  - `lift` is the ms of the last event with a finger phase.

- [ ] **Step 1: Write the test.** For each stroke, take the median repeat by overshoot as AppKit's curve, and run `replay()` on Firefox's events with `referenceLimits`. Then:
  - `test("<name>: stretch | overshoot | settle | gap within the owner's spread")` prints all four measures for both;
  - each assertion runs through `test(..., { todo: "<measure>: WheelPan <a> vs AppKit <b>" })` where it fails today, and as a plain test where it passes.

  Also, unconditionally: `the fixture has a push-hold, a release, three flicks, a push after a bounce, a pull back, and a diagonal`. The file ends with a 30 s deadline.
- [ ] **Step 2: Build the fixture from Task 6's recordings and run it.** `node scripts/reference-fixture.ts && node --test web/test/appkit-edge.test.ts`. Expected: exit 0; the todo lines name each gap.
- [ ] **Step 3: Run the suite.** `npm test && npm run check`, including `scripts/test/docs.test.ts` for the TESTING.md path. Expected: PASS.
- [ ] **Step 4: Commit.**

### Task 6: The owner's recording session

There's no code in this task; it gathers what Tasks 3–5 run on. It comes after Task 2 and before Task 3's Step 5.

- [ ] **Step 1: Hand the owner the commands**, split across short lines:

  ```bash
  swift scripts/replay-helper.swift
  open build/Build/Products/Debug/BreezyReference.app \
    --args --stage 1200x762 --start 0,813 --name push-hold
  ```

- [ ] **Step 2: The owner strokes.** Each stroke is repeated 5 times, with `r` between repeats.

  | Name | Start (clip) | Stroke |
  |---|---|---|
  | push-hold | 0,813 | slow push past the left edge, hold 1 s, lift |
  | release | 0,813 | slow push, lift at once |
  | flick-slow, flick-mid, flick-fast | 594,813 | flick left, three speeds |
  | push-after-bounce | 594,813 | flick into the edge, then a slow push as it bounces |
  | pull-back | 0,813 | push past the edge, then drag back inside before lifting |
  | diagonal | 0,813 | push past the left edge, drifting down |

- [ ] **Step 3: Capture Firefox.** Replay each stroke's median repeat into the reference (Task 3's check) and into Firefox (Task 4).
- [ ] **Step 4: Commit the fixture.** It's built in Task 5. The raw recordings stay in `build/`.

### Task 7: Spike — Firefox's own scrolling (throwaway)

**Files:**
- Create: `web/spike/native-scroll.html`, copied as a static file by the dev server; not linked from the app.
- Create: `scripts/spike-capture.ts`

- [ ] **Step 1: The page.** A `overflow: scroll` container the size of the stage, holding a 2388 × 2388 board with the same red bar at x = 0 and a CSS `zoom: 1`. The page logs `scrollLeft/scrollTop` every rAF into the flight-style post.
- [ ] **Step 2: Measure past the edge, where script can't read it.**
  - Record the screen with `screencapture -v -V <s>` during a replay.
  - Extract frames with `ffmpeg`, then track the red bar's x per frame for the overscroll.
  - Join the two at the edge.
  - Before trusting it, check the bar tracking against the reference app's own clip curve, replayed and recorded on screen.
- [ ] **Step 3: Measure.** Replay every stroke into the page and compute Task 3's measures against AppKit, beside `WheelPan`'s from Task 5.
- [ ] **Step 4: Record the verdict.** Add a `## Spike verdict` section to the spec: a table of the four measures per stroke for AppKit, `WheelPan` and native scrolling. Then the owner tries both pages by hand on the same strokes and confirms or overrules it. Commit only that section; delete the spike files.
