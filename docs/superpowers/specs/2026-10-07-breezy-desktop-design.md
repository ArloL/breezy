# Breezy web on the desktop — mouse, trackpad and keyboard

The touch prototype also runs in a desktop browser and behaves as the [Mac app](2026-10-06-breezy-mac-design.md) does. The bars stay as they are: macOS uses Liquid Glass too, and they work with a pointer.

## Routing

Each pointer event goes by `pointerType`. Touch and pen keep the gesture recogniser of the [touch design](2026-10-07-breezy-touch-design.md), unchanged. A mouse or trackpad pointer goes to a new handler with the Mac's rules; an iPad with a trackpad gets them too. Both drive the same actions in `input.js`, so moving, room-making, landing, lanes, edge scrolling and undo are shared.

## Pointer

Every press first ends an edit or rename, closes an open menu and stops a coasting camera. A press anywhere but the turned card turns it back.

| Press on | Click | ⇧-click | Drag (past 3 pt) | Double-click |
|---|---|---|---|---|
| Card | selects it; in a multi-selection the selection stays until release without moving, then collapses to the card | toggles it, no drag | moves the selection; with ⌥, selects the card's pile first | edits the side showing |
| Fold | selects the card and turns it | as click | — | the second click edits the side now showing |
| Lane corner | selects the lane | as click | resizes | nothing |
| Lane header | selects the lane | toggles it, no drag | moves the lane | renames it |
| Lane body, empty space | clears the selection | keeps it | selection box: the cards it touches; with ⇧ added to the selection | new card, top-left at the pointer, snapped |

- Hit areas are the Mac's, not touch's 44 pt: the fold is the card's 16 pt corner (24 turned), the lane corner 20 pt, the header 48 pt.
- A card's pile is it and the cards below it in its lane's column; outside a lane, the card alone.
- A drag never pans. Near or past the edge of the visible area it scrolls the board, as touch drags do.
- Only the primary button acts. The context menu is suppressed. The cursor is always the arrow.
- The card under the pointer is remembered for Space.

## Trackpad and wheel

- Wheel events pan: two-finger scroll, a mouse wheel, ⇧-wheel; macOS supplies the momentum. Line-mode deltas count 16 pt a line.
- A wheel event with ⌃ (a pinch arrives so in every browser) or ⌘ zooms around the pointer by `exp(-deltaY × 0.01)`, clamped to 25–200 %. Safari's own `gesture*` events stay suppressed.
- The zoom capsule shows while the zoom changes, as on touch.

## Keyboard

Shortcuts use ⌘ on Mac and Ctrl elsewhere. They act when no field has focus, except where noted.

| Key | Does |
|---|---|
| ⌘Z, ⇧⌘Z | undo, redo (also while editing: the edit ends first, as the undo button does) |
| ⌘A | selects all cards |
| ⌘F | opens find; ⌘G, ⇧⌘G next and previous match; ⌘E finds the selected card's first line |
| ⌘+ (or ⌘=), ⌘- | zoom by 1.25×, about the view's centre, animated |
| ⌘0, ⇧0 | 100 %, about the view's centre; ⇧0 by key position |
| Space | turns the card under the pointer, else the one selected card; again turns it back |
| Esc | turns a turned card back, else clears the selection |
| ⌫, Delete | deletes the selection; a lane's cards stay |
| 1–5 | colours the selected cards |
| L | new lane centred on the pointer |
| Esc, ⌘Return (editing a card) | ends the edit |
| Tab (editing a card) | turns it and edits the other side, in the same undo step |
| Return, Tab (renaming a lane) | ends the rename |

Return inserts a newline in a card. Browsers keep ⌘N, ⌘W and ⌘S, so there are none; full screen is the browser's.

## Code

- `mouse.js`: presses, drags and double-clicks of a mouse pointer. Its choices — what a press selects and which drag follows — are a pure function next to `dragAction` in `policy.js`, and `hitTest` takes the hit sizes.
- `keys.js`: a pure map from a key event to a command name, and the page's handler that runs it.
- Wheel: a pure function from a wheel event to a pan or a zoom; `main.js` applies it.
- `rules.js` gains `pile`, ported from BreezyKit.
- `app.js` gains the few commands touch lacked: select all, zoom steps, new lane at a point, new card at a point by its top-left.

## Testing

Unit tests, in `node:test` like the others, for the press policy, `pile`, the key map and the wheel mapping. In Chrome and Safari on the Mac, synthetic pointer, wheel and key events check the wiring. A real trackpad's pinch and momentum need a person to try.
