# Breezy native reference — the trackpad's edge

On the owner's Mac, pulling the web board past its edge with the trackpad in Firefox feels off in every part: how far it stretches under the finger, how momentum meets the edge, and how it springs back. Tuning by feel has looped ("feels off", "too slow"). This replaces judging by feel with measuring against what AppKit does with the same stroke.

## Goals

- **Ground truth from AppKit.** A minimal Mac reference app: one `NSScrollView` whose document is the web board's stage plus Freeform's 1,194 pt margin, with AppKit's own elasticity and nothing of Breezy's. It logs each scroll event it gets (time, `scrollingDeltaX/Y`, `phase`, `momentumPhase`, precise or not) and the clip view's origin on every frame (`CADisplayLink`), the stretch included.
- **The owner's strokes, recorded once.** The owner makes a fixed set of strokes in the reference app: a slow push into the edge and hold, a slow push and release, flicks of three speeds into the edge, a push after a bounce, and a pull back out of a stretch. Each is kept as its event stream and AppKit's curve.
- **The same stroke into Firefox.** A replay tool posts a recorded stream as `CGEvent` scroll events, with the phase and momentum fields set, to whichever window is in front. The web board's dev page records the `wheel` events Firefox makes of them, with `WheelPan`'s camera on every frame, into `build/flight/`.
- **A comparison at the lowest level.** A fixture pairs each stroke's Firefox wheel events with AppKit's curve. A Node test plays the wheel events through `WheelPan` on the fake clock (`web/test/helpers/replay.ts`, as `wheel.test.ts` does) and compares the camera with AppKit's curve on four measures: the stretch for a given pull, the furthest overshoot, the time to settle within 0.5 pt, and the largest gap between the curves. It runs on Linux with the other web tests, with no Mac or browser needed.
- **A spike: let Firefox scroll the board.** A throwaway page with a native scroll container sized to the board and Breezy's zoom on top. Through the same replay it shows whether Firefox, which knows the gesture's phases, comes closer to AppKit than `WheelPan`'s guesses from delta sizes. The answer decides whether `WheelPan` is tuned against the reference or replaced.

## Non-goals

- iOS, touch and zoom. The plan was a UIKit twin with `scripts/wda.py` and `scripts/sim-hid.py`. It waits until the Mac's edge passes.
- Chrome. The replay posts OS events, so Chrome works the same way, but Firefox is what the owner uses and what is judged.
- Changing the native Mac Breezy. Its canvas is a fixed 40,032 pt square that never reaches its edge, so it can't serve as the reference as it stands.

## Anti-goals

- **Numbers that pass while it still feels off.** Every measure must be one the owner can feel. If the test passes and the owner still feels a difference, the measures are wrong and get fixed before any constant is tuned.
- **Comparing against a reference that isn't AppKit.** If replayed `CGEvent`s don't reproduce the owner's recorded curve in the reference app, the replay is wrong, and nothing is compared until it does.
- **More heuristic tuning without a reference curve to beat.**

## Constraints

- Posting `CGEvent`s needs Accessibility for the posting process. VS Code lacked it; Terminal.app can be granted it. The replay is a local tool run from Terminal.app.
- Test against localhost (`npm run dev`), never breezy.k5d.de (AGENTS.md).
- Firefox delivers about one event per 8 ms in pixel mode, and momentum ends in a tail of 1–2 pt deltas at 15–70 ms gaps, lasting up to 2 s (`trackpad-edge.json`). The fixture keeps the stream as delivered.
- Same window size and zoom on both sides: a 1200 × 762 stage at 75 %, as in `trackpad-edge.json`, unless the builder needs others. A pull's stretch depends on the stage's size on that axis.
- Every wait has a deadline: the replay, the recorder and the test end on their own.

## Decided

- AppKit's `NSScrollView` is the reference. The owner agreed.
- The flow is: record once in the reference app, replay into both, then compare. The owner agreed.
- The spike belongs in this work. The owner agreed.

- The owner records as many sessions of strokes as are needed. Each stroke gets repeats, so the tolerances come from how the owner's own strokes vary.
- Work starts on `try/bounded-canvas` (PR #271), which merges soon. It carries `WheelPan`'s band, the wheel flight entry and `build/flight/`. This work's PRs then go off main.

## My calls

- A standalone reference app, separate from Breezy.app, so only AppKit's behaviour is measured. It sits beside Breezy's targets in `project.yml`.
- The comparison is a Node unit test over a checked-in fixture, not a browser gate. The browser and the OS are needed only to make the fixture.
- The first step checks the replay: posting the recorded stream into the reference app must reproduce AppKit's recorded curve. Only then is Firefox compared.
- **Who drives the replays.** The owner launches the replay helper once from Terminal.app, which holds Accessibility, and it listens on a local socket that the agent sends replays to. The agent can then iterate alone, and the owner leaves the Mac alone while it runs. The helper accepts replays only from localhost, posts only scroll events, and exits after an idle hour. The fallback is the owner starting each batch.
- **Where this ends.** This work ends with the measures and the spike's verdict. Today's `WheelPan` differs from AppKit, so the comparison lands green: each measure is printed, AppKit's curve against the reproduced replay is asserted, and each `WheelPan` gap is a `todo` naming it. Tuning `WheelPan`, or replacing it, is the next piece of work, and it turns those `todo`s into assertions.
- **The spike's verdict** rests on the four measures, confirmed by the owner's feel on the same strokes. If it says replace, the replacement gets its own design, which covers Chrome, Safari, iOS touch and mouse wheels.
- **If replayed events never reproduce AppKit's curve** (posted momentum events may be treated differently from the system's own), the direction reverses. The owner strokes in Firefox while a `CGEventTap` records the OS's events, and those are posted into the reference app. That needs another recording session.

## Left to the builder

- How the reference app saves its recording, and the fixture's format, kept close to `trackpad-edge.json`.
- Whether the replay tool is Swift or Python with PyObjC (`scripts/sim-hid.py` is Python).
- How each comparison is reported, and its tolerances, set from how much the owner's own strokes and AppKit's curves vary over repeats.
- How the spike page measures its position past the edge, where Firefox's overscroll can't be read from script. It could be a screen capture tracking a marker.
