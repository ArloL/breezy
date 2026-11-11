# Native Panning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Breezy's board can pan natively, in a real scroll container with Breezy's zoom on top, as an opt-in mode beside today's camera mode, and the Mac trackpad's native mode is scored against AppKit.

**Architecture:**
- **Surfaces.** The view stops applying the camera itself and hands it to a surface: `CameraSurface`, today's transformed world and canvas grid, or `NativeSurface`, a scroll container whose position is the camera.
- **Pure decisions.** Every decision native mode makes is a pure function in `web/native/`, tested in Node. The DOM wiring follows the spike (`spike/native-pan`, commits 399c23b..5121480), tested in desktop browser cases.
- **Opt-in.** The mode is chosen when the board opens (`?pan=`, remembered, plus a temporary menu item). The default stays the camera everywhere in this plan.

**Tech Stack:** TypeScript (Node 26 type stripping, `node --test`), the DOM, Playwright-driven browser cases in `scenarios/`, Python for screen tracking (`ffmpeg`), the replay helper and reference app from the native reference work.

**Spec:** `docs/superpowers/specs/2026-11-10-breezy-native-panning-design.md` (read "Spike findings" first; the spike's code is on branch `spike/native-pan`, `web/native-pan.ts`).

## Before you start (state on 2026-11-10, when work paused)

**Branches and PRs**
- PR #271 (the bounded board and trackpad rubber band) has **merged**.
- `try/bounded-canvas` holds, pushed, on top of it, rebased onto main on 2026-11-11:
  1. **the measuring kit:** the reference app (`Reference/`), the replay helper and scripts (`scripts/replay*.{ts,swift}`, `scripts/reference-*.ts`, `scripts/dev-goto.ts`, `scripts/appkit-score.ts`), the fixture and test (`web/test/appkit-edge*`), and the owner's strokes (`scripts/reference-strokes/`);
  2. **the tuned band and spring** (cc352c2), which depends on 1;
  3. **the specs and this plan.**
- AGENTS.md wants small PRs off main, not stacked. So:
  1. open the measuring kit's PR first (1 and the specs);
  2. once it merges, open the tuned band and spring's PR;
  3. build this plan on a new branch off main after both.
- The commits are ordered so 1 and 2 split cleanly at cc352c2, but check with `git log --oneline main..`.
- **The spike** is on `spike/native-pan`: the native mode in `web/native-pan.ts`, the measuring tools in `spike-tools/` (the page, capture, scoring, tracker and window bounds). It's throwaway: read it, don't merge it. Its base is the branch before that rebase, so the hashes above hold; don't rebase it. Keep it until native mode has merged: Tasks 5 and 6 build on its `web/native-pan.ts` and CSS, Task 7 on its tracker and scoring; then delete it, locally and on origin.

**Setup on the Mac**
- **Permissions.** Accessibility and Screen Recording are granted to Visual Studio Code. Run the replay helper and `screencapture` from a session inside it, or grant them to the terminal you use.
- **Replay helper:** `swift scripts/replay-helper.swift`. It answers only requests with the header `X-Breezy-Replay: 1`.
- **Dev server:** `npm run dev`. Keep exactly one Breezy tab open in Firefox: every open page answers `/goto`.
- **Reference app:** build it with `xcodegen generate && xcodebuild build -project Breezy.xcodeproj -scheme BreezyReference -destination 'platform=macOS' -derivedDataPath build/reference-dd`.
- **The owner's strokes:** copy them into `build/reference/` (`cp scripts/reference-strokes/*.json build/reference/`) before running `scripts/reference-batch.ts`, or Task 7's capture. `build/` isn't kept.

**Setup on the iPhone**
- **Browser.** The owner's iPhone browser is **Firefox for iOS**: WebKit, user agent "FxiOS".
- **Opening a board.** Open `http://<the Mac's LAN address>:58565/?demo&pan=native` (`ipconfig getifaddr en0`; it was 192.168.178.45).
- **Its recording.** Each page posts its flight recording to `build/flight/browser <id>.json` every 5 s.
- **Screen recording,** with the phone on USB: `swiftc -O -o /tmp/phone-record scripts/phone-record.swift`, then `/tmp/phone-record OUT.mov SECONDS`. Make a contact sheet with `ffmpeg -i OUT.mov -vf "fps=2,scale=120:-1,tile=15x8" -frames:v 1 sheet.png`.
- **What's already known.** Memory notes `ios-native-scroll-quirks` and `appkit-edge-findings` hold what took rounds to find; read them first.

**Decisions still open**
- Firefox on the Mac with a trackpad: native by default after Task 7? The owner's call.
- The iPhone: decided after the UIKit twin's plan.
- Android keeps the camera.
- The experimental coast (the spec's "My calls") isn't in the code. It's a third candidate on the Mac, scored in Task 7 beside native and the camera.

## Global Constraints

- **Defaults.** Every platform's default stays the camera mode. Native mode is opt-in, by `?pan=native` or the menu. Changing a default is the owner's call, after a score and the owner's feel.
- **Localhost only.** Test against localhost (`npm run dev`), never breezy.k5d.de. Small PRs off main, merged green; this work goes after the measuring kit's PR.
- **Constants.** The board reaches `MARGIN` = 1,194 pt past its outermost card or lane. Zoom stays within 0.25–2 (`clampZoom`). The one-finger zoom divides by `ZOOM_DRAG` = 150. Native content is the board at the zoom, and at least one point larger than the window on each axis.
- **Comments and options.** Comments only where something isn't obvious. Long CLI options where macOS supports them.
- **No lost gestures.** Native mode must keep every gesture that works today (the spec's anti-goals): hold to lift, quick drag of a selected card, the one-finger zoom, double tap, the marquee, find, edge auto-scroll, and editing with the keyboard.

## Review Focus

1. **A window resize or rotation in native mode.** The content must stay at least a point larger than the window and the camera unchanged. Task 4 tests `layoutOf` with a client size bigger than the board at the zoom.
2. **A flick still coasting when a pinch starts.** The pinch must not jump. Task 3's `pinchKind` treats a touch whose sequence has scrolled as `"taken"`; its test covers a coast, scroll events with no finger down before the touch began, as not taken.
3. **The app springing the camera (find) while the user scrolls.** The user's scroll wins and the spring stops. Task 4's `isEcho` returns false for a position more than 1 pt from the one written.
4. **Native mode on a page opened in a Home Screen app with no query.** It takes the remembered mode. Task 1's `panMode` test covers stored `"native"` with an empty search.
5. **The keyboard's caret control (spacebar held) while editing.** The board doesn't scroll. Task 6 tests the class the editing lock sets, and its browser case.

---

### Task 1: The pan mode, chosen and remembered

**Files:**
- Create: `web/pan-mode.ts`
- Modify: `web/index.html` (a menu item in the board's ⋯ menu), `web/ui.ts` (its label and action), `web/main.ts` (choose the mode at start)
- Test: `web/test/pan-mode.test.ts`

**Interfaces:**
- Produces:
  - `export type PanMode = "camera" | "native"`.
  - `export function panMode(search: string, stored: string | null): PanMode`: `?pan=native|camera` wins, then `stored`, else `"camera"`.
  - `export const PAN_KEY = "breezy.pan"`, the `localStorage` key, written whenever `?pan=` is given or the menu item is used.
- The menu item reads "Panning: Native" or "Panning: Camera". Choosing it writes the other mode and reloads the page.

- [ ] **Step 1: Write the failing tests:**
  - `panMode("?pan=native", null) === "native"`;
  - `panMode("?pan=camera", "native") === "camera"`;
  - `panMode("", "native") === "native"` (Review Focus 4);
  - `panMode("?demo", null) === "camera"`;
  - `panMode("?pan=fast", "native") === "native"`, an unknown value ignored.
- [ ] **Step 2: Run them.** `node --test web/test/pan-mode.test.ts`. Expected: FAIL, the module is missing.
- [ ] **Step 3: Implement `panMode`,** and in `main.ts` store `?pan=` and read the mode before the view is made. Add the menu item in `index.html` and `ui.ts` beside the existing ⋯ items, following their `data-act` pattern (`data-act="pan-mode"`).
- [ ] **Step 4: Run them to see them pass,** then `npm run check`. Expected: PASS, no type errors.
- [ ] **Step 5: Commit.**

### Task 2: Surfaces — the camera's place on screen

**Files:**
- Create: `web/surface.ts` (the `Surface` interface and `CameraSurface`, today's behaviour moved out of `view.ts`)
- Modify: `web/view.ts`: `apply`, `drawGrid`, `stage` and `rest` go through `this.surface`.
- Test: the existing `web/test/*.test.ts` and `scenarios/cases.test.ts` stay green. A refactor: no behaviour changes.

**Interfaces:**
- Produces `export interface Surface`:
  - `apply(cam: Cam): void`: show the camera;
  - `stage(): Area`: the board's area on screen;
  - `drawGrid(cam: Cam, board: Rect): void`;
  - `rested(): void`: the board has taken in what shows;
  - `dispose(): void`.
- Produces `export class CameraSurface implements Surface`, made with `(world: HTMLElement, grid: Grid)`. It does what `view.ts:204-215` does today.
- `View` gains `surface: Surface`, set in its constructor to a `CameraSurface`, and `useSurface(s: Surface)`, which swaps it and re-applies the camera.

- [ ] **Step 1: Move the code.** Move `apply`'s transform and grid drawing and `stage()` into `CameraSurface`; `View` calls `this.surface`.
- [ ] **Step 2: Run the suite.** `npm test && npm run check`. Expected: all pass, as before (821 at the tuned band, before the rebase onto main).
- [ ] **Step 3: Commit.**

### Task 3: Native touch decisions, pure

**Files:**
- Create: `web/native/touch.ts`
- Test: `web/test/native-touch.test.ts`

**Interfaces:**
- Produces:
  - `export function stopsBrowserPan(s: { lifted: boolean; dragAction: string | null; doubleTapSecond: boolean; editing: boolean; inEditor: boolean }): boolean`. It is true for a lifted card, for any drag action but `"pan"`, for a double tap's second touch, and for a touch inside the editor.
  - `export function pinchKind(s: { cancelable: boolean; pannedThisTouch: boolean }): "own" | "taken"`. `"taken"` when the touch can't be cancelled, or the browser has scrolled since this touch sequence's first finger came down.
  - `export function followVelocity(prev: { x: number; y: number }, dx: number, dy: number, dt: number): { x: number; y: number }`. It smooths 0.7 new and 0.3 old, from the spike, with `dt` at least 1.
  - `export function coastFromLift(v: { x: number; y: number }, sinceLastMove: number): { x: number; y: number }`. It returns `v` within 50 ms of the last move, else 0.

- [ ] **Step 1: Write the failing tests.**
  - **`stopsBrowserPan`**, one test per row:

    | Case | Result |
    |---|---|
    | lifted | true |
    | drag `"move"` | true |
    | drag `"pan"` | false |
    | double tap's second touch | true |
    | in the editor while editing | true |
    | outside the editor while editing | false |
    | nothing | false |

  - **`pinchKind`:**
    - `{cancelable: true, pannedThisTouch: false}` gives `"own"`;
    - `{cancelable: false, pannedThisTouch: false}` gives `"taken"`;
    - `{cancelable: true, pannedThisTouch: true}` gives `"taken"`;
    - a coast that ended before this touch began (`pannedThisTouch: false`) gives `"own"` (Review Focus 2).
  - **`followVelocity`:** `({x: 0, y: 0}, 10, 0, 10)` gives `{x: 0.7, y: 0}`.
  - **`coastFromLift`:** at 49 ms it returns `v`; at 51 ms, `{x: 0, y: 0}`.
- [ ] **Step 2: Run them.** `node --test web/test/native-touch.test.ts`. Expected: FAIL, the module is missing.
- [ ] **Step 3: Implement them.**
- [ ] **Step 4: Run them to see them pass.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 4: Native geometry, pure

**Files:**
- Create: `web/native/geometry.ts`
- Test: `web/test/native-geometry.test.ts`

**Interfaces:**
- Produces:
  - `export interface Layout { width: number; height: number; world: string; gridSize: number; gridOffset: [number, number] }`.
  - `export function layoutOf(board: Rect, zoom: number, client: { w: number; h: number }): Layout`:
    - `width = max(board.w·zoom, client.w + 1)`, and `height` likewise;
    - `world = translate(−board.x·zoom px, −board.y·zoom px) scale(zoom)`;
    - `gridSize = 25·zoom`;
    - `gridOffset = ((−board.x·zoom) mod gridSize − gridSize/2, …)`.
  - `export const scrollOf = (cam: Cam, board: Rect) => ({ x: −cam.x − board.x·cam.zoom, y: −cam.y − board.y·cam.zoom })`.
  - `export const camOf = (scroll: Point, board: Rect, zoom: number): Cam`, the inverse.
  - `export const isEcho = (at: Point, written: Point) => |at.x − written.x| < 1 && |at.y − written.y| < 1`.
  - `export function pinchTransform(anchor: Point, board: Rect, z0: number, z: number, mid: Point, scroll: Point): string`. It returns `translate(mid.x − qx·s + scroll.x px, mid.y − qy·s + scroll.y px) scale(s)`, where `s = z / z0` and `q = (anchor − board)·z0`. In the overlay, `scroll` is `{0, 0}`.
  - `export const pinchCamera = (anchor: Point, z: number, mid: Point): Cam => ({ x: mid.x − anchor.x·z, y: mid.y − anchor.y·z, zoom: z })`.

- [ ] **Step 1: Write the failing tests:**
  - `layoutOf` of the empty board `{−1194, −1194, 2388, 2388}` at 0.25 with client 1158 × 864 has width 1159 and height 865. Its 1 × 1 grid case: `gridSize` 6.25.
  - `layoutOf` with a client of 3000 × 3000 at zoom 1 is 3001 × 3001 (Review Focus 1).
  - `camOf(scrollOf(cam, b), b, cam.zoom)` round-trips `{x: 600, y: −200, zoom: 0.75}` to a millionth.
  - `isEcho({x: 10.5, y: 3}, {x: 10, y: 3})` is true; at 11.2 it's false (Review Focus 3).
  - With `pinchTransform` and `pinchCamera` from the same inputs, the anchor maps to `mid` on screen. Check it by applying the transform to `q` and subtracting `scroll`: equal to `mid` within 0.01, at z0 0.75 and z 1.5.
- [ ] **Step 2: Run them.** Expected: FAIL, the module is missing.
- [ ] **Step 3: Implement them.**
- [ ] **Step 4: Run them to see them pass.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 5: NativeSurface — the board scrolls natively on the Mac

**Files:**
- Create: `web/native/surface.ts`
- Modify:
  - `web/main.ts`: make a `NativeSurface` when `panMode` is `"native"`. The wheel listener lets plain wheels through, and ⌘ or ⌃ zooms as today.
  - `web/input.ts`: a `"pan"` drag moves nothing and coasts nothing in native mode, through a `native: boolean` the app sets.
  - `web/style.css`: the native rules from the spike, without the "SPIKE" comment.
- Test:
  - `scenarios/native.e2e.ts`: desktop Firefox and Chromium, `?pan=native&demo`;
  - `scripts/test/hangs.test.ts` already requires its `exitsAfter`.

**Interfaces:**
- Consumes: `Surface` (Task 2); `layoutOf`, `scrollOf`, `camOf`, `isEcho` (Task 4).
- Produces `export class NativeSurface implements Surface`, made with `(board: HTMLElement, view: View, flight: Flight)`.
  - It wraps `.world` in `.native-content`.
  - `apply` lays out and writes the scroll position, remembering it for `isEcho`.
  - A `scroll` event that isn't an echo sets the camera from `camOf`.
  - A `scrollend` after a user scroll (not an echo, and not during a pinch) rests and lays out again (`settle`).
  - `stage()` returns the board's client area.
  - It notes `native scroll start`, `native scroll end` and `native scroll refused` in the flight recording, as the spike did.

- [ ] **Step 1: Write the failing browser cases** in `scenarios/native.e2e.ts`:
  - `a wheel pans the native board`: `page.mouse.wheel(0, 300)`, then the scene's camera y fell by 300 ± 2;
  - `⌘-scroll zooms around the pointer, and the board stays put under it`: the point under the pointer stays within 2 pt;
  - `find glides to a match`: the camera stands at the match after 800 ms, and moved in more than one step on the way;
  - `zoomed out to 25 %, the board still covers the window`: `.native-content`'s size is at least the window's plus one.
- [ ] **Step 2: Run them.** `node --test scenarios/native.e2e.ts`. Expected: FAIL, native mode is absent.
- [ ] **Step 3: Implement `NativeSurface`** and the `main.ts` and `input.ts` changes, after `spike/native-pan`'s `web/native-pan.ts`. Use the pure functions; no monkeypatching of `View`.
- [ ] **Step 4: Run the cases, then the suite.** `node --test scenarios/native.e2e.ts && npm test && npm run check`. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 6: Native touch on iOS

**Files:**
- Create: `web/native/touch-wiring.ts`, the DOM listeners using Task 3's functions.
- Modify:
  - `web/main.ts`: in native mode, the board's `touchstart` doesn't call `preventDefault`, and `gesturestart` doesn't zoom on a touch device (`matchMedia("(pointer: coarse)")`). Safari's trackpad pinch on a Mac keeps zooming.
  - `web/input.ts`: in native mode, `zoomDrag` zooms around `pinchBase.c` by `2^(dy / ZOOM_DRAG)`, and the pointer pinch handlers do nothing.
  - `web/native/surface.ts`: the pinch path and the overlay.
- Test:
  - `web/test/native-touch.test.ts` (Task 3's, extended if a decision moves there);
  - iOS simulator cases in `scenarios/native-ios.e2e.ts`, through `scenarios/ios.ts` and `scripts/sim-hid.py`.

**Interfaces:**
- Consumes: `stopsBrowserPan`, `pinchKind`, `followVelocity`, `coastFromLift` (Task 3); `pinchTransform`, `pinchCamera` (Task 4).
- Produces, all as in the spike, its findings in the spec:
  - **Pinch:** `touchmove` and `touchend`/`touchcancel` listeners on the document, non-passive. An `"own"` pinch is scaled on the compositor under `.pinching` (grid canvas shown, `overflow: hidden`). A `"taken"` pinch moves the content to `.native-overlay` until it ends.
  - **Ending:** a pinch still for 400 ms ends, and so does one left with fewer than 2 touches. The finger left after a pinch pans the board and coasts.
  - **Editing:** `.editing` (on `focusin`/`focusout` of the editor) stops scrolling, but `.pan-anyway` lets a touch begun outside the editor pan.

- [ ] **Step 1: Write the failing simulator cases:**
  - `a pinch zooms the native board without moving the point between the fingers`, within 4 pt;
  - `a second finger on a native pan zooms`: the zoom changes, and the board point between the fingers stays within 8 pt;
  - `a held card drags, and the board does not pan`: the card moved and the camera didn't;
  - `a double tap and a drag zooms`;
  - `the spacebar's caret, run to the line's start, leaves the board where it was` (Review Focus 5). Drive the spacebar through the simulator's keyboard. If `scripts/sim-hid.py` can't hold the spacebar, replace this case with a check that `#board` has `.editing` and computed `overflow: hidden` while an editor has focus.
- [ ] **Step 2: Run them.** `node --test scenarios/native-ios.e2e.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the wiring.**
- [ ] **Step 4: Run the cases, then the suite.** Expected: PASS.
- [ ] **Step 5: Ask the owner to feel it on their iPhone.** In the Home Screen app, switch "Panning: Native" in the menu, then try a pan, a flick, a pull past an edge, a pinch fresh and mid-pan, a hold-drag, a double tap and drag, and editing with the spacebar. Expected: nothing broken. Anything the owner finds is debugged from the phone's flight recording first (`.claude/skills/debugging-breezy`), with a test at the lowest level that shows it.
- [ ] **Step 6: Commit.**

### Task 7: The Mac scored — native mode against AppKit

**Files:**
- Create:
  - `scripts/screen-track.py`, the red-bar tracker from the spike: a strip video, giving `[t ms, x pt | null]` per frame;
  - `scripts/native-capture.ts`, which replays each fixture case into native mode in Firefox while recording a screen strip;
  - `scripts/test/screen-track.test.ts`.
- Modify:
  - `scripts/appkit-score.ts`: `--native <dir>` scores captured native curves through `compare(c, curve)`;
  - `web/native/surface.ts`: under `?mark`, a 4 pt red bar at the board's left edge, for the tracker.

**Interfaces:**
- Consumes: `compare(c: Case, curve?: Curve)` (`web/test/helpers/appkit.ts`); `post(s, bundle)` (`scripts/replay.ts`).
- Produces: `node scripts/native-capture.ts`, which writes `build/reference/native/<case>.json` holding `{ page: frames, bar }`, and `node scripts/appkit-score.ts --native build/reference/native`, which prints the same table as for WheelPan.

- [ ] **Step 1: Write the failing test.** `screen-track.py` on a generated strip video, made in the test with `ffmpeg` from frames with the bar at 0, 10 and 20 px (2× scale), gives `[0, 5, 10]` pt.
- [ ] **Step 2: Run it.** `node --test scripts/test/screen-track.test.ts`. Expected: FAIL, no script.
- [ ] **Step 3: Implement the tracker and the capture.** The capture holds the bar's last seen position between frames, and joins the page's scroll position inside the board with the bar past its edge, as the spike's `native-score.ts` did.
- [ ] **Step 4: Check the tracker against AppKit again.** Replay `release-1` into the reference app while recording, and compare the bar with the app's own curve. Expected: on average within 0.5 pt, at most 6.
- [ ] **Step 5: Capture all 35 cases, and score them.**
  - Score three candidates: native; the camera as committed; and the camera with the experimental coast. That coast takes 0.55 of momentum deltas larger than 3 pt and none of those of 3 pt or less, and carries 0.25 of the momentum's speed into the bounce, behind a flag in `wheel.ts`, not shipped.
  - Expected: a table like the spike's, one row per candidate.
- [ ] **Step 6: Record the result in the spec** (a "Mac verdict" section with the table), and ask the owner whether Firefox on the Mac with a trackpad defaults to native. Changing the default in `panMode`'s caller is the owner's call, and a commit of its own.
- [ ] **Step 7: Commit.**

---

The UIKit twin and the iPhone's score are the next plan. They need the reference app's iOS twin, driven by `scripts/sim-hid.py`, before the iPhone's default can be decided.
