# Breezy touch prototype — native feel

The [touch prototype](2026-10-07-breezy-touch-design.md) should feel like an iOS app: nothing in how it moves, presses or responds should give away a web page. Only the feel changes. Every gesture keeps the meaning that spec gives it.

The reference is iOS 27 on an iPhone 13 mini: UIKit's standard behaviour, and Freeform as the closest Apple app, driven and recorded with the phone rig (`scripts/wda.py`, `scripts/phone-record.swift`).

## Measured in Freeform

| Behaviour | What Freeform does |
|---|---|
| Edge auto-scroll while dragging | None 70, 40 or 30 pt from the edge; scrolls 20 pt from it. Held there 0.25, 0.5, 0.6, 0.7 and 0.8 s it scrolled 12, 33, 46, 61 and 96 pt, and over 210 pt by 0.9 s: a crawl, then a sharp speed-up. |
| Pressing a glass toolbar button | The whole capsule grows (about 14 % wider) and its glass lightens; the pressed icon dims. About 80 pt away the icon un-dims, but the capsule stays grown until the finger lifts. Lifting outside does nothing; the capsule springs back. |
| Coasting after a flick | About 65 ms × the release velocity (19, 44 and 61–67 pt for 0.4, 0.67 and 1 pt/ms), a deceleration of about 0.985 per ms: much shorter than a UIScrollView list's 0.998. |
| Pull-down menu (…) | Opens on touch-down, morphing out of the button as a blurred blob. Sliding over items highlights them with a glass pill; lifting on one picks it. Resting on an item with a submenu opens the submenu in place. A tap outside closes the menu and does nothing else. |

Speeds from the dot grid were unreliable past about 12 pt per frame, because the dots repeat every 25 pt; the figures above are the trustworthy part.

## Design

### 1. Camera physics
- A pan coasts from the finger's velocity, decelerating as Freeform's canvas does, 0.985 per millisecond. A touch during a coast stops it and is not a tap.
- Past 25 % or 200 %, pinch and one-finger zoom stretch with UIKit's rubber band, `(1 − 1 / (x·0.55 / d + 1))·d`. On release a spring returns to the limit, carrying the release speed. Crossing a limit gives a light haptic.
- After a pinch, the point between the fingers coasts like a pan.
- Moves the app makes (the zoom readout, revealing a search match, zooming to edit, keeping the editor above the keyboard) are critically damped springs (response about 0.4 s) instead of a fixed CSS curve. A touch catches them where they are.

### 2. Cards and lanes
- Lift after the 300 ms hold: a spring to 1.05× with a deeper shadow.
- What the finger holds follows it exactly. Cards and lanes moving out of the way, or restacking, move with springs that retarget smoothly.
- Drop: a spring from the finger to the grid position, carrying the release velocity, back to 1×. A soft haptic on landing in a lane.
- New cards spring in from 0.9×; deleted ones shrink and fade while their neighbours close up.
- Turning over is one 3D flip on a spring with a slight overshoot.
- Selection shows at once.
- Edge auto-scroll matches Freeform: a 24 pt zone at the edge of the visible area, crawling at 45–150 pt/s for about 0.7 s, then speeding up sharply to 1,500 pt/s by about a second.
- With Reduce Motion, springs become short crossfades.

### 3. Buttons, menus and bars
- **Buttons track like UIControl:** highlight on touch-down; un-highlight beyond about 70 pt and re-highlight on return; act only when lifted inside. In glass capsules the whole capsule grows and lightens while a finger is down, the pressed icon dims, and it springs back on release.
- **Menus are pull-down menus:** they open on touch-down and morph out of their button with a spring. Sliding highlights items with a glass pill and a selection haptic; lifting on an item picks it; lifting elsewhere leaves the menu open. A tap outside closes it and goes no further. Closing morphs it back into the button.
- **Bars:** the **+** and the selection bar morph into one another with a spring. The bars slide away while editing and return afterwards. Button labels that change, such as the zoom readout, cross-fade.
- **Find** is an iOS search field: magnifier inside, clear button once there is text, Cancel to close. It slides in under the top bar with a spring; the keyboard's Search key goes to the next match.
- **Keyboard bar:** moves with the keyboard's curve (about 0.25 s) when the keyboard comes and goes.

### 4. System
- **Haptics:** Safari 18+ taps when a hidden `<input type="checkbox" switch>` is toggled through its label during a user gesture. It is used where iOS would tap: drops, crossing a zoom limit, picking a menu item, and moving between menu items. The 300 ms lift fires from a timer, outside any user gesture, so it may stay silent; the phone decides.
- **Launch images** (`apple-touch-startup-image`) for the iPhone sizes, in paper colour with the icon, light and dark, so launching from the home screen does not flash white.

## Architecture

| File | Role |
|---|---|
| `vendor/motion.js` | Motion 14's standalone bundle (MIT), unchanged. |
| `motion.js` | Imports it and re-exports `animate`, `spring`, `motionValue`, `frame`, `cancelFrame`. |
| `physics.js` | Pure functions, tested in Node: UIKit decay, projected distance, rubber band, edge-scroll speed. |
| `camera.js` | The camera animator: coasts, rubber-banding and springs on `{x, y, zoom}`; stops on touch. Replaces the `glide` CSS. |
| `press.js` | UIControl-style tracking for every button, and the glass capsule press. |
| `menu.js` | Pull-down menus: open on touch-down, slide to pick, dismissal that swallows the tap. |
| `haptics.js` | The switch toggle. |
| `view.js`, `input.js`, `ui.js`, `style.css` | Use the above: springs for layout changes, lift and drop, turning, bars. |

## Testing
- `node --test web/test/`: the physics functions, and the gesture machine as before.
- On the phone with the rig: record Breezy and Freeform doing the same thing (a flick, a drag to the edge, holding a button and sliding off, a menu slide), compare the frames side by side, and tune until they match.
- Simulator screenshots for layout in light and dark mode.
