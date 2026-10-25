# Testing strategy, step 3: the iPhone acts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safari on the iOS Simulator acts in every touch case — taps, holds, drags, double taps, the one-finger zoom and typing through iOS's own keyboard — so B1, B2 and B3 are checked as iOS really does them; and, if the simulator allows it, from the Home Screen as the owner uses it.

**Architecture:** Touches go through idb's HID stream, as `scripts/sim-touch.py` already sends them: one gesture is one stream, so a double tap's 40 ms gaps hold on a loaded runner (WebDriver's quarter-second touches are why the iPhone only watched). A long-lived helper keeps the idb connection open. Page points map to screen points by a calibration tap, as `Touchscreen.of` does on Android. The page is still read through safaridriver. The Home Screen is a spike: a web clip added by tapping through Share, read by an agent script the scenarios' server injects, since safaridriver reaches Safari's tabs only.

**Tech Stack:** Python with fb-idb (`uv run --script`), idb_companion, safaridriver, TypeScript scenarios.

**Spec:** `docs/superpowers/specs/2026-10-25-breezy-testing-strategy-design.md` ("The iPhone acts")

## Global Constraints

- Pass criterion of the spike (spec): a double tap's two touches land within the app's 300 ms on a loaded runner, and the keyboard comes up as for a finger.
- One finger only: idb's HID touch has one point. Cases that pinch keep the iPhone watching; the 25 % case zooms with the app's one-finger zoom (tap, then touch again and drag), which every device kind takes.
- If the Home Screen cannot be driven, L6 runs in a Safari tab and `TESTING.md` marks standalone mode uncovered for B1 and B5.
- No new npm dependencies; Python dependencies inline in the script, as `scripts/sim-touch.py`.

## Review Focus

1. The helper dying mid-case: the next gesture fails naming it, rather than hang the case.
2. A gesture whose page point lies under Safari's toolbar or the keyboard: the touch lands on Safari, not the page; the calibration and `size()` must leave those out.
3. Typing while no editor has the keyboard: refused, as `BrowserDevice.type` waits for `editing`.
4. Two simulators booted: the helper names which it drives, from `scripts/ios.ts`'s choice.
5. The iPhone's keyboard is iOS's software keyboard, not a hardware one: `Connect Hardware Keyboard` off.

---

### Task 1: A helper that streams gestures into the simulator

**Files:** Create `scripts/sim-hid.py`; Test `scenarios/platform/sim-hid.test.ts` (skipped without a booted simulator)

**Interfaces:**
- Produces: `scripts/sim-hid.py UDID` reads JSON lines on stdin and answers each with one JSON line: `{"touches": [[ms, "down"|"move"|"up", x, y], …]}` sends one HID stream (each after its wait), `{"text": "…"}` types it through idb's keyboard, `{"key": "return"|"delete"|…}` presses one key; the answer is `{"ok": true, "ms": <time the stream took>}` or `{"error": "…"}`.
- `class SimHid { static start(udid: string): Promise<SimHid>; touches(frames: [number, PointerPhase, Point][]): Promise<number>; text(s: string): Promise<void>; key(k: string): Promise<void>; stop(): void }` in `scenarios/ios.ts`.

- [ ] Test: a double tap on a calibration page (listening for `pointerdown` as `Touchscreen.of` does) records two downs 80–200 ms apart and at the page point sent; `text("ab")` into a focused input gives "ab".
- [ ] Run → FAIL; implement; run → PASS; commit.

### Task 2: `IosDevice` acts in a Safari tab

**Files:** Modify `scenarios/ios.ts`, `scenarios/browser.ts` (create it with `SimHid`), `scenarios/browsers.e2e.ts` (an acting iPhone takes touch cases), `scenarios/cases.ts` (the 25 % case zooms with one finger), `.github/workflows/ios.yaml` (idb_companion, `SCENARIO_PAIRS: "chromium:ios-safari ios-safari:chromium"`)

- [ ] `IosDevice.gesture(frames)` sends one stream in screen points (page point + calibrated offset); `pointer`, `type`, `key`, `still`, `size` (the page's, less Safari's bars), `addCard`/`addLane` as a phone makes them; `fingers` with two fingers throws "one finger only".
- [ ] Run: `node scripts/ios.ts && SCENARIO_PAIRS="ios-safari:chromium" node --test --test-force-exit scenarios/browsers.e2e.ts` → every touch case passes or names a real iOS bug (logged in `docs/escapes.md`, fixed test-first).
- [ ] Commit; push; dispatch `ios.yaml` on the branch and read its result.

### Task 3: Spike — the Home Screen

- [ ] Add the web app to the simulator's Home Screen by tapping Share → Add to Home Screen → Add, finding each by `idb ui describe-all`; launch it by its icon.
- [ ] Serve the scenarios' page with an agent script (`?agent=1` only in the scenarios' server) that polls `/agent` for a function source and posts its result; `AgentPage.evaluate` mirrors `IosPage.evaluate`.
- [ ] Run the 25 % case from the Home Screen. Record what worked in the spec. If any part cannot be done, stop the spike, mark standalone uncovered in `TESTING.md`, and say why.

### Task 4: The record

- [ ] `TESTING.md`: L6's iPhone acts; matrix B1/B3 L6 cells as before (`claimed`) until step 4's plants; the spike's outcome.
