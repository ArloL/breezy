# Breezy testability — design

Every interaction, dragging included, is tested without a hand on the Mac or the phone, and scenarios across devices are short to write: a Swift device drags a card into a lane, and a web device shows it there. The Mac and the web keep their own cores for performance; scenarios drive both in one language, TypeScript, through one device protocol. Each core sits behind ports whose real adapters only translate, and whose fakes are held to the real thing by contract suites.

## Done

The scenarios run on every PR, on virtual time, with Swift and web devices against the real `sync.php`. The same scenario files run nightly against the Debug Mac app and headless Chromium and WebKit. The sub-projects below get there in steps.

## Shape

```
                 scenarios/*.ts  (node --test)
                        |
                 device protocol
        /          |            |             \
     swift        web       chromium/webkit     mac
  breezy-sim   hub process  headless browser  Debug Breezy.app
  fake ports   fake ports    real DOM ports    real AppKit ports
        \__________/            \_____________/
     fuzz hub: virtual time,   wall clock: sync.php,
     sync.php, relay sim,      wrangler dev, WebRTC
     simulated links           (as direct-e2e.mjs)
```

A scenario names its devices and a kind for each. When every device has virtual time, it runs in the fuzz hub, deterministic and fast; when any is real, all run on the wall clock against the real stack.

## Device protocol

The one contract both cores implement. Its types are written once in TypeScript; a JSON Schema generated from them checks the Swift `Codable` mirror, so drift on either side fails a test.

| Command | |
|---|---|
| `pointer` | down, move, up or cancel: id, kind (mouse, touch, pen), screen point, modifiers, time |
| `key`, `text`, `scroll`, `magnify` | other input |
| `scene` | what the device shows: cards (id, world frame, colour, face, z, lifted or floating), lanes, selection, editing, camera, presence |
| `board` | the store's board, canonical |
| `advance`, `idle` | virtual time, for kinds that have it |

Locators turn `card('A')` or `lane('L').column(1)` into a screen point from the device's own scene and camera, so the core's hit testing runs. Verbs such as `drag`, `tap` and `doubleTap` map to each kind's native input: mouse on the Mac, touch or mouse on the web.

## Device kinds

| Kind | Input | Screen | Clock | Runs in |
|---|---|---|---|---|
| `swift` | protocol → core | fake | virtual | `breezy-sim` |
| `web` | protocol → core | fake | virtual | the hub's process |
| `chromium`, `webkit` | CDP touch and mouse → DOM listeners | DOM, read back as a scene | wall | headless browser |
| `mac` | synthesised `NSEvent`s → the window | `CALayer`s, read back as a scene | wall | Debug `Breezy.app` with a control socket |

## Ports

The core decides; it never animates. It emits a scene, the target state of the screen, and adapters animate towards it.

| Port | Mac adapter | Web adapter | Fake |
|---|---|---|---|
| Input | `CanvasView` forwards `NSEvent`s as protocol events | `main.ts` listeners forward pointer, touch, key, wheel and gesture events | the test sends protocol events |
| Screen | scene diffs → `CardLayer`, `LaneView`, presence | scene diffs → `View` | keeps the scene |
| Editor | `NSTextView` | `contentEditable` | a text buffer with a caret |
| Text metrics | `NSLayoutManager` | the `.measure` node | fixed glyph widths and line height |
| Clock, schedule | media time, display link, `asyncAfter` | `performance.now`, rAF, `setTimeout` | the hub's clock |
| Network, storage | the existing seams | the existing seams | the hub's simulations |

Adapters hold no decisions: hit testing, the drag threshold, gesture state, selection, editing state, edge scroll and the drop all live in the core.

## Contracts

One suite per port, run against the fake and the real adapter:

- **Screen** — apply a set of scenes, read back the model-layer state and compare it with the scene. On the Mac in XCTest on an offscreen `NSWindow`, which needs no activation; on the web in headless Chromium and WebKit.
- **Input** — native events (CDP touch and mouse, synthesised `NSEvent`s) yield the protocol events the fake injects, including iOS's compat `mousedown` after a tap.
- **Editor** — typing, the caret, Esc and ⌘↩ map to the same protocol events.
- **Text metrics** — real and fake differ by design, so the suite pins properties: a blank card is one line, more text is never shorter, text wraps at the card's width.

## Conformance

Every single-device scenario runs on both `swift` and `web`, and both must end with the same scene and board. This replaces the rules tests mirrored by hand between `rules.test.js` and `StackingTests`/`EditsTests`.

## Fitness

- BreezyKit imports no AppKit.
- The TypeScript core compiles with a `lib` without `"dom"`, so a DOM call in it fails to compile.
- A listener inventory: each platform event is registered once.

## Not covered headless

| What | Where it stays |
|---|---|
| Frames in flight, pixel rendering | `scripts/selftest.sh` pixel diffs, screen recordings |
| iOS-only behaviour: the magnifier, the keyboard, `visualViewport` | the simulator with `scripts/sim-touch.py`, the phone with `scripts/wda.py` |

## Sub-projects

Each gets its own spec, plan and implementation, in this order.

| # | Sub-project | Done when |
|---|---|---|
| 1 | TypeScript | web, `sync/`, the hub, fuzz and scripts are TypeScript; esbuild bundles the PWA; `tsc --noEmit` strict and every existing test pass; no change in behaviour |
| 2 | Protocol and pointer cores | the protocol and its Swift mirror; drag, select, box select, lane move and resize and drop in both cores behind the input, screen and clock ports; `swift` and `web` kinds; `SimDevice`'s own drag gone; "a Swift drag into a lane shows on the web" passes on virtual time |
| 3 | The rest of the interactions | editing (editor and text metrics ports), keys, turning, zoom and pan, find, edge scroll, undo; conformance replaces the mirrored rules tests |
| 4 | Real adapters and contracts | `chromium`, `webkit` and `mac` kinds; the contract suites; one scenario file passing on fakes and on real devices |
| 5 | Fuzz and CI | fuzz operations become protocol verbs, so the fuzzer drives the interaction code; scenarios on every PR, real kinds and contracts nightly |
