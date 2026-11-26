# Breezy feel at every level — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The rules over frames judge the owner's 41 reference strokes on every push in seconds, and in every browser nightly in minutes, with the real-input replay into Firefox kept only to calibrate the cheaper levels against.

**Architecture:** Four levels feed the same rules (`scripts/frames/check.ts`) from the same strokes:
- **Level 1:** frozen tracks, which exist today.
- **Level 2:** the web core in Node on a fake clock, fed each stroke's input as a browser handed it to the page.
- **Level 3:** Playwright-driven browsers, given the same input as synthetic events.
- **Level 4:** real OS input posted into a Playwright-launched Firefox.

A level-2 or level-3 track is trusted only while it matches level 4's for the same stroke, within that level's own tolerance; a stroke that drifts is "the fake taught when it was wrong" (`AGENTS.md`).

**Tech Stack:** TypeScript on Node 26 (`node --test`), Playwright (`playwright-core`), Swift (`scripts/post-stroke.swift`).

**Spec:** `docs/superpowers/specs/2026-11-11-breezy-native-reference-2-design.md` (rules over frames, replay on each platform); `TESTING.md` (levels L1–L8). Builds on `docs/superpowers/plans/2026-11-26-breezy-native-reference-2-web.md`, Tasks 4 and 7 merged first.

## Global Constraints

- Never `breezy.k5d.de` in a copy of the owner's Firefox profile (`AGENTS.md`): level 4 runs in a Firefox that Playwright launches, never the owner's app.
- Every wait has a deadline; test files exit on their own with a whole-file deadline; CI jobs carry `timeout-minutes`. Main's gate stays within ten minutes.
- `npm test`, not `node --test --test-force-exit`, for any suite over several files: with the flag, a file's later results can be dropped with no failure (`.superpowers/sdd/2026-11-26-breezy-native-reference-2-web/progress.md`, the harness finding).
- Every rule counted against main's build, not only the reports, before a `*-known.json` takes a build.
- A stroke's input is what the page received, per frame, from the level-4 capture (`wheelDX`, `wheelDY`, `wheelPhase`, `momentumPhase`, `magnify`, `gesture`, `px`, `py`): no `CGEvent` is decoded below level 4.

## Review Focus

1. **A capture whose input was coalesced differently by the browser:** level 2 and 3 replay a frame's summed deltas as one event; continuity must not read the regrouping as a jump. Pinned in Task 1 (`one event a frame reproduces the capture's camera`).
2. **Camera mode against native panning:** level 2 can only run camera mode; its calibration must compare against a camera-mode capture, never a native one. Pinned in Task 4 (`each level calibrates against its own mode's capture`).
3. **A browser that ignores synthetic ⌃-wheel as a pinch** (WebKit takes gesture events): level 3 must say which browsers it could pinch in, not pass silently. Pinned in Task 2.
4. **A stroke longer than the recorder's 30 s ring:** none are today. The fixture keeps the whole track, and `web-fixture.ts` fails a stroke whose capture lost its start. Pinned in Task 3.
5. **Fixtures made on a busy Mac:** a level-4 capture under load drops frames. The calibration's tolerance is Firefox's own repeat spread, measured once and written beside it. Pinned in Task 4.

---

PRs, each off main: Task 3 first (it makes the captures the others replay), then Task 1, Task 2, Task 4.

### Task 1: Level 2 — the web core replays a capture in Node

**Files:**
- Create: `web/test/helpers/stroke-replay.ts`, `web/test/web-core-strokes.test.ts`, `web/test/web-core-strokes-known.json`
- Test fixtures: `scripts/test/fixtures/web-pinch/<build>-camera/` (Task 3)

**Interfaces:**
- Consumes: a capture `FrameTrack` (Task 3); `App` with `FakeView` (`web/test/fakes.ts`); `WheelFrames` and the pinch inputs (#315).
- Produces: `replayCapture(capture: FrameTrack, opts?: { stage?: { w: number; h: number } }): FrameTrack`. It plays each capture row's input at the row's `t` on a fake clock, at 120 Hz: a wheel delta as one wheel event, a `magnify` as a ⌃-wheel step, a `gesture` 1 or 3 as a stream's begin or end. It returns `App.frames`'s track.

- [ ] **Step 1: Write the failing tests** in `web-core-strokes.test.ts`:
  - `one event a frame reproduces the capture's camera`: a hand-built capture of 20 frames, each with `wheelDY` −10, gives a camera that moves 200 pt.
  - `each stroke's replay in Node, every rule against AppKit's replay`: for each `<build>-camera` capture, `check(replayCapture(c), reference-replay, REPLAYED)` gives findings equal to `web-core-strokes-known.json`.
- [ ] **Step 2:** Run `node --test web/test/web-core-strokes.test.ts`. Expected: fails, no `replayCapture`.
- [ ] **Step 3:** Implement `stroke-replay.ts` on `App`, `FakeView` and a fake clock, as `web/test/helpers/replay.ts` drives `WheelPan`.
- [ ] **Step 4:** Count every rule on main's build; write the known file. Run `npm test`. Expected: pass, in seconds.
- [ ] **Step 5:** Commit; open the PR.

### Task 2: Level 3 — browsers replay a capture as synthetic events

**Files:**
- Create: `scenarios/strokes.e2e.ts`, `scenarios/strokes-known.json`
- Modify: `.github/workflows/nightly.yaml` (a `strokes` job, `timeout-minutes: 20`, Chromium, WebKit and Firefox in parallel); `.github/workflows/main.yaml` (a smoke of one stroke per kind: slow, fast, corner, past max, double tap, pinch-pan, lift mid-band)

**Interfaces:**
- Consumes: Task 3's captures; `scenarios/browser.ts`'s `buildSite`, `serveStatic`.
- Produces: `playCapture(page: Page, capture: FrameTrack): Promise<FrameTrack>`. It dispatches each row's input at its `t`: `page.mouse.wheel` for a pan, and ⌃ held over a `page.mouse.wheel` for a pinch. It reads `globalThis.breezyFlight.recording().frames` straight away, with no upload wait.

- [ ] **Step 1: Write the failing test** `each stroke in each browser, every rule against AppKit's replay`: findings per browser equal to `strokes-known.json`. A browser that zoomed for none of the pinch strokes fails with `<browser> took no synthetic pinch`, rather than pass.
- [ ] **Step 2:** Run `SCENARIO_PAIRS=chromium:chromium node --test scenarios/strokes.e2e.ts`. Expected: fails, no `playCapture`.
- [ ] **Step 3:** Implement. Pages run headless, one browser each in parallel, each with its own whole-file deadline.
- [ ] **Step 4:** Run all three browsers locally. Expected: under 3 minutes per browser, every rule counted against main's build into the known file.
- [ ] **Step 5:** Commit; open the PR; dispatch `nightly.yaml --field only=strokes` once, to read its time on CI.

### Task 3: Level 4 — real input into a Firefox Playwright launches

**Files:**
- Modify: `scripts/web-fixture.ts` (Playwright's Firefox, headed; read back by `page.evaluate`; `--pan camera|native`; `--repeats 1` by default; `--smoke`, one stroke per kind)
- Test: `scripts/test/web-fixture.test.ts` (`startCam`, the window offset)

**Interfaces:**
- Produces:
  - **Captures:** `scripts/test/fixtures/web-pinch/<build>-<pan>/<stroke>.json`, in which a stroke whose first frame comes after its first event fails, as its start was lost.
  - **Repeats:** `build/web-pinch/<build>-<pan>-<n>/` for the spread of Firefox's own repeats.
  - **The tolerance:** `scripts/test/fixtures/web-pinch/tolerance.json`: `{ curve, follow }` measured from those repeats, with the build and the date.

- [ ] **Step 1: Write the failing tests:** `startCam places a stroke as Replay.swift does` (a centred stroke and a corner stroke, at 0.5 and 1); `the offset maps the reference's view onto the page's`.
- [ ] **Step 2:** Run them. Expected: fail.
- [ ] **Step 3:** Implement. No `open -a Firefox`; the poster posts into the Playwright window, which it activates by its pid.
- [ ] **Step 4:** Run `node scripts/web-fixture.ts --build <sha> --pan camera --repeats 3`, then `--pan native --repeats 1`, by hand on the owner's Mac. Expected: about 4 minutes a pass of 41 strokes. The numbers go in the PR.
- [ ] **Step 5:** Commit the captures and the tolerance; open the PR.

### Task 4: Calibration — each level holds to level 4

**Files:**
- Create: `scripts/test/feel-levels.test.ts`
- Modify: `TESTING.md` (the levels' row for B6, feel: L1 frozen tracks, L2 Node, L3 browsers nightly, L4 by hand to calibrate), `docs/escapes.md` (a drift found is logged)

**Interfaces:**
- Consumes: Tasks 1–3; `tolerance.json`.

- [ ] **Step 1: Write the failing test** `each level calibrates against its own mode's capture`. For each stroke, `curve(level2, camera capture, "zoom", tol.curve)` and `follow`'s slip give no finding past `tolerance.json`. The same holds for level 3's Firefox track against the native capture.
- [ ] **Step 2:** Run it. Expected: fails until Tasks 1–3's tracks are in place.
- [ ] **Step 3:** Add a `--calibrate` flag to `web-fixture.ts`. It re-captures only the strokes whose calibration failed, so a drift costs minutes, not a full run.
- [ ] **Step 4:** Run `npm test`. Expected: pass.
- [ ] **Step 5:** Commit; open the PR.
