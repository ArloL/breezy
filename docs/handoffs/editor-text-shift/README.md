# Handoff: card text shifts when editing starts (Breezy)

Repo: `~/Developer/breezy`, branch `main`, clean at `ae9ad29`. Read `README.md` for build/test commands.

## Symptom

Double-clicking a card to edit it changes how its text looks, ever so slightly. The user's screenshots, at 89 % zoom in dark mode, card "Feedback / Lehrpfade / growify" in lane DOING of `~/Documents/board.breezy`:

- `~/Desktop/Screenshot 2026-10-07 at 08.50.48.png`: card selected (orange ring), probably editing
- `~/Desktop/Screenshot 2026-10-07 at 08.51.17.png`: same card, not selected

Measured on the title (crop 330×95 px at 1035,1588 of the 3024 px-wide screenshots): in the first screenshot the text is 0.8 px higher, 0.4 px further left and has about 4 % more ink, so it looks slightly bolder. Confirm with the user which screenshot is the editing one; it isn't certain.

## Mechanism

- **Not editing:** a `CardLayer` (`Breezy/Canvas/CardLayer.swift`) shows an IOSurface bitmap that it draws itself with `NSAttributedString.draw(with:)`. `contentsScale` is `backingScale × zoom`, rounded up to a quarter step (`CanvasView.layoutCards`).
- **Editing:** the layer draws the card without text (`Look.editing`), and an `EditorTextView` (TextKit 1, `CanvasView+Editing.swift` `beginEdit`) is a subview of `CanvasView`, the magnified document view of the `NSScrollView`. `editorFrame` offsets it by −1 pt because "a text view sets its lines 1 pt lower than the card's string drawing". That fudge may hold only at 100 %.

## Established

- At 100 % zoom (light), the window before and during editing is pixel-identical (0 differing pixels).
- At 80 % and 130 % there is a sub-pixel shift. At 130 % the editor text is also visibly sharper.
- Drawing card bitmaps at the exact zoom instead of the quarter step does not remove it: the editor still shows 7–10 % more ink.
- Font smoothing is ruled out, because 100 % already matches.
- Not caused by `ae9ad29` (the editor's height fix). That commit doesn't touch where or how the editor's text is drawn.

## Untested hypotheses

1. AppKit draws the text view's layer at `backingScale` in unmagnified view space, snapping glyphs and baselines to that pixel grid, and the compositor then scales it by the magnification. The card bitmap is drawn at `backingScale × zoom` instead. Different snapping means different positions and weights. Check `tv.layer?.contentsScale` and whether the text view is layer-backed with its own backing store.
2. The −1 pt fudge in `editorFrame` is really a rounding effect that is exact only at 100 %.

A good first experiment: render both offline at the same scale, `CardLayer.render(input)` for the plain card against the editor via `bitmapImageRepForCachingDisplay`/`cacheDisplay`. That separates drawing differences from compositor scaling.

## How to reproduce and measure

- Use the Release build: `xcodebuild -project Breezy.xcodeproj -scheme Breezy -configuration Release -derivedDataPath build build`.
- Debug launch options are in `Breezy/Support/DebugLaunch.swift`: `-BreezyBoard`, `-BreezyEdit any`, `-BreezyCapture png`, `-BreezyAppearance`.
- There is no zoom option. This temporary one worked (after the `appearance == "switch"` block):
  ```swift
  if let z = defaults.string(forKey: "BreezyZoom").flatMap(Double.init) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { wc.place(origin: NSPoint(x: CanvasView.origin - 100, y: CanvasView.origin - 100), zoom: z) }
  }
  ```
- Launch with `open -W -n -a "$PWD/build/Build/Products/Release/Breezy.app" --args ...`. A window hidden behind others draws no cards (`layoutCards` skips occluded windows), so launching the binary directly from a terminal captures an empty board.
- Pitfall: captures from separate launches differ in window placement by a few pixels, and the title shows the file name. Comparing two launches is unreliable; my own launch-to-launch measurements contradicted the user's screenshots. Instead, capture before and after `beginEdit` in **one** process, e.g. a temporary self-test or launch option that captures, starts editing, then captures again. `DebugLaunch.capture(window, to:)` does the capture.
- Measurement scripts are in this directory: `diff.swift` (count of differing pixels) and `profile.swift` (ink mass and centroid, for bright text on a dark card; for dark text use `0.65 - c.brightnessComponent`). Run them with `swift script.swift a.png b.png`. Fixture: `board.breezy`.

## Done means

Before and during editing match within anti-aliasing noise at 89 %, 130 % and 100 %, in light and dark mode. The check should run in one process (a self-test in `SelfTest.swift` with a fixture in `scripts/selftest/`). Typing must stay as cheap as now; see `docs/performance-journal.md` and `scripts/bench.sh`.
