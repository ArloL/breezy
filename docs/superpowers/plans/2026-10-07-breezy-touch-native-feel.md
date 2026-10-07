# Breezy touch native feel — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the web touch prototype move, press and respond like an iOS 27 app without changing what any gesture does.

**Architecture:** Pure physics functions (`physics.js`) drive a camera animator (`camera.js`) for coasts, rubber-banding and springs; Motion 14 (vendored) provides springs for elements; `press.js` and `menu.js` replace the bars' click handling with UIControl-style tracking and pull-down menus; `haptics.js` wraps Safari's switch-toggle haptic.

**Tech Stack:** Plain ES modules, no build step; Motion 14 standalone bundle; `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-07-breezy-touch-native-feel-design.md`

## Global Constraints
- Gestures keep the meanings in `docs/superpowers/specs/2026-10-07-breezy-touch-design.md`; only the feel changes.
- Deceleration 0.998 per ms; rubber band `(1 − 1 / (x·0.55 / d + 1))·d`; zoom limits 25 % and 200 %.
- Edge auto-scroll: 24 pt zone at the edge of the visible area, 40 pt/s rising to at most 600 pt/s after about a second.
- Reduce Motion: springs become crossfades or jumps.
- `node --test web/test/*.test.js` stays green.

## Review Focus
- A touch during any camera spring or coast stops it where it is, with no jump, and is not a tap (`input.js` `touchStart`).
- Pinching past a limit and releasing never leaves the zoom outside 25–200 % (camera test: `settle()` after a rubber-banded zoom ends at the limit).
- A menu open when the board is touched closes and the touch does nothing else (menu test: board pointerdown while open is swallowed).
- Lifting a finger outside a button after sliding off never runs its action (press test).
- Search, editing and the keyboard bar still work with the bars animated (phone check, Task 7).

---

### Task 1: Motion and physics

**Files:**
- Create: `web/vendor/motion.js` (copy of `motion@14.0.0/dist/motion.js`), `web/vendor/LICENSE-motion`, `web/motion.js`, `web/physics.js`
- Test: `web/test/physics.test.js`

**Interfaces:**
- Produces: `decay(v, ms)` → velocity after `ms`; `coastOffset(v, ms)` → distance travelled; `projection(v)` → total coast distance; `rubber(x, d)`; `edgeSpeed(depth, heldMs)` in pt/ms (0 outside the zone); constants `DECEL = 0.998`, `EDGE_ZONE = 24`.

- [ ] **Step 1: Write the failing tests**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { decay, coastOffset, projection, rubber, edgeSpeed, EDGE_ZONE } from "../physics.js";

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≉ ${b}`);

test("velocity decays by 0.998 per millisecond, as UIScrollView's normal rate", () => {
  near(decay(1, 1), 0.998);
  near(decay(2, 1000), 2 * 0.998 ** 1000);
});

test("a coast travels the integral of its velocity and approaches its projection", () => {
  near(coastOffset(1, 0), 0);
  near(coastOffset(1, 100000), projection(1), 1e-3);
  near(projection(1), -1 / Math.log(0.998), 1e-9);
});

test("the rubber band follows UIKit's formula: small stretches nearly 1:1, large ones never past d", () => {
  near(rubber(0, 100), 0);
  near(rubber(10, 100), (1 - 1 / ((10 * 0.55) / 100 + 1)) * 100);
  assert.ok(rubber(1e6, 100) < 100);
  near(rubber(-10, 100), -rubber(10, 100));
});

test("edge scrolling starts only inside the zone, slowly, and speeds up while the finger stays", () => {
  assert.equal(edgeSpeed(EDGE_ZONE + 1, 0), 0);
  near(edgeSpeed(EDGE_ZONE, 0), 0.04);
  assert.ok(edgeSpeed(5, 500) > edgeSpeed(5, 0));
  near(edgeSpeed(1, 5000), 0.6);
});
```

- [ ] **Step 2:** Run `node --test web/test/physics.test.js`; expect failure (no module).
- [ ] **Step 3: Implement `web/physics.js`**

```js
/** UIScrollView's normal deceleration: velocity keeps this fraction each millisecond. */
export const DECEL = 0.998;
const K = Math.log(DECEL);
export const EDGE_ZONE = 24;
const EDGE_MIN = 0.04; // pt/ms
const EDGE_MAX = 0.6;
const EDGE_RAMP = 0.00064; // pt/ms per ms held: 40 to 360 pt/s in half a second, as Freeform

export const decay = (v, ms) => v * DECEL ** ms;
export const coastOffset = (v, ms) => (v * (DECEL ** ms - 1)) / K;
export const projection = (v) => -v / K;
/** UIKit's rubber band: how far content moves when pulled `x` past its limit, for a dimension `d`. */
export const rubber = (x, d, c = 0.55) => Math.sign(x) * (1 - 1 / ((Math.abs(x) * c) / d + 1)) * d;
/** Auto-scroll speed in pt/ms for a finger `depth` points from the edge, held there `heldMs`. */
export const edgeSpeed = (depth, heldMs) =>
  depth > EDGE_ZONE ? 0 : Math.min(EDGE_MAX, EDGE_MIN + EDGE_RAMP * heldMs);
```

- [ ] **Step 4:** Vendor Motion: copy `motion@14.0.0/dist/motion.js` to `web/vendor/motion.js`, its `LICENSE.md` to `web/vendor/LICENSE-motion`. Create `web/motion.js`:

```js
import "./vendor/motion.js";
export const { animate, spring, motionValue, frame, cancelFrame } = globalThis.Motion;
```

- [ ] **Step 5:** Run all tests; expect PASS. Commit "Add UIKit's scroll physics and vendor Motion".

### Task 2: Camera animator

**Files:**
- Create: `web/camera.js`; Test: `web/test/camera.test.js`
- Modify: `web/view.js` (`setCamera`, `stopGlide`, `zoomAround`, `reveal`, `centreOn` use the animator; drop `glide` classes), `web/input.js` (coast, pinch, zoom drag), `web/style.css` (remove `.glide` rules)

**Interfaces:**
- Consumes: `decay`, `coastOffset`, `rubber`, `DECEL` from Task 1.
- Produces: `class Camera { constructor(apply, now = performance.now, raf = requestAnimationFrame, caf = cancelAnimationFrame); get cam(); set(cam); stop(); coast(v); springTo(cam, v = {x:0,y:0,zoom:0}); stretchZoom(zoom) → zoom actually shown; settle(v = {x:0,y:0,zoom:0}); get moving() }`. `apply(cam)` writes a camera to the DOM.

Behaviour:
- `coast(v)` (v in pt/ms) animates x, y with `coastOffset` until `|decay(v, t)| < 0.02`.
- `springTo(target, v)` runs a critically damped spring (stiffness 250, damping 2√250, mass 1, matching a 0.4 s response) on x, y, zoom; uses its own integrator so it can start from any velocity and is testable without the DOM.
- `stretchZoom(z)`: beyond [0.25, 2] returns `limit · exp(rubber(ln(z/limit), 0.5))`.
- `settle(v)`: if zoom is outside the limits, `springTo` the clamped zoom keeping the world point at the screen centre fixed.
- `stop()` cancels whatever runs and leaves the camera where it is.

- [ ] **Step 1: failing tests** with a fake clock (`now`, `raf` that queues callbacks, a `tick(ms)` helper):

```js
test("a coast moves by the UIKit decay and stops by itself", () => { /* coast({x:1,y:0}); tick 16 ms ×200; assert cam.x ≈ projection(1) within 10 pt and !moving */ });
test("stop leaves the camera where it is", () => { /* coast; tick 100; const x = cam.x; stop(); tick 100; assert cam.x === x */ });
test("a spring reaches its target without overshoot and stops", () => { /* springTo({x:100,y:0,zoom:1}); tick ×120; assert |x−100| < 0.5, max x ≤ 100.5 */ });
test("zoom past a limit stretches less than asked and settles back to the limit", () => { /* stretchZoom(4) < 4 and > 2; set zoom to it; settle(); tick; zoom ≈ 2 */ });
```

- [ ] **Step 2:** Run; FAIL. **Step 3:** Implement `camera.js` (semi-implicit Euler at the real frame dt, sub-stepped at 4 ms). **Step 4:** PASS.
- [ ] **Step 5:** Wire into `view.js`: `this.camera = new Camera((c) => this.apply(c))`; `setCamera(cam, animate)` → `animate ? this.camera.springTo(cam) : this.camera.set(cam)`; `stopGlide()` → `this.camera.stop()`. In `input.js`: `coastFrom(v)` → `this.app.view.camera.coast(v)`; `stopCoast()` → `camera.stop()`; `stoppedCoast` reads `camera.moving`; `pinch` passes the raw zoom through `camera.stretchZoom`; `pinchEnd(v)` → `camera.settle(v)` then coast for the pan part; `zoomDragEnd` → `camera.settle()`. Haptic hook left for Task 6.
- [ ] **Step 6:** Tests green; check on the phone: flick, pinch past 200 % and release. Commit "Coast, rubber-band and spring the camera as UIKit does".

### Task 3: Edge auto-scroll like Freeform

**Files:** Modify `web/input.js` (`edgeScroll`).

- [ ] **Step 1:** Replace the proportional speed with `edgeSpeed(depth, heldMs)` per axis, where `depth` is the distance from the visible area's edge and `heldMs` counts from when the finger entered the zone (reset on leaving). Run per frame with real `dt`.
- [ ] **Step 2:** Test in `web/test/physics.test.js` already covers `edgeSpeed`; check on the phone side by side with Freeform (drag a card to the right edge and hold 2 s). Commit "Auto-scroll at the edge as Freeform does".

### Task 4: Springs for cards and lanes

**Files:** Modify `web/view.js` (`renderCard`, `renderLane`, `animateTurn`), `web/style.css` (card/lane transitions).

- [ ] **Step 1:** Positions: cards and lanes stop using CSS `transition` for `transform`. In `renderCard`/`renderLane`, when an element's target position changes and it is not held, run `animate(el, { x, y }, { type: spring, stiffness: 400, damping: 36 })` from its current position (Motion retargets running animations); held elements set `x`/`y` directly. Sizes keep a short CSS transition.
- [ ] **Step 2:** Lift: `.lifted .sheet` scale by spring to 1.05 (Motion), shadow via CSS transition; drop: on `dragEnd` the element springs from the float position to the grid with the release velocity (`velocity` option) and scale back to 1.
- [ ] **Step 3:** New card: initial `scale 0.9, opacity 0` → spring to 1. Delete: the element is kept, animated to `scale 0.9, opacity 0`, then removed.
- [ ] **Step 4:** Turn: one `rotateY` animation on a spring with slight overshoot (damping ratio 0.8), swapping faces at 90°.
- [ ] **Step 5:** Reduce Motion: `animate` durations 0, or opacity crossfades. Tests green; phone check (drag, drop, restack, new, delete, turn). Commit "Move cards and lanes with springs".

### Task 5: Buttons and menus

**Files:** Create `web/press.js`, `web/menu.js`, tests `web/test/press.test.js`, `web/test/menu.test.js`; modify `web/ui.js`, `web/index.html`, `web/style.css`.

**Interfaces:**
- `press.js`: `track(el, { onDown, onEnter, onLeave, onUp(inside), slop = 70 })` built on a pure `PressTracker` class (`down(p, rect)`, `move(p)` → `"in" | "out" | null` changes, `up(p)` → inside?) that tests can drive.
- `menu.js`: `class Menus { open(button, menuEl); close(); get current() }`; open on pointerdown of the button; while that pointer is down, `elementFromPoint` hit items get `.hot` and a selection haptic; pointerup on an item runs it; a pointerdown anywhere outside the open menu closes it and calls `stopPropagation` + `preventDefault` in the capture phase so the board never sees it.

- [ ] **Step 1: failing tests** for `PressTracker`: inside → "in"; 69 pt outside the rect → still in; 71 pt → "out"; back → "in"; `up` outside → false.
- [ ] **Step 2:** Implement; PASS.
- [ ] **Step 3:** `ui.js` uses `track` for every `[data-act]` button (replacing `press()`); glass capsules (`.pill`, `.selection`, `.plus`, `#find`) get `.pressed` on down — CSS spring-like `scale: 1.08` with a lighter background — and the pressed button `.hot` (dimmed icon) while inside.
- [ ] **Step 4:** Menus (`.add .menu`, `.colours .menu`, `.menu.more`) open through `Menus`; the morph-in is Motion: from the button's rect (scale from the button's size, blur 8 → 0, opacity) to the menu with a spring; close reverses it.
- [ ] **Step 5:** Tests green; phone check against Freeform's … menu (hold, slide, lift on an item; tap outside). Commit "Press and open menus as UIKit does".

### Task 6: Haptics

**Files:** Create `web/haptics.js`; modify `web/index.html`, `web/input.js`, `web/menu.js`, `web/camera.js` callers.

- [ ] **Step 1:** `haptics.js`:

```js
let label;
/** Safari 18+ taps when a switch is toggled through its label during a user gesture; elsewhere it does nothing. */
export function haptic() {
  if (!label) {
    label = document.createElement("label");
    label.innerHTML = '<input type="checkbox" switch>';
    label.style.cssText = "position:fixed;left:-100px;top:0;opacity:0;pointer-events:none";
    document.body.append(label);
  }
  label.click();
}
```

- [ ] **Step 2:** Call it on: drop (dragEnd of a move or lane), crossing a zoom limit during a pinch or zoom drag, menu item hot change, menu item picked, lift (may be silent).
- [ ] **Step 3:** Phone check by hand is the only test (the simulator has no haptics); note the result. Commit "Tap the Taptic Engine where iOS would".

### Task 7: Bars, find and keyboard bar

**Files:** Modify `web/ui.js`, `web/index.html`, `web/style.css`.

- [ ] **Step 1:** `+` ↔ selection bar: both stay in the DOM; showing one runs a Motion spring on scale/opacity/width from the other's rect.
- [ ] **Step 2:** Bars hide while editing by sliding (top up, bottom down) with a spring instead of `hidden`.
- [ ] **Step 3:** Find: input gets a magnifier icon and a clear button (shown when non-empty); "Done" becomes "Cancel"; the bar slides down with a spring; `enterkeyhint="search"` stays and Enter steps to the next match.
- [ ] **Step 4:** Keyboard bar: CSS `transition: top 0.25s cubic-bezier(0.25, 0.1, 0.25, 1)` while the visual viewport changes.
- [ ] **Step 5:** Simulator screenshots light/dark; phone check editing and search. Commit "Animate the bars as iOS does".

### Task 8: Launch images

**Files:** Modify `scripts/make-web-icons.swift` (or a new `scripts/make-web-launch.swift`), `web/index.html`; add `web/launch-*.png`.

- [ ] **Step 1:** Generate portrait launch images for current iPhone point sizes × scale (375×667@2, 375×812@3, 390×844@3, 393×852@3, 402×874@3, 414×896@2/3, 428×926@3, 430×932@3, 440×956@3, 320×693@3 for Display Zoom), paper background with the icon centred, light and dark.
- [ ] **Step 2:** `<link rel="apple-touch-startup-image" media="(device-width: …) and (device-height: …) and (-webkit-device-pixel-ratio: …) and (prefers-color-scheme: …)" href="…">` per image.
- [ ] **Step 3:** Phone check: add to home screen again, launch, no white flash. Commit "Show a launch screen instead of white".

### Task 9: Side-by-side tuning

- [ ] Record Breezy and Freeform on the phone doing: a flick, a pinch past the limit, a drag to the edge held 2 s, a button press slid off, a menu slide. Compare contact sheets; tune spring constants and the edge ramp. Commit tuning as "Tune … to match Freeform".
