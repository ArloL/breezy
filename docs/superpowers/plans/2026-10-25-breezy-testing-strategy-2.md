# Testing strategy, step 2: B1 as an invariant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After every step of every scenario, the card being edited is on screen; the hub's fakes become honest enough to show the iOS new-card bug, which is then fixed.

**Architecture:** The cause, reproduced on the iOS Simulator 2026-10-25: `App.beginEdit` starts a spring to zoom 1 and calls `revealEditing` at once; `View.reveal` measures against the camera as it is (zoom 0.25, where the card fits), so it does nothing, and the zoom ends around the card's top centre with its left part, and the caret, off screen. A reveal during the keyboard's rise instead springs to the half-way zoom (seen in a Safari tab: the zoom stopped near 0.6). The fix: reveal aims from the camera's destination. The fakes could not show it, as `FakeView.reveal` is a no-op, its camera never animates, and it has no keyboard. So: a shared pure `revealing()`, an animating `FakeView` with a phone screen and keyboard, a `sight()` on every device, and a proxy that checks it after each step.

**Tech Stack:** TypeScript on Node 24 (`node --test`), the fuzz hub's virtual time, Playwright for browsers, Swift for the Mac's control port.

**Spec:** `docs/superpowers/specs/2026-10-25-breezy-testing-strategy-design.md` (section "B1 as an invariant", "Order" item 2)

## Global Constraints

- In sight means: the edited card's box lies inside the visible box (1 pt tolerance); for a card within 32 pt of filling it, as the app judges, its caret's box does. Checked once the device stands still after the step: three readings alike 50 ms apart, within 5 s (revised after review).
- Only the card being edited is a focus in this step; search matches and selections stay for later (the matrix says so).
- Phone screen on the hub (my values, from a screenshot of the iPhone 17 simulator, to be replaced by step 5's contract suites): 402 × 874 pt; the board shows from y 120 (below the top bar) to y 774 (above the bottom bar) at rest; a keyboard 336 pt tall arrives 300 ms after an editor takes focus and leaves 300 ms after it loses it; while editing, the keys bar (44 pt, `KEYS_H`) sits on the keyboard.
- Plant: `reveal-current` — `Camera.goal()` returns the camera as it is.
- No new dependencies. Branch `testing-strategy-2`, stacked on `testing-strategy`. Commits end with `Claude-Session: https://claude.ai/code/session_01WjCKBwgpJMWYywtHYsPaX7`.

## Review Focus

1. A reveal while a coast (not a spring) runs: aim from the camera as it is; a coast has no destination worth chasing.
2. A card wider than the visible box on a phone at zoom 2: in sight by its caret, not failing forever.
3. A step after which the editor closes (Esc, a tap on the board): nothing is being edited, so nothing to check — never a failure.
4. A lane title being renamed: not a card; no focus box, no check.
5. The invariant's own failure must say which step, the focus box, the caret box and the visible box, so a run explains itself.

---

### Task 1: The reveal, shared and aimed at the destination

**Files:**
- Modify: `web/camera.ts` (add `Camera.goal()`, `revealing()`)
- Modify: `web/view.ts:190-204` (`View.reveal` uses them)
- Modify: `web/app.ts:288-298` (`revealEditing` decides "too tall" at the destination's zoom)
- Test: `web/test/camera.test.ts`

**Interfaces:**
- Produces:
  - `Camera.goal(): Cam` — where a running spring ends on every axis it springs; otherwise `cam`. `planted("reveal-current")` makes it return `cam`.
  - `revealing(cam: Cam, r: Rect, a: Area, prefer?: "top" | "bottom"): Cam | null` — `View.reveal`'s arithmetic (16 pt pad) as a pure function: the camera that pans the least from `cam` to show world rect `r` in screen area `a`, or null when `r` already shows.
  - `View.reveal(r, prefer)` = `revealing(this.camera.goal(), …)`, then `setCamera(to, true)` when not null.

- [ ] **Step 1: Failing tests** in `web/test/camera.test.ts`:
  - `test("goal is where a spring ends, and the camera itself when nothing moves")`: a `Camera` on a fake clock; `goal()` equals `cam` at rest; after `springTo({x: 10, y: 20, zoom: 1})` from zoom 0.25 and one frame, `goal()` deep-equals `{x: 10, y: 20, zoom: 1}` (zoom within 1e-9) while `cam.zoom` is still below 1.
  - `test("revealing pans the least to show a rect, and nothing when it shows")`: area `{top: 0, bottom: 800, left: 0, right: 1200}`, cam `{x: 0, y: 0, zoom: 1}`: a rect at x 1300 → `x` becomes `1200 - 16 - (1300 + w)`; a rect inside → null.
  - `test("revealing a card opened at 25 % while the zoom to 100 % springs keeps the card in the area at 100 %")`: the case of the bug in numbers — a 402 × 874 area from y 120 to y 538 (keyboard up), a card `{x: 0, y: 0, w: 240, h: 48}` whose top centre sits at screen (380, 500) at zoom 0.25; the spring's goal is zoom 1 about that point; `revealing(goal, card, area)` gives a camera at zoom 1 in which the card's screen box lies inside the area.

- [ ] **Step 2: Run, see them fail**

Run: `node --test web/test/camera.test.ts`
Expected: FAIL — `goal` and `revealing` are not defined.

- [ ] **Step 3: Implement** `Camera.goal()` and `revealing()` in `web/camera.ts`; `View.reveal` calls them; in `revealEditing`, the "taller than what shows" test uses `this.view.camera.goal().zoom` while the caret's DOM offset is still divided by the current zoom (the DOM is drawn at the current camera).

- [ ] **Step 4: Run, see them pass; and the whole web suite**

Run: `node --test web/test/camera.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit** — "Reveal what is edited from where the camera is going, not where it is: …" naming the bug and the simulator reproduction.

### Task 2: Honest fakes — animation, a phone screen, a keyboard

**Files:**
- Modify: `web/test/fakes.ts` (`FakeView`, `FakeUI`, new `Screen`)
- Modify: `scripts/fuzz/web-device.ts` (a `screen` command; `sight` command; `still` support)
- Test: `web/test/fakes.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's `revealing`, `Camera.goal`.
- Produces:
  - `interface Screen { w: number; h: number; top: number; bottom: number; keyboard: number; keyboardMs: number }` and `DESKTOP: Screen` = `{w: 1200, h: 800, top: 0, bottom: 800, keyboard: 0, keyboardMs: 0}`, `PHONE: Screen` = `{w: 402, h: 874, top: 120, bottom: 774, keyboard: 336, keyboardMs: 300}`, in `web/test/fakes.ts`.
  - `FakeView.screen: Screen` (default `DESKTOP`); `FakeView.area()`: `{top, left: 0, right: w, bottom}` at rest; with the keyboard up, `bottom = h - keyboard - KEYS_H`.
  - The keyboard rises `keyboardMs` after a `FakeField` takes focus while `app.touching` and the screen has one, and falls `keyboardMs` after focus leaves; each change calls `app.revealEditing()`, as `UI`'s `visualViewport` resize does.
  - `FakeView.setCamera(cam, animate)` springs when `animate`, as `View` does; `FakeView.reveal` = `View.reveal` over `this.area()`.
  - `FakeView.caretRect(id, back, at)`: `{x: screen x of card + 12·zoom, y: screen y of card + (12 + 24·(lines − 1))·zoom, h: 24·zoom}`, lines counted in the text up to `at`.
  - `FakeView.sight(): Sight | null` (type from Task 3) — editing card's screen box, its caret box, `area()`.
  - `FakeView.still(): boolean` — the camera is not moving and no keyboard change is pending.
  - Hub commands for web devices: `screen` (`{cmd: "screen", screen: Screen}`), `sight`, `still`.

- [ ] **Step 1: Failing tests** in `web/test/fakes.test.ts`, an `App` on `fakePorts` with `screen = PHONE`, on a fake clock:
  - `test("a phone's keyboard rises after an editor takes focus, and the area above it shrinks")`
  - `test("an animated camera move springs, and still says when it has stopped")`
  - `test("reveal pans the fake's camera to show a rect, as View does")`

- [ ] **Step 2: Run, see them fail** — `node --test web/test/fakes.test.ts` → FAIL.

- [ ] **Step 3: Implement** the Interfaces above.

- [ ] **Step 4: Run the web suite, the scenarios on the hub and the fuzzer's tests**

Run: `npm test && swift build --package-path BreezyKit --product breezy-sim && node --test scenarios/*.test.ts && node --test scripts/fuzz/test/*.test.ts && node scripts/fuzz.ts --seeds 1-10 --steps 200`
Expected: PASS. A hub case that now reads the camera mid-spring waits with `still` (Task 3), never with a fixed wait.

- [ ] **Step 5: Commit** — "Give the hub's fakes a camera that springs, a phone's screen and its keyboard, as a phone has them: …".

### Task 3: `sight()`, the invariant, and a phone on the hub

**Files:**
- Create: `scenarios/sight.ts`, `scenarios/sight.test.ts`
- Modify: `scenarios/device.ts` (`Sight`, `Device.sight()`, `Editor.card`, `Editor.board`)
- Modify: `scenarios/world.ts` (`Kind` gains `"phone"`; `SimDevice.size`, `still`, `sight`; `World.start(kinds, seed, plant?)`)
- Modify: `scenarios/cases.test.ts` (kinds `["swift", "web", "phone"]`, a phone acts only in touch cases and never watches; devices wrapped by `watchSight`)
- Modify: `scenarios/cases.ts` (a case: "a card made with a double tap at 25 % zoom on a phone is in sight before any key")

**Interfaces:**
- Consumes: Task 2's hub commands.
- Produces:
  - `interface Sight { focus: Box | null; caret: Box | null; visible: Box }` (screen points) in `scenarios/device.ts`; `Device.sight(): Promise<Sight | null>` — default: when `draws`, null if `editor()` is null, else `{focus: e.card, caret: e.caret, visible: e.board}`; when not `draws`, null.
  - `Editor.card: Box | null` (the edited card as drawn) and `Editor.board: Box` (what of the screen shows the board: the view less the bars over it).
  - `outOfSight(s: Sight): string | null` in `scenarios/sight.ts` — the problem in words, or null.
  - `watchSight<T extends Device>(d: T): T` in `scenarios/sight.ts` — a proxy: after each method a case calls that acts (not in `LOOKS`, not `wait`, `until`, `still`, `sight`), polls `sight()` per the Global Constraints and throws `Error("out of sight after <method>(<args>): <problem>")`. Export `LOOKS` from `scenarios/record.ts` for it.

- [ ] **Step 1: Failing tests** in `scenarios/sight.test.ts`:
  - `test("a card inside what shows is in sight")`, `test("a card under the keyboard is out of sight")`, `test("a card taller than what shows is in sight by its caret")`, `test("nothing edited is nothing to check")`, `test("a failure names the focus, the caret and what shows")` — on `outOfSight`.
  - `test("a step that leaves the edited card off screen fails on the hub")` — with `World.start(["phone", "web"], 1, "reveal-current")`, the new case throws `/out of sight after doubleTap/`.

- [ ] **Step 2: Run, see them fail.** `node --test scenarios/sight.test.ts` → FAIL.

- [ ] **Step 3: Implement** the Interfaces; the new case pinches the phone's board to zoom 0.25, waits `still`, double-taps world point under screen (380, 500), and ends the edit; the invariant does the checking.

- [ ] **Step 4: Watch the bug show without the fix.** Temporarily revert Task 1's `View`/`FakeView` reveal to aim from `cam` (or run with plant `reveal-current`); the new case fails on `phone → web` with "out of sight after doubleTap". Record the message in the ledger. Restore.

- [ ] **Step 5: Run all hub scenarios** — `node --test scenarios/*.test.ts` → PASS.

- [ ] **Step 6: Commit** — "Check after every step of every scenario that the card being edited is in sight, …".

### Task 4: Real devices report their sight

**Files:**
- Modify: `scenarios/browser.ts` (`readEditor` fills `card` and `board`; `RealWorld.stage()` wraps devices in `watchSight` outside `steps.wrap`)
- Modify: `Breezy/Support/Control.swift` (`editor` adds `card`, the edited card's frame as `box`, and `board`, equal to `view`)

**Interfaces:**
- Consumes: Task 3's `Editor.card`, `Editor.board`, `watchSight`.

- [ ] **Step 1: In `readEditor`**, `card` = the bounding box of `.cards > [data-id]` that contains the focused editor (null for a lane title); `board` = the visual viewport less what covers it: below `#top` (or `#find` when shown), above `#keys` and `#bottom` where shown. Read off the DOM, not from the app's `area()`.

- [ ] **Step 2: In `Control.swift`'s `editor`**, add `"card"` (the edited card's frame through `box`) and `"board"` (as `view`). Build: `xcodebuild -project Breezy.xcodeproj -scheme Breezy -configuration Debug -derivedDataPath build build` → succeeds.

- [ ] **Step 3: Run the cases on real desktop browsers and the Mac**

Run: `SCENARIO_PAIRS="chromium:webkit webkit:firefox firefox:mac mac:chromium" node --test --test-force-exit scenarios/browsers.e2e.ts`
Expected: PASS; a failure "out of sight after …" is either a real B1 bug (log it in `docs/escapes.md`, fix it with a test first) or a wrong `board` reading (fix the reader).

- [ ] **Step 4: Run the touch cases on the Android emulator** — `MISE_ENV=android mise exec -- node scripts/android.ts`, then `SCENARIO_PAIRS="android:chromium firefox-android:webkit" MISE_ENV=android mise exec -- node --test --test-force-exit scenarios/browsers.e2e.ts` → PASS (or as Step 3).

- [ ] **Step 5: Commit** — "Read what each real device shows of the board and its edited card, so that every case checks it is in sight there too".

### Task 5: The record

**Files:**
- Modify: `TESTING.md` (B1 row: L3 `plant: reveal-current`, L6 `claimed`; a line saying search matches and selections are not yet a focus, and the Mac reads its whole view)
- Modify: `docs/escapes.md` (the open iOS row: Test `scenarios/sight.test.ts`, Commit Task 1's hash; Should have caught stays L3)
- Modify: `docs/superpowers/specs/2026-10-25-breezy-testing-strategy-design.md` (under "B1 as an invariant": the cause as reproduced)

- [ ] **Step 1: Edit the three files.**
- [ ] **Step 2: Run** `npm test` → PASS (the docs test checks the plant exists and the test file is a file).
- [ ] **Step 3: Commit**, push `testing-strategy-2`, open a draft PR based on `testing-strategy`.
