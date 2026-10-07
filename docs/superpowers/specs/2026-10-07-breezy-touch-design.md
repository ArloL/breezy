# Breezy for iPhone — touch prototype design

A web page that runs Breezy on an iPhone, added to the home screen, to find out whether the Mac app's interaction model feels good under fingers. It answers that question only: no files, no persistence, no sync. Reloading starts again from the sample board.

## Interaction

Everything not mentioned here behaves as in the [Mac design](2026-10-06-breezy-mac-design.md): the grid and snapping, lanes and stacking, making room while dragging, card backs, colours, undo, search and the look.

### Two pan modes
A switch in the settings menu (⋯) chooses who owns a one-finger drag; the choice is remembered on the device.

| Touch | One finger pans | Two fingers pan |
|---|---|---|
| One-finger drag on empty space | pans, with momentum | selection box |
| One-finger drag on a selected card | moves the selection at once | moves the selection at once |
| One-finger drag on an unselected card | pans | selects it and moves it at once |
| Hold a card (300 ms) | it lifts; drag moves it, lifting without moving toggles it in the selection | lifting without moving toggles it in the selection |
| Hold empty space, then drag | selection box | selection box |
| Drag a lane header | pans; hold first to move the lane | moves the lane |

In both modes:
- Two fingers pan and pinch-zoom together, anywhere, 25 % to 200 %. Tapping the zoom readout returns to 100 %.
- Tap a card selects it; tap empty space clears the selection. Selection shows at once; a double tap does not wait for it.
- Double-tap empty space creates a card; double-tap a card edits it; double-tap a lane header renames it.
- The lane's resize corner drags at once in both modes; its touch area is 44 pt.
- A finger that moves more than 8 pt before 300 ms is a drag, not a hold.
- Dragging near the screen edge scrolls the board.
- A lifted card scales up slightly and casts a shadow. iOS web pages have no haptics.

### Bars
Top, below the safe area: undo, redo, zoom readout, search, ⋯.

Bottom, above the home indicator: a **+** button offering Card or Lane, placed at the screen centre. While cards are selected, it gives way to the selection bar: five colour swatches, Turn, Pile and Delete. Pile appears when one lane card is selected; it selects that card and the cards below it in its column, so the next drag moves them as a block, as ⌥-drag does on the Mac.

### Editing
- Editing zooms the board to at least 100 % around the card and keeps it above the keyboard.
- A bar above the keyboard offers Turn (Tab on the Mac) and Done. Tapping outside the card also ends editing.
- The first line is the title, set semibold while typing. A card blank on both sides is deleted when editing ends.

### Turning a card
Tap its folded corner (44 pt touch area) or Turn in the selection bar. A turned card is 480 pt wide, or the screen width less 32 pt if that is narrower at the current zoom. Tapping elsewhere turns it back.

### Search
The search button opens a field under the top bar with next and previous. It searches card fronts, card backs and lane titles; each match scrolls into view with the accent highlight, turning a card over for a match on its back.

### Safari
The page switches off double-tap zoom, page pinch, the long-press callout, text selection outside the editor and rubber-band scrolling. A web app manifest makes it open full screen from the home screen.

## Architecture

Plain JavaScript modules in `web/`, no build step, no dependencies.

| File | Role |
|---|---|
| `rules.js` | A port of BreezyKit: snapping, lane membership, `settle` (stacking, making room, landing), pile, edits, search. Card heights come in as a function. |
| `model.js` | The board with undo and redo, 100 steps, as board snapshots. `perform` for one change, `begin`/`update`/`end` for a drag or edit session. |
| `gestures.js` | Turns pointer events into tap, double tap, hold, drag, two-finger pan-and-pinch. A state machine over (pointer id, x, y, time) with no DOM, so it can be tested. |
| `input.js` | Maps gestures to model changes and view moves, per pan mode. |
| `view.js` | Renders lanes and cards as DOM elements in a world layer transformed by pan and zoom; diffs boards by id. The dot grid is a CSS background following pan and zoom. Measures card heights, cached by text and width. Positions animate with one easing curve, except what a finger holds; Reduce Motion turns animation off. |
| `ui.js` | Top bar, bottom and selection bars, keyboard bar, search, settings. |
| `sample.js` | The sample board: three lanes with about 15 cards, some with backs, and a few loose cards. `?stress` loads 500 cards instead. |
| `index.html`, `style.css`, `manifest.webmanifest`, icon | Page, theme tokens from `Theme.swift` with dark values, safe areas. |

### Running it
`python3 -m http.server --directory web 8000` on the Mac; on the iPhone, on the same Wi-Fi, open `http://<mac-ip>:8000` in Safari and Add to Home Screen. Without HTTPS there is no service worker, so it needs the Mac running.

## Testing
- `node --test web/test/`: the rules ported with BreezyKit's stacking and edit tests; the gesture state machine fed synthetic touch sequences, for each mode.
- Screenshots in the iOS Simulator of the board, a selection, editing with the keyboard up, a turned card and dark mode, looked at before handing over.
- The real test is your thumb on your phone.

## Out of scope
Files and persistence, sync, offline use, iPad layout, hardware keyboard shortcuts, performance budgets.
