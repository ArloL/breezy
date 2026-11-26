# Breezy native reference, phase 2, step 2: the web app's frames — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The web app keeps the last 30 s of frames in its recording, in the Mac's format, on every browser and the Home Screen app; "That looked off" sends them; the owner's strokes replayed into Firefox's native panning are judged by the same rules, proven on AppKit's reference.

**Architecture:** A `FrameRecorder` in `web/frames.ts` runs its own `requestAnimationFrame` loop, woken by input and by every camera change (`View.apply`), and stopped after half a second still, as the Mac's display link is. Each tick it reads a `FrameSource`, the effective camera (a native pinch's CSS transform included), the view, the board, and the input since the last tick, and hands one row to `Flight.frame`. The Node checker reads web tracks as it reads the Mac's, skipping the Mac-only rules.

**Tech Stack:** TypeScript on Node 26 (`node --test`), Playwright (`scenarios/browsers.e2e.ts`), Swift (`scripts/replay-helper.swift`), Firefox on the Mac.

**Spec:** `docs/superpowers/specs/2026-11-11-breezy-native-reference-2-design.md`; step 1's plan: `docs/superpowers/plans/2026-11-11-breezy-native-reference-2.md`.

## Global Constraints

- Never `breezy.k5d.de` in a copy of the owner's Firefox profile; test against localhost (`npm run dev`) (`AGENTS.md`).
- Every wait has a deadline; test files exit on their own with a whole-file deadline; CI jobs carry `timeout-minutes`.
- Small PRs off main, no stacks, merged only when every job is green.
- "Card text in a recording": frames hold numbers only; `web/flight.ts` keeps only digests of words.
- "A recording that slows the app": launch is measured against the same build not recording (`scripts/launch.ts --ref-without-recorder`), and frames are held to that; `__breezyNoFlight` turns frames off with the rest.
- The same format on both cores: `scripts/frames/fields.json`'s `common` fields, in order, then the platform's.
- Before a build's findings go into a `*-known.json`, every rule is counted against main's build, not only the reports: #309 first ratcheted in a slip from under the fingers on 24 strokes by counting the four reports alone.
- Each rule is proven on AppKit's reference first: a rule that fails on `scripts/test/fixtures/mac-pinch/reference-replay` is wrong.

## Review Focus

1. **A native pinch on iOS or the Mac:** the camera is set only at `pinchEnd` (`web/native/surface.ts:141`); frames must show the pinch's zoom as drawn, not the zoom before it. Pinned in Task 3 (`a native pinch's frames follow its transform`).
2. **A page hidden or a tab switched mid-gesture:** rAF stops; the recorder must not spin, and must wake again on the next input. Pinned in Task 3 (`a hidden page keeps no loop, and wakes on input`).
3. **`__breezyNoFlight`:** no frames and no rAF loop at all, so the launch measure compares like with like. Pinned in Task 2 and Task 3.
4. **A long session at 120 Hz:** 30 s of rows, never more, and memory flat. Pinned in Task 2 (`frames keep thirty seconds at 120 Hz`).
5. **A gesture's begin and end in one frame** (a quick tap of two fingers, a wheel stream of one event): its `gesture` 1 and 3 both reach a row, as on the Mac (#305). Pinned in Task 3 (`a begin and an end in one frame both reach the frames`).

---

PRs, each off main, in this order: Task 1; Tasks 2–3; Task 4; Task 5; Task 6 (spike, throwaway); Task 7.

### Task 1: The checker reads web tracks

**Files:**
- Modify: `scripts/frames/fields.json` (`"web": ["coverTop", "grid"]`), `scripts/frames/track.ts` (`WEB_FIELDS`), `scripts/frames/rules.ts`, `scripts/frames/check.ts`
- Test: `scripts/test/frames-rules.test.ts`

**Interfaces:**
- Produces: `WEB_FIELDS: readonly string[]` from `track.ts`; rule `chrome(t): Finding[]` (`rule: "chrome"`), a frame with `coverTop` 1 being one finding; `check(t, ref?, tol?)` runs `scrollers` and `fades` only when the track has `knobH` and `fading`, `chrome` only when it has `coverTop`, and adds `grid` to `flicker`'s fields when present.
- `coverTop`: 1 when the board paints over the top bar, else 0. `grid`: how far, in view pt, the dot canvas falls short of the view, as the Mac's `grey`.

- [ ] **Step 1: Write the failing tests** in `frames-rules.test.ts`:
  - `check reads a web track`: a track of `FIELDS` + `WEB_FIELDS` with two still frames gives `[]`, and does not throw.
  - `chrome finds the board over the top bar`: `coverTop` 0, 1, 1, 0 gives one finding over the middle two frames.
  - `the grid falling short for a frame is a flicker`: `grid` 0, 40, 0 gives one `flicker`.
  - `AppKit's replays still pass every rule`: every `mac-pinch/reference-replay` track gives `[]` with `REPLAYED`.
- [ ] **Step 2:** Run `node --test scripts/test/frames-rules.test.ts`. Expected: the first three fail (`the track has no field knobH`, no `chrome`).
- [ ] **Step 3:** Implement as the Interfaces say; `Finding["rule"]` gains `"chrome"`.
- [ ] **Step 4:** Run `node --test scripts/test/frames-rules.test.ts scripts/test/mac-pinch.test.ts scripts/test/mac-plants.test.ts` and `npm run check`. Expected: pass.
- [ ] **Step 5:** Commit; open the PR.

### Task 2: `Flight` keeps frames

**Files:**
- Modify: `web/flight.ts`
- Test: `web/test/flight.test.ts`

**Interfaces:**
- Consumes: Task 1's `fields.json` (`common` then `web`).
- Produces: `Flight.frameFields: readonly string[]` (static, `common` + `web`); `Flight.frame(values: (number | null)[]): void`, every field after `t`, `t` stamped on the entries' clock to a tenth of a ms; a row of another length is not kept; rows older than `frameMs` (default 30,000) by `t` go; `recording().frames` is `{ fields, rows }`, or absent with no rows. `new Flight({ now, wall, size, frameMs })`.
- The fields are a literal array in `flight.ts` (the web bundle can't read JSON at runtime); a test holds it to `fields.json`.

- [ ] **Step 1: Write the failing tests** in `flight.test.ts`:
  - `frames keep thirty seconds at 120 Hz`: 7,200 frames 8.3 ms apart keep those within 30 s of the newest, and an internal compaction keeps the backing array under 2 × that.
  - `frame fields match the checker`: `Flight.frameFields` equals `fields.json`'s `common` then `web`.
  - `a frame of another length is not kept`.
  - `no frames while recording is off`: with `__breezyNoFlight` set, `recording().frames` is absent.
  - `frames hold numbers only`: every cell of every row is a number or null.
- [ ] **Step 2:** Run `node --test web/test/flight.test.ts`. Expected: the new tests fail.
- [ ] **Step 3:** Implement, compacting as the Swift `Flight.frame` does (`frameHead`, drop past 4,096).
- [ ] **Step 4:** Run `node --test web/test/flight.test.ts web/test/diag.test.ts`. Expected: pass.
- [ ] **Step 5:** Commit (the PR opens with Task 3).

### Task 3: The recorder

**Files:**
- Create: `web/frames.ts`
- Test: `web/test/frames-recorder.test.ts`

**Interfaces:**
- Consumes: Task 2's `Flight.frame`, `Flight.frameFields`.
- Produces:
  - `interface FrameSource { cam(): Cam; stage(): { w: number; h: number }; board(): Rect; coverTop(): boolean; gridShort(): number }`. `cam()` is the camera as drawn: a native pinch's transform composed in.
  - `class FrameRecorder { constructor(flight: Flight, source: FrameSource, clock?: { raf, caf, hidden?: () => boolean }); wake(): void; pointer(id: number, x: number | null, y: number | null): void; wheel(deltaX: number, deltaY: number, phase: number, momentum: number): void (the browser's deltas); magnify(by: number, phase: "began" | "changed" | "ended"): void }`.
- What a row holds, field by field: `zoom` = `cam.zoom`; `camX`, `camY` = the board point at the view's top left, `-cam.x / zoom`, `-cam.y / zoom` (the Mac's convention; the web's `cam` is a translate, `web/scene.ts:21`); `viewW`, `viewH` = `stage()`; `board*` = `board()`; `px`, `py` = the pinch's centre or the pointer, in view pt; `f1*`, `f2*` = the first two live touches in id order, null when none; `wheelDX`, `wheelDY` = the deltas since the last row as AppKit's `scrollingDelta` (the browser's `deltaX` negated); `wheelPhase`, `momentumPhase` = NSEvent's codes (began 1, changed 4, ended 8), from `WheelPan`'s guesses; `magnify` = the scale's change since the last row, as AppKit's magnification (`scale / last − 1`); `gesture` = began 1, changed 2, ended 3, as the Mac's `FrameRecorder` keeps it (a begin held until a row keeps it); `coverTop` 1 or 0; `grid` = `gridShort()`.
- The loop: a row each rAF tick while what shows or the input changed, then one row once still; it stops after 30 still ticks, and while `hidden()`; `wake()` restarts it. No loop is ever started while `__breezyNoFlight` is set.

- [ ] **Step 1: Write the failing tests** with a fake clock (`raf` queue and `tick()`, as `camera.test.ts` does) and a fake source:
  - `a row each frame while the camera moves, one once still, then none`.
  - `camX is the board point at the view's top left`: `cam` {x: −200, y: −100, zoom: 2} gives `camX` 100, `camY` 50.
  - `a native pinch's frames follow its transform`: a source whose `cam()` changes with no `wake()` from the camera, woken by `magnify`, keeps a row each tick with the changing zoom.
  - `a begin and an end in one frame both reach the frames`: `magnify(0, "began")` and `magnify(0, "ended")` in one tick give rows with `gesture` 1 then 3.
  - `wheel deltas are AppKit's way round`: `wheel(10, 0, 4, 0)`, a browser `deltaX` of 10, gives `wheelDX` −10.
  - `a hidden page keeps no loop, and wakes on input`.
  - `no loop while recording is off`.
- [ ] **Step 2:** Run `node --test web/test/frames-recorder.test.ts`. Expected: fails, no module.
- [ ] **Step 3:** Implement `web/frames.ts`.
- [ ] **Step 4:** Run it. Expected: pass. Commit; open the PR with Task 2.

### Task 4: The app records frames, in every browser

**Files:**
- Modify: `web/app.ts` (the recorder beside `flight`), `web/main.ts` (input taps: the pointer, wheel and `gesture*` listeners at `main.ts:152-278`; `onCamera` at `main.ts:95`), `web/view.ts` (`View.apply` wakes the recorder), `web/native/surface.ts` (`shownCam(): Cam` composing `pinchTo`'s transform; `coverTop` from `.native-overlay`'s place against `#top`, as `scenarios/native-ios.e2e.ts` checks it), `web/surface.ts` (`coverTop` false in camera mode), `web/grid.ts` (`short(view: DOMRect): number`)
- Test: `web/test/flight-app.test.ts`, `web/test/grid.test.ts`, `scenarios/browsers.e2e.ts`

**Interfaces:**
- Consumes: Task 3's `FrameRecorder`, `FrameSource`; `View.board()` (`web/view.ts:227`), `View.stage()` (`:222`).
- Produces: `App.frames: FrameRecorder`; `NativeSurface.shownCam()`; `Grid.short(view)`.

- [ ] **Step 1: Write the failing tests:**
  - `flight-app.test.ts`, `a pan keeps frames in the recording`: with `FakeView`, a two-finger pinch through `App`'s inputs gives a recording whose `frames` rows have `zoom` changing and `gesture` 1, 2 and 3.
  - `grid.test.ts`, `the grid's shortfall`: a canvas rect 40 pt short of the view's right gives 40; covering, 0.
  - `browsers.e2e.ts`, in each pair's existing pinch or wheel case (Chromium, WebKit, Firefox, Chrome and Firefox on the Android emulator, Safari on the iOS Simulator as an iPhone 17 and as the Home Screen app): after the gesture, `globalThis.breezyFlight.recording().frames` has rows, its fields are `Flight.frameFields`, and `zoom` or `camX` changes across them. Name: `frames are kept on <device>`.
- [ ] **Step 2:** Run `node --test web/test/flight-app.test.ts web/test/grid.test.ts`. Expected: fail.
- [ ] **Step 3:** Implement the wiring; `FrameSource.cam()` is `NativeSurface.shownCam()` in native mode, `View.cam` in camera mode.
- [ ] **Step 4:** Run `npm test`, `npm run check`, and `SCENARIO_PAIRS=chromium:chromium,webkit:webkit,firefox:firefox node --test scenarios/browsers.e2e.ts --test-name-pattern="frames are kept"`. Expected: pass.
- [ ] **Step 5:** Launch: `node scripts/launch.ts --ref-without-recorder`, in turns on this Mac. Expected: no `WORSE`. The numbers go in the PR.
- [ ] **Step 6:** Commit; open the PR; dispatch `nightly.yaml --ref <branch> --field only=ios` and `only=android` for the devices Main doesn't run.

### Task 5: "That looked off" on the web

**Files:**
- Modify: `web/index.html` (`<button data-act="looked-off">That Looked Off</button>` after Report a Problem), `web/ui.ts` (its case), `web/library.ts` (`lookedOff()` beside `reportProblem()`, `reporter.report("off")`), `web/keys.ts` (⌥⌘L on the Mac, Ctrl+Alt+L elsewhere, as the Mac app's ⌥⌘L)
- Test: `web/test/diag.test.ts` (it covers `Reporter`), `web/test/keys.test.ts`

**Interfaces:**
- Consumes: `Reporter.report("off")` (`web/diag.ts`); Task 4's frames.
- Produces: `Library.lookedOff(): Promise<boolean>`; the key action `"looked-off"`.

- [ ] **Step 1: Write the failing tests:**
  - `that looked off sends the frames as "off"`: with a fake `send`, `lookedOff()` sends `why` `"off"` and the recording's frames.
  - `that looked off is not limited to once in ten minutes`: two in a row both send.
  - `⌥⌘L is that looked off on the Mac, Ctrl+Alt+L elsewhere`.
- [ ] **Step 2:** Run them. Expected: fail.
- [ ] **Step 3:** Implement; the toast says what Report a Problem's says, naming "That Looked Off".
- [ ] **Step 4:** Run `npm test`, then by hand in Firefox on `npm run dev`: ⌥⌘L after a pinch, then `BREEZY_INVITE='<a dev space's invite>' node scripts/diag.ts` lists it with reason `off` and its frames. Expected: listed.
- [ ] **Step 5:** Commit; open the PR.

### Task 6: Spike — do posted strokes replay into Firefox?

Throwaway, on `spike/firefox-replay`, never merged. It settles whether Task 7 can be done, and how.

- [ ] **Step 1:** With `npm run dev` and Firefox (a fresh profile, never the owner's) on a board in native panning, post `build/reference-strokes/take-5`'s pan strokes with `scripts/replay-helper.swift` (phase 1's route, as `scripts/reference-batch.ts` does), then one pinch stroke. Pull the page's recording (`globalThis.breezyFlight`, or the dev upload to `build/flight/`).
- [ ] **Step 2:** Compare each replay's frames against the stroke's own `reference-replay` track with `node scripts/frames/check.ts --ref … --replayed`. A pan passes when every event arrived (delta sums equal, as `appkit-edge-findings` says to count) and the curve holds within `REPLAYED`. A pinch: whether Firefox zooms on a posted gesture at all, which NSScrollView does not.
- [ ] **Step 3:** Write the verdict in the spec's "Spike findings": which strokes replay, by which route, with their numbers. If posted pinches don't reach Firefox, say so; Task 7 then judges pans only, and pinches wait for a route that is proven.

### Task 7: The owner's strokes, replayed into Firefox

**Files:**
- Create: `scripts/web-fixture.ts` (as `scripts/frames-fixture.ts`, into a Firefox page), `scripts/test/fixtures/web-pinch/firefox-<sha>/`, `scripts/test/web-pinch.test.ts`, `scripts/test/web-pinch-known.json`
- Modify: `docs/escapes.md` for anything found, each found thing its own fix PR (spec non-goal)

**Interfaces:**
- Consumes: Task 6's route; Tasks 1–4.
- Produces: `node scripts/web-fixture.ts --browser firefox --build <name> [--only <prefix>]`.

- [ ] **Step 1:** Write `web-pinch.test.ts` as `mac-pinch.test.ts`: each build's findings, every rule, against `reference-replay` with a replay tolerance measured from Firefox's own repeats (three replays of each stroke, the spread written beside the tolerance).
- [ ] **Step 2:** Record main's build. Count every rule per stroke; write `web-pinch-known.json`.
- [ ] **Step 3:** Run `node --test scripts/test/web-pinch.test.ts`. Expected: pass. Commit; open the PR; each finding is listed in the PR for the owner, not fixed here.
