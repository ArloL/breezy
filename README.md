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

`web/` is a touch version for trying Breezy's interaction on a phone. It keeps nothing: reloading starts from the sample board, `?stress` loads 500 cards. Every push to `main` publishes it at https://arlol.github.io/breezy/: on iPhone, Safari's Share → Add to Home Screen; on Android, Chrome's ⋮ → Install app. Once installed it launches from a local copy of one version, without the network; `web/sw.js` downloads a new version in the background and switches to it on the next launch, or on coming back after five minutes away. Version in the ⋯ menu says when one is ready.

```bash
npx --yes live-server@1.2.2 web --port=58565 --no-browser
```

It reloads the page on every save. On the iPhone, on the same Wi-Fi, open `http://<the Mac's address>:58565` in Safari and Add to Home Screen. `node --test web/test/*.test.js` runs its tests; `swift scripts/make-web-icons.swift web` redraws its icons and `scripts/make-web-launch.py web` its launch images, whose `<link>` tags it prints for `index.html`.

In the iOS simulator, which Xcode 27 shows in DeviceHub rather than a Simulator app, open it with `xcrun simctl openurl booted http://localhost:58565/`. `scripts/sim-touch.py` replays touches as one timed stream; gestures that start with a double tap need it, because the window is 300 ms and `idb ui tap` or AXe take at least 0.7 s per touch. A screenshot rarely lands mid-gesture, so record with `xcrun simctl io booted recordVideo` to catch something brief like iOS's magnifier.

To compare with Apple's apps on a real iPhone, run Appium's WebDriverAgent on it from Xcode (scheme WebDriverAgentRunner, Product → Test): `scripts/wda.py` then drives it, with timed touches, pinches and the accessibility tree for positions, and refuses to touch while a call is on screen. `scripts/phone-record.swift` records the phone's screen over USB. Freeform measured this way set the coast, edge scrolling and button presses.
