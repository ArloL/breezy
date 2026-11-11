---
name: appkit-edge-findings
description: What replaying the owner's trackpad strokes into AppKit, Firefox and WheelPan showed, and the setup quirks that took rounds to find
metadata:
  type: project
---

Measured 2026-11-10, macOS 27.0.1, Firefox 159, MacBook trackpad:

- AppKit's rubber band is far stiffer than UIKit's: 1,092 pt pushed past the edge stretched 50 pt. WheelPan (UIKit band, c = 0.5) stretches 4–8× as far.
- AppKit runs its own coast and stops short of the momentum deltas (545 pt of deltas moved 261); browsers and WheelPan apply them 1:1. A stock NSScrollView does the same, so it isn't the reference's doing.
- Firefox's native scrolling matches AppKit's stretch within ~15 % and holds it under a resting finger; flick impacts match neither.
- Setup: NSScrollView takes a gesture's events after the first on a background thread (responsive scrolling); override scrollWheel to see them. A held finger sends no events; Firefox and AppKit merge events (check delta sums, not counts); a browser's deltaX = −scrollingDeltaX.
- Accessibility and Screen Recording are granted to Visual Studio Code (the host app), so the replay helper and screencapture run from the session itself.

**Why:** these took several failed batches to find; they decide the next step for the trackpad feel.
**How to apply:** start from the spec's "Spike verdict"; re-run with `node scripts/reference-batch.ts` (helper: `swift scripts/replay-helper.swift`, dev server up, one Firefox tab). Related: [[native-feel-reference-testing]], [[trackpad-edge-findings]].
