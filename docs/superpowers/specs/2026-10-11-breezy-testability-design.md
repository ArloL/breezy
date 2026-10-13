# Breezy testability — design

Every interaction, dragging included, is tested without a hand on the Mac or the phone, and scenarios across devices are short to write: a Mac drags a card into a lane, and a browser shows it there. The Mac and the web keep their own cores for performance; scenarios drive both in one language, TypeScript, through one set of device commands. Each core sits behind ports whose real adapters only translate; the same scenarios run on fakes of them and on the real devices, which keeps the fakes honest.

## Shape

```
                       scenarios/cases.ts  (each case once)
                      /                                \
       cases.test.ts: World                    browsers.e2e.ts: RealWorld
       fuzz hub, virtual time,                 wall clock, server/dev.sh,
       sync.php, relay sim, links              wrangler dev, WebRTC
          /              \                 /             |            \
      swift              web          chromium, webkit,   android          mac
   breezy-sim:       hub process:     firefox             Chrome on the    Debug Breezy.app,
   CanvasCore        App on fakes     Playwright: the     emulator, at a   -BreezyControl
                                      built app, own      phone's size
                                      mouse, keys, touch
```

`scenarios/device.ts` is what a case sees of any device: `pointer`, `key`, `type`, `scene`, `addCard`, `addLane`, and verbs built on them — `drag`, `click`, `touchDrag`, `tap`, `doubleTap`, `typeInto`. Points a case gives are world points; a device turns them into its screen points with its own camera, so the core's hit testing runs. A case acts on the first device and reads the second's scene.

| Kind | Input | Scene | Edits | Keys |
|---|---|---|---|---|
| `swift` | mouse, through `CanvasCore` | `CanvasCore.scene` | no | through `CanvasCore.key`, ⌘Z as the Edit menu |
| `web` | mouse through `Mouse`, touch through `Gestures`, as `main.ts` hands them | `sceneOf` on the fake view | into a `FakeField` | through `keys.ts` |
| `chromium`, `webkit` | the browser's own mouse; Chromium's own touch, WebKit's as `PointerEvent`s | read back off the DOM | yes | yes |
| `android` | Android's own touch, through the emulator's touchscreen (a phone's through DevTools); keys through DevTools | read back off the DOM | yes | yes |
| `mac` | `NSEvent`s sent to the board window | `CanvasCore.scene`, camera from the scroll view | yes | yes, ⌘ through the menu |

A case says what it needs of the first device (touch, editing, keys, going offline); the runners skip the pairs that lack it. Only browsers go `offline` and `relaunch`: the scenarios serve the web app with a version, so its service worker keeps it as on breezy.k5d.de, and a launch without network runs from that. A phone acts only with a finger, on a screen too narrow for a lane and a card beside it; `size` tells a case so.

## Scenes

A scene is what a device draws: each card and lane with its world frame, whether it is selected, held or lifted, its colour and text; the turned card, the selection box, and the camera. `web/scene.ts` and BreezyKit's `Scene` have one shape; `scenarios/conformance.test.ts` plays the same gestures on a Swift and a web device and requires equal scenes, which checks both cores and the Swift mirror of the shape.

## Ports

| Core | Where | Ports |
|---|---|---|
| Mac | `BreezyKit/CanvasCore.swift`: hits, the drag threshold, selection, the box, what a drag moves and where it lands, the board's keys | closures for heights, drawn rects, what others hold, zoom, camera, turning, holding; `CanvasView` turns events into calls and draws what the core holds |
| web | `App`, `Input`, `Mouse`, `Gestures`, `keys.ts` | `web/ports.ts`: the view with its editable fields, the UI, presence and the open board's space; `main.ts` gives the DOM ones (`web/field.ts` for fields), `web/test/fakes.ts` the fakes |

Fakes measure a card as 24 + 24 pt per line, as Chromium, WebKit and the Mac draw text too short to wrap.

The hub's devices answer the fuzzer's commands plus `pointer`, `key` and `scene`; its web devices run the app's core on the fakes and its Swift devices `CanvasCore`, so the fuzzer presses, drags and releases through the same code as a person. The Mac's control port (`Breezy/Support/Control.swift`) takes `join`, `createBoard`, `open`, `newLane`, `pointer`, `key`, `type`, `scene` and `status`; it keeps a store of its own and counts its windows as shown.

## Not covered headless

| What | Where it stays |
|---|---|
| Frames in flight, pixel rendering | `scripts/selftest.sh` pixel diffs, screen recordings |
| iOS-only behaviour: the magnifier, the keyboard, `visualViewport`, haptics | the simulator with `scripts/sim-touch.py`, the phone with `scripts/wda.py` |

## Still to do

| What | Why it matters |
|---|---|
| The Mac's editing in BreezyKit | cases that type run on the hub's web devices and on real devices, not on the hub's Swift ones |
| Going offline and launching again on the hub's devices and the Mac's control port | the offline case runs only where a browser acts |
| Zoom, pan and edge scroll in `CanvasCore` | the hub's Swift devices have a fixed camera, so cases keep to what one screen shows |
| Replacing the rules tests mirrored by hand between `rules.test.ts` and `StackingTests`/`EditsTests` with conformance cases | one change, one test |
| Contract suites per port, beside the cases: scenes applied to the DOM view and read back; native events against what the fakes inject | a fake that drifts shows as a contract failure, not as a case that passes on fakes alone |
| Touch through the browsers' own touch input rather than `PointerEvent`s | iOS's compatibility mouse events come only from real touches |
