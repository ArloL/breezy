# Breezy

A whiteboard for work thoughts: sticky-note cards and lanes on an infinite canvas. A native Mac app; each board is a `.breezy` file.

## Build

```bash
mise install
xcodegen generate
xcodebuild -project Breezy.xcodeproj -scheme Breezy -configuration Release -derivedDataPath build build
open build/Build/Products/Release/Breezy.app
```

Boards save themselves and reopen where they were left after a relaunch; File → Revert To → Browse All Versions shows earlier states.

## Use

| Do | How |
|---|---|
| Pan / zoom | scroll / pinch or ⌘-scroll; ⌘0, ⇧0 or the zoom readout return to 100 % |
| Select | click; ⇧-click to add; drag on empty space for a box |
| New card | double-click empty space |
| Edit card | double-click it; Esc or ⌘↩ to finish; the first line is the title |
| Card back | Space over a card or its folded corner turns it over; Tab while editing turns it too |
| Stack | cards in a lane float up their column and make room where you drag one in; ⌥-drag takes a card with those below it |
| Colour | `1`–`5` |
| Delete | ⌫ |
| New lane | `L` at the pointer, or New Lane in the toolbar |
| Lane | drag the header to move it with its cards, the corner to resize, double-click the header to rename |
| Find | ⌘F searches fronts, backs and lane titles |
| Undo / redo | ⌘Z / ⇧⌘Z |

## Develop

```bash
swift test --package-path BreezyKit
xcodebuild -project Breezy.xcodeproj -scheme Breezy -derivedDataPath build test
scripts/selftest.sh                    # after a Debug build; for when XCUITest cannot activate the app
scripts/bench.sh LABEL RUNS BOARD...   # after a Release build; then python3 scripts/bench-summary.py
```

## Touch prototype

`web/` is a touch version for trying Breezy's interaction on an iPhone. It keeps nothing: reloading starts from the sample board, `?stress` loads 500 cards.

```bash
python3 -m http.server --directory web 8000
```

On the iPhone, on the same Wi-Fi, open `http://<the Mac's address>:8000` in Safari and Add to Home Screen. ⋯ switches between one-finger and two-finger panning. `node --test web/test/*.test.js` runs its tests; `swift scripts/make-web-icons.swift web` redraws its icons.
