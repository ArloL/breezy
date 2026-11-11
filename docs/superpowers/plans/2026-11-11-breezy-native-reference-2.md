# Breezy native reference, phase 2: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pinpoint, from recorded frames, each of the four things the owner reported off in the Mac app's pinch past 25 % (grey band, scrollers, jump back, flicker), with rules that pass on AppKit's reference. Lay the frame format, the checker and "That looked off" that steps 2 and 3 extend to the web, the iPhone and Android.

**Architecture:** Both cores keep a time-bounded track of frames beside their recording's ring, in one compact format: field names once, then one row of numbers per frame. A Node checker reads tracks from either core, from the reference apps and from screen captures, and runs pure rule functions over them. Gestures are recorded once from the owner's hands as raw OS events and replayed into the reference and into Breezy. Fixtures checked into the repo make the comparison run on every push.

**Tech Stack:** TypeScript on Node 26 (`node --test`), Swift/AppKit (Breezy.app, BreezyReference.app, `scripts/*.swift`), BreezyKit, PHP (`server/diag.php`), ScreenCaptureKit.

**Spec:** `docs/superpowers/specs/2026-11-11-breezy-native-reference-2-design.md`. Phase 1: `docs/superpowers/specs/2026-11-10-breezy-native-reference-design.md`.

## Global Constraints

- Never `breezy.k5d.de` in a copy of the owner's Firefox profile; test against localhost (`AGENTS.md`).
- Every wait has a deadline; test files exit on their own with a whole-file deadline; CI jobs carry `timeout-minutes`.
- Small PRs off main, no stacks, merged only when every job is green. The gate stays within ten minutes.
- Recordings never hold a card's words: ids, numbers and names only (`web/flight.ts`).
- Posting events and capturing the screen run from the session on the owner's Mac, where Visual Studio Code holds Accessibility and Screen Recording.
- A limit is proven, never assumed: a recording showing the platform withholding what a gesture needs, plus a spike that tried the alternatives.
- Consistency before peak feel: a rule passing only in ideal conditions counts as failing.
- The four reported items, in the owner's words: "the background looks off; the scrollbars are weird; it jumps back weirdly; the background flickers".

## Review Focus

1. **Frames late or merged under load** (a busy Mac, AppKit merging events): continuity and follow must not report a jump that is only a 50 ms gap between frames. Pinned in Task 2 (`continuity tolerates a 50 ms gap without input`).
2. **A two-finger double tap or ⌘−,** a zoom AppKit animates with no gesture under way: frames must be kept for it as for a pinch. Pinned in Task 3 (SelfTest `frames` covers `smartMagnify`).
3. **A board in no space:** "That looked off" still keeps its recording, on disk. Pinned in Task 4.
4. **A recording past the upload limit:** the oldest frames go first, never the newest second, and entries are trimmed as before. Pinned in Task 4 (`fitting drops the oldest frames first`).
5. **A window on a display with another backing scale, or resized mid-gesture:** frames stay in points, so the rules read the same. Pinned in Task 3 (`frames are in points at a backing scale of 1 and 2`).

---

## Step 1: the Mac's pinch

PRs, each off main, in this order: the spike (throwaway, Task 1); the checker (Task 2); the Mac's frames and "That looked off" (Tasks 3–4); the reference's pinch and its replay (Tasks 5–6); captures (Task 7); the owner's strokes and the acceptance fixture (Tasks 8–9); the plants (Task 10). Then `mac-bounded-board` is rebased onto main, its fix made against Task 9's fixture, as a separate piece of work.

### Task 1: Spike — does a recorded pinch replay into AppKit?

Throwaway, on `spike/pinch-replay`, never merged. It settles the spec's first risk; Tasks 5–9 wait on its verdict.

**Files:**
- Create: `scripts/gesture-tap.swift` (kept: Task 6 takes it over)
- Create, throwaway: a 60-line AppKit window with one `NSScrollView` (`allowsMagnification`, `minMagnification` 0.25, `maxMagnification` 2, document 40,032 pt square) that prints `[t, magnification, clipX, clipY]` per `CADisplayLink` frame as JSON lines

- [ ] **Step 1:** `gesture-tap.swift`: a listen-only `CGEventTap` on `.scrollWheel`, gesture (type 29), magnify and the mouse's moves. Each event is written as `[tMs, base64(CGEvent.data)]` to a JSON file, from the first event to 1.5 s after the last. Bounded: exits after 120 s.
- [ ] **Step 2:** The owner pinches past 25 % three times in the throwaway window while the tap records. Run: `swift scripts/gesture-tap.swift --out build/spike/pinch-<n>.json --seconds 60`.
- [ ] **Step 3:** Replay each into the same window: `CGEvent(withDataAllocator: nil, data:)`, posted with `.cghidEventTap` at the recorded times, cursor warped to the recorded location. Compare the magnification curve with the recording's.
- [ ] **Step 4: Verdict.** Pass means each replay's magnification stays within 0.01 of the recording's, and its end within 0.002. If posted gestures are dropped or don't start a live magnify, try the fallback in the same throwaway app: `NSEvent(cgEvent:)` sent with `window.sendEvent`. Record which path works, with its numbers, under "Spike findings" in the spec. If neither works, stop and bring the evidence to the owner. That is a proven limit and changes Tasks 6–9.

### Task 2: Frame tracks and the checker

**Files:**
- Modify: `web/flight.ts` (type `Recording` gains `frames?: FrameTrack`)
- Create: `scripts/frames/track.ts`, `scripts/frames/rules.ts`
- Test: `scripts/test/frames-rules.test.ts`

**Interfaces:**
- Produces, in `web/flight.ts`: `export interface FrameTrack { fields: string[]; rows: (number | null)[][] }`, and `Recording.frames?: FrameTrack`. `schema` stays 1, as a reader without frames ignores the key.
- Produces, in `scripts/frames/track.ts`:
  - `export const FIELDS`, the fields every platform writes, in this order: `t` (ms, the recording's clock), `zoom`, `camX`, `camY` (world point at the view's top left), `viewW`, `viewH` (pt), `boardX`, `boardY`, `boardW`, `boardH` (world), `px`, `py` (the pointer or a pinch's centre, view pt; null without one), `f1x`, `f1y`, `f2x`, `f2y` (fingers, view pt; null), `wheelDX`, `wheelDY`, `wheelPhase`, `momentumPhase`, `magnify` (this frame's magnification delta), `gesture` (0 none, 1 began, 2 changed, 3 ended, as NSEvent's phases map).
  - Platform fields after them, named per platform: on the Mac `knobH`, `knobV` (each scroller's knob as a share of its track), `grey` (pt of view past the board's edge as drawn: the canvas's dot layer's bounds against the view).
  - `export function column(t: FrameTrack, name: string): (number | null)[]`
  - `export function frames(r: Recording): FrameTrack` (throws when the recording has none)
- Produces, in `scripts/frames/rules.ts`:
  - `export interface Finding { rule: "follow" | "coverage" | "continuity" | "flicker" | "scrollers" | "curve"; from: number; to: number; say: string }`
  - `follow(t: FrameTrack, tol = 0.5): Finding[]`. While a gesture is in contact, the world point under `px, py` (or under the fingers' centre) at its start stays there within `tol` pt.
  - `coverage(t: FrameTrack): Finding[]`. The view's world rect lies within the board's, and `grey` is 0, except while a pan in contact or its coast pulls past that edge.
  - `continuity(t: FrameTrack, opts?: { gapMs?: number }): Finding[]`. No frame moves the camera, or log zoom, more than the input moved it since the last frame plus the motion already under way. At a hand-off (`gesture` 3, or the last finger up), speed after is within 0.5–2× the speed before. A gap over `gapMs` (default 34) with no input is not read as a jump.
  - `flicker(t: FrameTrack, fields: string[], maxFrames = 3): Finding[]`. Any listed field that leaves its value and returns within `maxFrames` frames while the input is steady.
  - `scrollers(t: FrameTrack): Finding[]`. While `zoom` is unchanged, `knobH` and `knobV` don't change.
  - `curve(t: FrameTrack, ref: FrameTrack, field: string, tol: number): Finding[]`. Aligned at the gesture's first frame, the largest gap in `field` stays within `tol`.

- [ ] **Step 1: Write the failing tests** in `scripts/test/frames-rules.test.ts`, each with a hand-built track:
  - `coverage finds grey along the top and left during a pinch`: a pinch whose `boardX` rises above `camX` from 30 % down to 23 % gives one finding spanning those frames. The same with a pan pulling left gives none.
  - `follow finds the board slipping under a pinch's centre`: the world point under `px, py` moving 3 pt gives a finding with `tol` 0.5.
  - `continuity finds a jump back at the pinch's end`: zoom 0.23 at `gesture` 3, then 0.25 in the next frame, gives a finding. The same over 15 frames on a spring gives none.
  - `continuity tolerates a 50 ms gap without input`.
  - `flicker finds grey for two frames and back`.
  - `scrollers finds a knob changing at a constant zoom`.
  - `curve finds a zoom curve 0.02 off the reference's with tol 0.01`.
  - `frames reads a recording's track, and column names a missing field in its error`.
- [ ] **Step 2:** Run `node --test scripts/test/frames-rules.test.ts`. Expected: fails, with modules not found.
- [ ] **Step 3:** Implement `track.ts` and `rules.ts`. Each rule is a pure function, with no I/O.
- [ ] **Step 4:** Run `node --test scripts/test/frames-rules.test.ts && npm run check`. Expected: all pass.
- [ ] **Step 5:** Commit, then open the PR.

### Task 3: The Mac app records frames

**Files:**
- Modify: `BreezyKit/Sources/BreezyKit/Flight.swift` (`FrameTrack`, a time-bounded ring, `Recording.frames`)
- Modify: `Breezy/Window/BoardScrollView.swift`, `Breezy/Canvas/CanvasView.swift` (writing frames)
- Modify: `Breezy/Support/SelfTest.swift` (check `frames`)
- Test: `BreezyKit/Tests/BreezyKitTests/FlightTests.swift`

**Interfaces:**
- Consumes: Task 2's `FIELDS` and the Mac fields, in the same order. A test reads `scripts/frames/track.ts`'s list from a JSON file Task 2 writes beside it (`scripts/frames/fields.json`), so the two can't drift.
- Produces: `Flight.frame(_ row: [Double?])`; `Flight.frameFields: [String]`; `Recording.frames: FrameTrack?`, encoded as `{fields, rows}`. Frames older than 30 s by `t` are dropped. `Flight(frameSeconds: 30)` sets the window.

- [ ] **Step 1: Write the failing tests** in `FlightTests.swift`:
  - `testFramesKeepThirtySeconds`: 4,000 frames at 8.3 ms keep those within 30 s of the newest.
  - `testFramesEncodeAsFieldsAndRows`: the JSON matches web's `FrameTrack` shape.
  - `testFieldsMatchTheChecker`: `Flight.frameFields` equals `scripts/frames/fields.json`.
- [ ] **Step 2:** Run `swift test --package-path BreezyKit --filter FlightTests`. Expected: fails.
- [ ] **Step 3:** Implement in `Flight.swift`.
- [ ] **Step 4:** Write frames from `BoardScrollView`'s display link, on every frame while a gesture is live (`scrolling`, `magnifying`, a spring or a pan), and once after it rests. The input fields come from the last events seen in `scrollWheel`, `magnify(with:)` and `smartMagnify(with:)`. `knobH` and `knobV` are `knobProportion`; `grey` is how far the view extends past the canvas's frame, in view pt.
- [ ] **Step 5:** Add SelfTest check `frames`. A magnification spring, then `smartMagnify` (a two-finger double tap), then a window resize at a backing scale of 1 and of 2 must give rows with `t` increasing, `zoom` changing on each, and one row after rest. Named in the check's output: `frames are in points at a backing scale of 1 and 2`.
- [ ] **Step 6:** Run `swift test --package-path BreezyKit` and `scripts/selftest.sh frames`. Expected: pass. Bench: the zoom's p95 frame time is no worse than the reference build's in `scripts/bench.sh`, in turns on this Mac.
- [ ] **Step 7:** Commit.

### Task 4: "That looked off"

**Files:**
- Modify: `server/diag.php` (`WHY` gains `looked-off`; `MAX_REQUEST` 2 MiB)
- Modify: `web/diag.ts` (`Why` gains `"looked-off"`; `LIMIT` 2 MiB; `fitting` trims frames before entries)
- Modify: `scripts/diag.ts` (lists the reason; draws frames when present)
- Create: `Breezy/Support/LookedOff.swift`; modify `Breezy/App/AppDelegate.swift` (menu item)
- Test: `server/test/diag.test.mjs`, `scripts/test/diag.test.ts`, `BreezyKit/Tests/…` (the payload)

**Interfaces:**
- Produces: `LookedOff.save(_ r: Flight.Recording, space: SpaceState?) async -> (file: URL, sent: Bool)`. It writes `~/Library/Application Support/Breezy/looked-off/<ISO time>.json` always, and POSTs to `diag.php` with reason `looked-off`, deflated as `web/diag.ts` sends, when `space?.invite` exists. The token comes from `SpaceKeys`, as sync's does.
- Menu: Help ▸ That Looked Off, ⌥⌘L. It saves the last 30 s and says where they went.

- [ ] **Step 1: Write the failing tests:**
  - `diag.php takes looked-off up to 2 MiB and refuses past it`.
  - `fitting drops the oldest frames first, then the oldest entries` (`scripts/test/diag.test.ts`).
  - `LookedOff writes the file with no space, and sends nothing`.
- [ ] **Step 2:** Run the server tests (`server/test.sh`), `node --test scripts/test/diag.test.ts`, and the BreezyKit tests. Expected: fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same. Expected: pass. Then on this Mac: open a throwaway board (`-BreezyBoard`), pinch, choose That Looked Off, and run `node scripts/frames/check.ts <file>` (Task 9's CLI, or `jq '.frames.rows|length'` until then). Expected: rows from the pinch.
- [ ] **Step 5:** Commit; open the PR with Task 3.

### Task 5: The reference app pinches

**Files:**
- Modify: `Reference/ReferenceApp.swift` (`--zoom` mode)
- Create: `Reference/FrameWriter.swift`
- Test: `ReferenceTests/FrameWriterTests.swift`

**Interfaces:**
- Consumes: Task 2's `FIELDS`, through `scripts/frames/fields.json`.
- Produces: `BreezyReference --zoom --stage 1512x949 --name <n>`. The window is the hand-check build's size and the document is 40,032 pt square (main's board, with no edge to show). It has `allowsMagnification`, `minMagnification` 0.25, `maxMagnification` 2, AppKit's own scrollers and elasticity, and nothing of Breezy's. Each stroke is a `Recording`-shaped JSON (`{schema: 1, origin, dropped: 0, context: {app: "reference"}, entries: [], frames}`) in `build/reference/<n>-<k>.json`. Strokes split as `StrokeRecorder` splits them, with magnify and gesture phases counted as touch.

- [ ] **Step 1: Write the failing test** `testPinchFramesCarryZoomAndKnobs` over `FrameWriter` with fed values.
- [ ] **Step 2:** Run `xcodebuild test -scheme BreezyReference`. Expected: fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it. Expected: pass. Then by hand: one pinch past 25 % writes a stroke whose `zoom` dips below 0.25 and returns.
- [ ] **Step 5:** Commit.

### Task 6: Replay of raw gestures

By the path Task 1 proved.

**Files:**
- Modify: `scripts/replay-helper.swift`: `POST /replay-raw {app, events: [[t, base64]]}`. Every event must decode to scroll, gesture, magnify or mouse moved, or the request is refused. Times are in order, within 2 minutes.
- Modify: `scripts/gesture-tap.swift` (from Task 1; `--app <bundle>` limits it to that app's window)
- Modify: `scripts/replay.ts`: `postRaw(stroke: RawStroke, bundle: string): Promise<{ posted: number }>`; `export interface RawStroke { name: string; events: [number, string][] }`
- If Task 1 proved only the in-app path: `Breezy/Support/Control.swift` and the reference app take `{"cmd": "events", "events": [[t, base64]]}` in Debug builds, posting `NSEvent(cgEvent:)` to the board window on schedule, and the helper's endpoint is not built.
- Test: `scripts/test/replay.test.ts` (`postRaw refuses an event that is not a gesture's`, against a stub helper)

- [ ] **Step 1:** Write the failing test. **Step 2:** Run it; it fails. **Step 3:** Implement. **Step 4:** Run it; it passes.
- [ ] **Step 5:** On this Mac: replay Task 1's spike pinches into `BreezyReference --zoom`. Expected: `curve(replayed, recorded, "zoom", 0.01)` finds nothing.
- [ ] **Step 6:** Commit.

### Task 7: Pixels from a capture

**Files:**
- Create: `scripts/capture-frames.swift`: ScreenCaptureKit, one window by bundle id, at the display's rate, for `--seconds` (at most 120), to `--out`, a pixel track with `fields: ["t", "grey", "bg", "cardX", "cardY", "cardW", "cardH"]`. `grey` counts view pixels of the past-edge colour, read from the build's own theme (the hand-check build's past-edge grey is whatever its scroll view's background draws; the script takes the colour as `--edge #rrggbb`). `bg` is the board's mean luminance away from cards. `card*` is the yellow card's box.
- Create: `scripts/frames/pixels.ts`: `pixelTrack(capturePath: string): FrameTrack`; `align(pixels: FrameTrack, frames: FrameTrack): FrameTrack`, joining them on `t` by the first gesture event both see.
- Test: `scripts/test/frames-pixels.test.ts`, over `scripts/test/fixtures/owner-pinch-pixels.json`: the pixel track of the owner's recording `build/native-reference-2/owner-pinch-handcheck-2026-11-11.mkv`, 11.4–20.6 s, made once by `node scripts/frames/pixels.ts --from-video` and checked in (small).

- [ ] **Step 1: Write the failing test:** `the owner's recording shows the grey band from about 14.9 s and the flicker the owner saw`. `coverage` (on `grey`) and `flicker(["grey", "bg"])` each find frames within 14.6–15.4 s.
- [ ] **Step 2:** Run it. Expected: fail. **Step 3:** Implement. **Step 4:** Run it. Expected: pass.
- [ ] **Step 5:** Commit.

### Task 8: The owner's strokes

A session with the owner, on this Mac.

- [ ] **Step 1:** Show the owner `build/native-reference-2/grey-band-frames.png` and the recording. Ask what "the scrollbars are weird" meant, and write the answer into the spec. If it isn't the knobs' size, add a rule to Task 2's file for it before going on.
- [ ] **Step 2:** In `BreezyReference --zoom`, with `gesture-tap.swift` running, the owner makes:
  - a slow pinch out past 25 % and a fast one, ×5 each;
  - a pinch past 25 % at the board's top-left corner, ×3;
  - a pinch in past 200 %, ×3;
  - a two-finger double tap, ×3;
  - a pinch with a pan together, ×3;
  - the finger lifted mid-band, ×3.

  Strokes are saved as `build/reference/pinch-<kind>-<k>.json` with their raw events beside them.
- [ ] **Step 3:** Replay each into the reference. Expected: `curve(…, "zoom", tol)`, with `tol` set from the spread of the owner's repeats, finds nothing. A stroke that fails is re-recorded, never loosened.

### Task 9: The fixture, and the four pinpointed

**Files:**
- Create: `scripts/frames-fixture.ts`. For each stroke it keeps the reference's track, Breezy's and the pixel track, replayed into a given `Breezy.app`. Writes `scripts/test/fixtures/mac-pinch/<build>/<stroke>.json`.
- Create: `scripts/frames/check.ts`: `node scripts/frames/check.ts <recording.json> [--ref <ref.json>]` prints each finding with its frames.
- Test: `scripts/test/mac-pinch.test.ts`, and `scripts/test/mac-pinch-known.json`, a ratchet as `web/test/appkit-edge-known.json` is.

- [ ] **Step 1:** Build `mac-bounded-board` rebased onto main with Tasks 3–4 merged, as `7e0248e` plus frames: `build/handcheck`, Release, `local.breezy.handcheck`. Run `node scripts/frames-fixture.ts --app build/handcheck/… --build bounded-7e0248e`.
- [ ] **Step 2: Write the tests:**
  - `the reference passes every rule on every stroke`: no finding from `follow`, `coverage`, `continuity`, `flicker`, `scrollers`.
  - `bounded-7e0248e: the background looks off`: `coverage` finds the grey band on the pinch past 25 %.
  - `bounded-7e0248e: the scrollbars are weird`: `scrollers`, or Task 8's rule.
  - `bounded-7e0248e: it jumps back weirdly`: `continuity` or `curve` against the reference's zoom.
  - `bounded-7e0248e: the background flickers`: `flicker(["grey", "bg"])`.

  Each test asserts that its rule fails, and names the frames.
- [ ] **Step 3: Under load too.** Make the fixture a second time with every core busy (`scripts/frames-fixture.ts --load`, which runs one spinning process per core for the replay's length and ends them), as `bounded-7e0248e-load` and `reference-load`. The tests above run over both: the reference still passes, and the four findings are the same ones.
- [ ] **Step 4:** Run `node --test scripts/test/mac-pinch.test.ts`. Expected: pass, meaning each of the four is pinpointed. Any that can't be is a rule to fix first (spec: "if the idea can't pinpoint those issues it's useless").
- [ ] **Step 5:** Commit; open the PR. `mac-bounded-board`'s fix then turns the four into assertions that pass, its fixture rebuilt from the fixed build.

### Task 10: The Mac's plants

**Files:** `BreezyKit/Sources/BreezyKit/Plant.swift` (names), the code each fix touched, `scripts/plants.ts` (rows), `scripts/test/fixtures/mac-plants/`.

- [ ] **Step 1:** Plant `cross-fade`, the board cross-fading as a card layer is added (`5c41379`), and `editor-shift`, a card's text moving as its editor opens (`5d78bca`).
- [ ] **Step 2:** For each, a SelfTest stroke records frames and a capture from the planted build and from the clean one into `scripts/test/fixtures/mac-plants/<plant>/`. `flicker` on the pixel track, and on the layers' opacity where Task 3 records it, fails on the planted build and passes on the clean one. If layer state alone finds the cross-fade, say so in the spec's risk.
- [ ] **Step 3:** `scripts/plants.ts` rows run the checker over those fixtures. `TESTING.md`'s matrix marks B8 owned at L7 for the Mac, naming both plants.
- [ ] **Step 4:** Commit; open the PR.

---

## Step 2: the web app (outline; planned in detail once step 1 merges)

- `web/flight.ts` keeps a frame track as Task 3 does, from the camera's frame loop: the same `FIELDS`, with fingers from pointer events. The web's platform fields are `coverTop` (whether the board covers the top bar), and `grid`, the dot canvas's rect against the view.
- Report a Problem gains "That Looked Off", sending reason `looked-off` with frames (Task 4's server side).
- Native panning's browsers on the Mac, through Task 6's replay into Firefox; each rule proven on AppKit's reference first.
- Launch measured with frames on and off (`scripts/launch.ts`), as the spec's anti-goal requires.

## Step 3: the iPhone, then Android (outline)

- The UIKit twin: one `UIScrollView` set up as Freeform's canvas, writing the same track. The owner's touches are recorded on the twin and replayed through `scripts/sim-finger.m` into the twin and into Safari and the Home Screen app on the Simulator.
- Plants: the grid flicker (`1dd075e`), the cards over the bars (`11a483a`), the finger left after a pinch (`0a4ebe9`), the creeping hold (`156f154`). A plant the Simulator can't show is proven once on the owner's iPhone through That Looked Off, and marked proven by hand.
- Android: Chrome and Firefox on the emulator, held to the UIKit twin's tracks. A gesture the emulator or the device can't give consistently is proven a limit (recording and spike), gets a row beside `docs/platform-expectations.md`, and falls back to a smaller set the same rules hold.
