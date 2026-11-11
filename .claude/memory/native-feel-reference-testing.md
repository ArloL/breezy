---
name: native-feel-reference-testing
description: "Idea parked 2026-11-10 for a fresh session — measure Breezy's pan/zoom/bounce against native UIScrollView/NSScrollView reference apps, and a native-scroll-container spike"
metadata:
  node_type: memory
  type: project
  originSessionId: a7f3b882-e6ff-4486-a48c-c78deacb57b8
  modified: 2026-11-11T20:37:18.927Z
---

The owner wants panning and zooming to feel like a native iOS/Mac app, "whatever it takes". Parked on 2026-11-10, to pick up in a fresh session once the bounded-canvas / trackpad rubber-band work (branch try/bounded-canvas) is finished:

1. **Reference apps as ground truth.** A tiny UIKit app with one UIScrollView set up like Freeform's canvas (content = board + 1,194 pt margin, bounces), logging contentOffset per frame (CADisplayLink) and the touches it got; a Mac twin with NSScrollView for the trackpad.
2. **Same input into both.** iPhone: scripts/wda.py timed touches (smooths moves). Simulator: scripts/sim-hid.py exact HID touch streams, CI-able. Mac: CGEvent scroll events with scrollPhase/momentumPhase fields (needs Accessibility for the posting app; VS Code lacked it, Terminal.app can be granted).
3. **Compare** with Breezy's camera per frame (flight recording) — overshoot, settle time, stretch per pt of pull, curve diff — as a gate like the feel gate. Capture the owner's real strokes in the reference app once, replay forever.
4. **Spike:** let the browser scroll natively (a scroll container sized to the board, our zoom on top) — the only way a page gets the OS's trackpad gesture/momentum phases, which JS wheel events lack; Breezy's WheelPan guesses them from delta shapes.

**Why:** tuning by feel loops ("feels off", "too slow"); the owner suggested recording native behaviour and replaying it onto Safari.
**Status 2026-11-10:** Mac edge measured against AppKit; WheelPan tuned (band 0.07, AppKit spring). Owner chose: best feel per platform by score + feel, "however big". Native panning (board in a real scroll container, Breezy zoom on top) designed in docs/superpowers/specs/2026-11-10-breezy-native-panning-design.md; throwaway spike on branch spike/native-pan passed every risk on Mac Firefox and iPhone (Firefox for iOS) by the owner's hand ("Spike findings" in that spec). Paused 2026-11-10: resume from docs/superpowers/plans/2026-11-10-breezy-native-panning.md, its 'Before you start' section (PR order: measuring kit, then tuned band, then native mode, each off main; #271 merged). Then the UIKit twin's plan; Android keeps camera. See [[appkit-edge-findings]], [[ios-native-scroll-quirks]].
**2026-11-11:** phase 2 designed (docs/superpowers/specs/2026-11-11-breezy-native-reference-2-design.md): frames recorded by default, "That looked off" on every platform, rules over frames, judged by whether they pinpoint what the owner reports. iOS is the north star, not a floor; Android/Windows aim at UIKit's feel, not their own; consistent and natural always beats iOS-like only at best, and a platform limit must be proven (recording + spike), never assumed, before falling back. mac-bounded-board waits on its step 1.
**How to apply:** follow that plan, not more heuristic tuning. Measured facts so far are in docs/superpowers/specs/2026-10-07-breezy-touch-native-feel-design.md; trackpad traces in web/test/trackpad-edge.json; see [[trackpad-edge-findings]].
