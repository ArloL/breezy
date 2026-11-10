# Breezy native panning — the best pan on each platform

The owner wants panning to feel amazing on every platform, however big the change. Measuring the Mac trackpad against AppKit ([native reference](2026-11-10-breezy-native-reference-design.md), "Spike verdict") showed two ways to get there, each winning half of the strokes:

- **Native.** Firefox's own scrolling holds the stretch while a finger rests and pushes like AppKit (median 7 pt off). Its flicks into the edge are too soft (74 pt off), and it springs back about 300 ms slow.
- **Tuned.** WheelPan, with AppKit's band and spring (commit 451de6e), gets flick impacts closer (26 pt off with the experimental coast). It can't hold, because a wheel event never says whether a finger is down.

So Breezy gets both ways of panning. Each platform and input uses whichever comes closer to its own native reference, scored and then felt. The owner doesn't need native everywhere, only the best feel everywhere: "if it feels iOS-y on Safari that's fine".

## Goals

- **A native mode.** `#board` becomes a real scroll container whose content is the board at the current zoom, and Breezy's camera is read from the scroll position. The browser pans, coasts and rubber-bands: Firefox's APZ on the Mac, Safari's UIScrollView on iOS, Chrome on Android. Breezy keeps zoom (pinch, ⌘-scroll, ⌘0), the moves the app makes (reveal, zoom to edit, keep the editor above the keyboard), card and lane drags, the marquee, edge auto-scroll, and the board's edge growing to take in what shows.
- **The camera mode stays.** Today's Breezy-driven panning (`camera.ts`, `wheel.ts`, `input.ts`'s pan) remains, so each platform can use either.
- **A switch,** per platform and input, between the two modes: the default from the scores, and a `?pan=native|camera` override to feel both on any device.
- **Each mode scored against each platform's reference,** with the harness that exists: the owner's strokes replayed, the curves compared.
  - **Mac trackpad:** AppKit (`web/test/appkit-edge.json`).
  - **iPhone touch:** UIKit, via the parked UIKit twin of the reference app (memory `native-feel-reference-testing`), driven by `scripts/wda.py`/`scripts/sim-hid.py`.
  - **Android:** Chrome's own scrolling on the partner's phone size.
  - Native-mode curves come from screen tracking of a marker at the board's edge, already validated against AppKit's own curve to 0.2 pt.
- **The owner's hands decide** wherever the scores disagree or are close.

## Non-goals

- The native Mac app: it already pans with `NSScrollView`.
- Re-tuning the camera mode's touch physics, measured from Freeform, unless an iPhone score says so.
- Mixing modes within one gesture: a page can't take over a native scroll midway.

## Anti-goals

- **A native mode that stutters or tears:** the grid or the cards a frame behind the scroll, a jump when the content grows, or a jump at zoom. Any of these is worse than the camera mode, whatever the scores.
- **Losing a gesture that works today:** hold to lift a card, drag, marquee, double tap, pinch, the one-finger zoom, find, or the edge auto-scroll.
- **Picking a mode for a platform without its score and the owner's feel.**

## Constraints

- Test against localhost only, never breezy.k5d.de (AGENTS.md). Small PRs off main, merged green. The measuring kit's PR goes first.
- Facts measured so far:
  - AppKit's band: c = 0.07; its spring: critically damped at 19/s.
  - Firefox's native scrolling follows momentum deltas one for one; AppKit's coast moves about 0.55 of them and drops their 1–3 pt tail.
  - Firefox's native stretch is within about 15 % of AppKit's, and holds under a resting finger.
- The board reaches 1,194 pt past its outermost card or lane (`MARGIN`), as Freeform's does, and takes in what shows when the camera rests.
- iOS: the board runs as a Home Screen app and in a Safari tab; both must keep working, keyboard and editor included (TESTING.md's B1 cases).

## Risks to settle first, each with a throwaway spike

1. **The grid with the scroll.** Today the grid is a canvas redrawn on every camera move. A native scroll moves on the compositor, so a redrawn grid lags. The grid must sit in the scrolled content (a CSS pattern, scaled with the zoom). The spike shows it on the Mac and the iPhone with no lag in a screen recording, and with no flicker during a pinch on iOS. `grid.ts` records that a CSS grid scaled with the zoom once flickered there, which is why the grid is a canvas.
2. **Zoom on top of native scrolling.**
   - On the Mac: ⌘-scroll and the trackpad pinch (ctrl-wheel, `preventDefault`), plus scaling the content and the scroll position, so the point under the pointer stays put.
   - On iOS: with `touch-action: pan-x pan-y`, Safari leaves two-finger gestures to the page while it pans one finger natively. The spike shows a pinch starting mid-pan, and a pan starting mid-pinch, without a jump.
3. **Holding a card, and the gestures that aren't pans.**
   - A finger held still for 300 ms lifts a card. The native pan must not start after that, which means `preventDefault` on `touchmove` once lifted, before any scroll has begun.
   - A quick drag on a selected card still moves it, with no hold, as `policy.ts`'s `dragAction` has it today. So does the one-finger zoom, a double tap then a drag.
   - Both are decided at the first `touchmove`, from what the touch began on. Only a drag that is none of these is a native pan.
4. **The board growing.** When the board takes in what shows at the left or top, the content's origin moves. The scroll position must move with it in the same frame, and only once scrolling has ended (`scrollend`), so nothing jumps.
5. **Moves the app makes** (springs to reveal, zoom to edit) must run on the scroll position frame by frame, and a touch must catch them, as today.

If spike 2 or 3 fails on iOS, the iPhone keeps the camera mode, and native stays where it wins (the Mac trackpad).

## Decided by the owner

- The best feel on every platform wins, however big the change.
- Native isn't required everywhere; iOS-like on Safari is fine.
- Both modes are built and compared by score and by feel.
- The tuned band and spring are committed now (451de6e).

## My calls

**How the mode is chosen**
- One code path for each mode, chosen when the board opens, by platform and pointer, not switched mid-session.
- `?pan=native|camera` sets the mode and keeps it in the app's storage, so a Home Screen app takes it from one visit to its own start page with the parameter.
- A temporary item in the board's menu, "Panning: native / camera", lets the owner switch in the Home Screen app while the modes are compared. It goes once each platform's mode is settled.

**Which platforms are scored**
- Only the pairs the owner and partner use get a mode decided and scored:
  - Firefox on the Mac with a trackpad;
  - the iPhone's Home Screen app and Safari;
  - Chrome on Android.
- Every other pair keeps the camera mode.
- A Mac's mouse wheel goes with whatever mode the Mac has; in the native mode it scrolls natively, unscored.

**Order and the camera candidate**
- The Mac trackpad goes first: its reference and harness exist. Then iOS, after the UIKit twin.
- The experimental coast is a trackpad matter. It lives in `wheel.ts` alone, so it is scored on the Mac alone, as a third candidate: the camera mode with it, the camera mode without it, and native. It moves 0.55 of the momentum's deltas, drops deltas of 3 pt and less, and carries 0.25 of the momentum's speed into the bounce. On the Mac it scored a median 26 pt off on flick overshoot, against 163 without the coast and 74 native.

**Android**
- Android keeps the camera mode. Chrome's own scrolling can't be scored against itself, and a true reference (an Android app's own scroll view) is a project of its own. The partner's ease (quality goal 1) ranks above feel.
- Android is revisited only with that reference, or if the partner asks.

**Tests**
- The fakes model the camera mode only:
  - the hub's cases on fakes (L3);
  - conformance (L2);
  - `scripts/parity.ts`.
- Each real device runs its default mode in the nightly cases (L6). A device whose default becomes native gets cases for the gestures that change: pan, hold and lift, a quick drag of a selected card, pinch, and a reveal caught by a touch.
- L3 no longer owns pan bugs (B3) on those devices; TESTING.md says so. A fake scroll container comes only if the fakes' decisions drift from the real devices'.

**The measuring kit's PR**
- It holds `try/bounded-canvas`'s reference work on main, with the screen tracker rebuilt as a script in the repo.
- The tracker is checked against AppKit's own curve again before any native score counts. It last matched to 0.2 pt.

## Left to the builder

- The DOM shape of the scrolled content: a spacer and the transformed world, or the world sized directly.
- How the native-mode camera is kept: derived from `scrollLeft`/`scrollTop` and the zoom on each `scroll` event, or read when needed.
- How each mode's scores are reported: an extension of `scripts/appkit-score.ts`.

## Spike findings

Tried by the owner on 2026-11-10 in Firefox on the Mac and Firefox for iOS (WebKit) on the iPhone, with a throwaway `?pan=native` on branch `spike/native-pan`. Each step was debugged from the page's flight recording and, on the iPhone, a screen recording.

**Each risk, settled**

1. **The grid.** It moves with the scroll as a CSS pattern in the scrolled content. During a pinch it is the canvas again: iOS paints only near the window, and a scaled content showed grey where it had not painted.
2. **Zoom on top of native scrolling.** On the Mac, ⌘-scroll and the trackpad pinch zoom in Breezy as before; a plain wheel goes to the browser. On iOS, a pinch:
   - **Fresh,** both fingers down before the board moves: the browser's pan is stopped (`preventDefault` on `touchmove`), and the drawn content is scaled with a CSS transform around the board point first under the fingers, its scrolling stopped (`overflow: hidden`). It lays out once, when the fingers lift. Laid out on every step, it jumped and showed grey.
   - **Begun on a pan iOS has already taken:** iOS goes on panning whatever the page does, `overflow: hidden` included. Moving the content into an overlay that doesn't scroll stops the pan; the pinch runs there, and the content goes back when it ends. The pinch's touch listeners must be on the document, as the touches' targets leave the board.
   - **A finger left after a pinch:** iOS starts no new pan for a touch already down, so Breezy pans the board after that finger and coasts from its speed. Freeform doesn't pan and zoom in one touch; the owner tried it anyway and found it "feels good".
   - **iOS's gesture events** (`gesturestart`/`gesturechange`) must not zoom in native mode on iOS: Breezy holds no pointers on a native pan, and they zoomed under it. On a Mac, Safari sends its trackpad pinch the same way, so the real build tells the two apart.
   - **Its end:** a pinch on a taken pan may end in `touchcancel`; a pinch still for 400 ms ends.
3. **Holds and gestures that aren't pans.** Each must stop the browser's pan on `touchmove`, before any scroll has begun:
   - a card lifted by a hold (`state.lifted`), since the hold comes before any drag;
   - a quick drag of a selected card;
   - a double tap's second touch, the one-finger zoom.

   The one-finger zoom zooms around the point first touched. Breezy's `touchstart` `preventDefault`, which kept iOS's magnifier off card text, stops all native panning, so native mode drops it; the magnifier then showed only where the owner expected it.
4. **The board's growth.** It takes in what shows on `scrollend` after a pan of the user's, never after the app's own moves, which end on every frame, nor during a pinch. The content stays a point larger than the window, or Firefox won't rubber-band a board that fits it, as at 25 %.
5. **The app's own moves** (find, reveal) write the scroll position frame by frame. A `scroll` event at the position just written is the app's own echo, not a pan; taken for a pan, it stopped the spring.

**Also found**
- **The board's size** comes from the scroll container; the hidden grid canvas measured 0 × 0.
- **Editing.** While a card is being edited the board doesn't scroll, except for a touch begun outside the editor. iOS scrolled it to keep a dragged or spacebar-moved caret in view, taking the card out of sight.
- **The Mac.** The owner found everything good: the rubber band at any zoom, find's glide, flicks, dragging cards.
- **The iPhone.** Native mode's own pan, flick and edge haven't yet been scored against UIKit or felt against camera mode on their own.
