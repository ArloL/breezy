# Breezy for Mac — design

A native Mac app for the Breezy whiteboard: sticky-note cards and lanes on an infinite canvas. Single user, macOS only, no sync; the data model leaves room for encrypted per-card sync later.

## Interaction

### Canvas
- Infinite board on a 24 pt dot grid; positions snap to it.
- Two-finger scroll pans, with momentum. Pinch or ⌘-scroll zooms around the pointer, from 25 % to 200 %.
- The toolbar shows the zoom; clicking it, ⌘0 or ⇧0 (matched by key position) returns to 100 % around the window centre. ⌘+ and ⌘− zoom in steps.
- Dragging empty space draws a selection box; ⇧-drag adds to the selection. Dragging near the window edge scrolls the board.

### Cards
- Double-clicking empty space creates a card at the snapped pointer, ready to type. Esc, ⌘↩ or a click elsewhere ends editing. A card blank on both sides is deleted when editing ends.
- Plain text. The first line is the title, set semibold, also while typing.
- Width 240 pt; height is a whole number of 24 pt lines.
- Click selects, ⇧-click toggles. Dragging moves every selected card, snapping live. `1`–`5` set the colour of selected cards: yellow, pink, blue, green, grey. ⌫ and Delete remove them.
- Each card has a back for longer notes. Space over a card (else on the selected one), or clicking the folded corner that marks a card with notes, turns it over with a flip animation, lifts it above the others and widens it to 480 pt. Space, Esc or a click elsewhere turns it back. One card is turned at a time, and the turn is not saved.
- Double-click edits the side facing up. Tab while editing turns the card and keeps editing.

### Lanes
- `L` creates a 480 × 720 lane at the pointer; the toolbar's New Lane button creates one at the window centre.
- Dragging the header moves the lane with every card whose centre lies inside it when the drag starts. Dragging the bottom-right corner resizes it, snapped. Double-clicking the header renames it.
- Lanes draw behind all cards. Removing a lane keeps its cards.

### Stacking in lanes
- A card belongs to the lane its centre is in. Lane cards float up their column (cards overlapping horizontally) to 72 pt below the lane top, keeping their order, a grid line at least 12 pt apart. Lanes grow to fit and never shrink by themselves. Cards on the open canvas stay where they are put.
- While cards are dragged, the others make room where they would land, ordered by centre, and slide back when the drag moves on. Several dragged cards land as one block, ordered by their top card.
- Stacking also runs after creating or deleting cards and while typing grows a card. A turned card counts at its front's height.
- ⌥-drag on a lane card takes it and the cards below it in its column.

### Everywhere
- Undo and redo, 100 steps, named in the Edit menu ("Undo Move"). A drag or an edit session is one step.
- ⌘F opens the system find bar. It searches card fronts, card backs and lane titles; next and previous scroll to each match and highlight it, turning a card over for a match on its back.
- Light and dark appearance follow the system. Every colour token, the five card tints included, has a dark value.

### Look
Rams-era restraint: warm paper, one ink at three strengths, hairline rules, soft tints for cards, and one orange accent used only for selection, the caret and the find highlight. Lane titles are spaced capitals; a card's title looks the same on both sides. No text is smaller than 16 pt, and text sits on a 24 pt line equal to the grid. Positions animate with one easing curve, except what the pointer holds; Reduce Motion turns animation off.

### Out of scope
Sync, export, gravity switched off per lane, an iOS app, arrows between cards, images, markdown.

## Architecture

### Repository
- `BreezyKit/` — a Swift package depending on Foundation only, tested with `swift test`.
- `Breezy.xcodeproj` with the `Breezy` app target, which uses BreezyKit as a local package. It builds from the command line with `xcodebuild`.

### BreezyKit
- **Model.** `Board`, `Card` and `Lane` are value types with stable string ids. A `Board` value is a complete state, so undo keeps previous values.
- **Rules.** Snapping, lane membership, stacking, making room during a drag, landing a drop and taking a pile. Card heights come in as a function, so the rules need no fonts.
- **Format.** Reads and writes `.breezy` files (see below).
- **Search.** Finds matches in card fronts, card backs and lane titles, reported as (item, side, range).

### App
- `BoardDocument` — an `NSDocument` subclass. It owns the current `Board`, applies every change through BreezyKit, registers undo (`levelsOfUndo = 100`) and autosaves in place, off the main thread.
- `BoardWindowController` — the window, the toolbar (New Lane, zoom readout) and the find bar, an `NSTextFinder` whose client is backed by BreezyKit's search.
- `CanvasView` — the scroll view's document view. It turns pointer, trackpad and key input into document changes and holds no board state of its own.
- Rendering: a card is a `CALayer` showing an `IOSurface` of its own, drawn at the zoom's scale from a snapshot of what it depends on, so that several cards can be drawn at once on all cores; only cards near the viewport have one, and none while the window is out of sight. Scrolling and zooming lay out the cards once per frame. Lanes draw fill and border as layer properties; the dot grid repeats one dot with replicator layers behind the scroll view. Also the inline card editor (a TextKit 1 `NSTextView`) and the flip animation.
- `Theme` — colour tokens with light and dark values, re-applied to layers when the effective appearance changes.
- `TextMetrics` — measures card heights, cached by text and width, for the rules.

### Data flow
Input on the canvas becomes a request to the document, such as "move these cards by Δ". The document keeps the current `Board` for undo, applies the BreezyKit rule and notifies the canvas, which diffs old and new boards by id and updates only the affected layers. A drag mutates the board on every pointer move but registers one undo step when it ends; an edit session does the same. Until then the change counts as unsaved, so autosave and closing keep it; a card being edited is saved as it would stand once finished. Autosave writes the file when macOS decides.

## File format

A `.breezy` file is UTF-8 JSON, pretty-printed with sorted keys:

```json
{
  "cards": [{ "color": 1, "id": "c…", "notes": "…", "text": "Title\nbody", "w": 240, "x": 24, "y": 72 }],
  "format": 1,
  "lanes": [{ "h": 720, "id": "l…", "title": "Doing", "w": 480, "x": 0, "y": 0 }]
}
```

- Card order is stacking order. `notes` is omitted when empty.
- Scroll position and zoom are window state, kept by macOS window restoration, not in the file; scrolling never dirties the document. A board opened without restorable state fits itself to the window.
- The app exports the type `local.breezy.board` with extension `.breezy` and its own icon.

### Documents
Autosave in place, Versions (File → Revert To → Browse All Versions), Recent items, window tabs, and Duplicate, Rename and Move from the title bar — all standard `NSDocument` behaviour. Versions replaces the web version's `backups/` folder.

### Errors
- A file that fails to parse, has the wrong shape or holds non-finite numbers is refused with the standard "could not be opened" alert stating the reason.
- A file whose `format` is higher than the app knows is refused as made by a newer Breezy. Unknown fields in a known format are ignored.
- On load, duplicate ids are replaced and colours outside 1–5 are clamped.
- `NSDocument` writes atomically; a failed save shows the standard save error sheet.

## Performance

Budgets, measured with the spike's scripted benchmark (zoom sweep, trackpad pan, card drag) on a release build and reported as 95 % confidence intervals over five runs:

| Board | Idle | Peak |
|---|---|---|
| Your board | within 5 MB of an empty window | < 40 MB |
| 500-card stress board | — | < 100 MB |

Idle CPU is zero. No pan, zoom or drag step redraws a card whose content did not change. The benchmark stays in the app behind a launch argument.

## Testing
- BreezyKit unit tests: edits, stacking, undo and pending changes; format round trip, newer-format refusal, malformed files, id repair and recentring; search.
- Self-tests in the app (`scripts/selftest.sh`): the XCUITest scenarios and a few more, driven by synthetic events, for runs where XCUITest cannot activate the app, such as a locked screen.
- XCUITests on the app: create a card, type, undo; drag a card into a lane and check where it lands; find text on a card's back.
- Window captures of the board, a turned card and dark mode, looked at before a feature counts as done.

Done means: every behaviour above works, the tests pass and the performance budgets hold.
