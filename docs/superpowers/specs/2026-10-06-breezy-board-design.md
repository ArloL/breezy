# Breezy board — design

A personal whiteboard for work thoughts and ideas, in the style of Mural: an infinite canvas of sticky-note cards with optional lanes. Single user, macOS, Firefox first.

## Interaction

### Canvas
- Infinite board on a dot grid. Grid: 20 px; positions snap to it.
- Drag empty space: pan. Trackpad scroll: pan. Pinch or ⌘-scroll: zoom, around the cursor, range 0.25–2.
- ⇧-drag empty space: rubber-band select cards.

### Cards
- Double-click empty space (including inside a lane): new card at the snapped cursor position, caret ready.
- Esc or click elsewhere ends editing. A card whose text is empty or whitespace is deleted when editing ends.
- Plain text. First line renders bold as the title. Width 200 px; height grows with the text.
- Click selects (⇧-click toggles). Double-click edits. Drag moves all selected cards, snapping live.
- Each card has a back for longer notes, like an XP story card. Space, or clicking the folded corner that marks a card with notes, lifts the card under the pointer (else the selected one) above the others, turns it over and widens it to 400 px. Space, Esc or clicking elsewhere puts it back. Only one card is turned over at a time, and that state is not saved.
- Double-click edits the side facing up. Tab while editing turns the card over and keeps editing. A card is deleted only when both sides are blank.
- Keys `1`–`5` set the colour of selected cards: yellow, pink, blue, green, grey. ⌫ / Delete removes them.

### Lanes
- `L` key or the toolbar button: new lane (400 × 600) at the cursor, or at the viewport centre when using the button.
- Drag the header to move. Drag the bottom-right corner to resize (snapped). Double-click the header to rename.
- Moving a lane carries every card whose centre lies inside it when the drag starts.
- Lanes render behind all cards. Selecting a lane and pressing ⌫ removes the lane, not its cards.

### Stacking in lanes
- A card belongs to the lane its centre is in. Lane cards float up their column (cards overlapping horizontally) to 60 px below the lane top, keeping their order, a grid line at least 10 px apart. Lanes grow to fit, never shrink by themselves. Cards on the open canvas stay where they are put.
- While cards are dragged they stay under the pointer; the others make room where they would land, ordered by centre, and slide back when the drag moves on. Several dragged cards land as one block, ordered by their top card. Dropping moves them into place.
- Gravity also runs after deleting cards, after creating one, and while typing grows a card. A turned card counts at its front's height.
- ⌥-drag a lane card takes it and the cards below it in its column.

### Everywhere
- ⌘Z undo, ⇧⌘Z redo; 100 steps. Keyboard shortcuts are ignored while a text field has focus, except Esc.
- Cards are DOM text, so the browser's ⌘F finds them.

### Look
Rams-era restraint: warm paper, one ink at three strengths, hairline rules, soft paper tints for cards, and a single orange accent (`--accent`) used only for selection and the caret. Lane titles and card-back headings are small spaced capitals. Positions animate with one easing curve, except for what the pointer holds; `prefers-reduced-motion` turns it off.

### Out of scope
Arrows between cards, images, markdown, ⌘F on a card's back while it faces front, tags, multiple boards per file, collaboration.

### Ideas not yet tried
- Plain drag on empty space draws the selection box (as in Finder), panning by scroll and pinch only.
- Gravity per lane, so a lane can stay free-form.
- Bold first line while editing; a textarea cannot style it, so it needs a different editor.

## Architecture

```
app/index.html   page template; placeholders for CSS, JS and data
app/board.css
app/model.js     state, operations, snapping, undo — no DOM
app/view.js      renders state to DOM
app/input.js     pointer/keyboard events → model operations
app/main.js      wires model, view, store and input together
app/store.js     load from the inlined JSON, debounced save
breezy.py        server and page assembler (Python stdlib)
board.html       the user's board: app + data, self-contained
```

JS files are classic scripts concatenated into one inline `<script>` in the order model, view, store, input, main. `model.js` ends with `if (typeof module !== "undefined") module.exports = …` so Node can test it.

### Data

```json
{
  "rev": 7,
  "view":  {"x": 0, "y": 0, "zoom": 1},
  "cards": [{"id": "c…", "x": 40, "y": 60, "w": 200, "text": "Title\nbody", "notes": "back of the card", "color": 1}],
  "lanes": [{"id": "l…", "x": 0, "y": 0, "w": 400, "h": 600, "title": "Ideas"}]
}
```

Inlined in the page as `<script type="application/json" id="board-data">`, with `<` escaped as `\u003c`.

### Server: `python3 breezy.py [board.html] [--port 64570]`
- Binds 127.0.0.1 and answers only requests whose `Host` is `127.0.0.1:<port>` or `localhost:<port>`, which blocks DNS rebinding.
- Creates an empty board if the file does not exist; refuses to start on a file without valid board data.
- `GET /`: assembles the page from the current `app/` and the data block from `board.html`.
- `PUT /data`: JSON body. Rejects with 409 if `rev` differs from the file's `rev`. Otherwise copies the current file to `backups/board-YYYYmmdd-HHMMSS-ffffff.html` unless the newest backup is under 10 minutes old (keeps the newest 50), increments `rev`, writes the assembled page to a temp file and renames it over `board.html`, then returns the new `rev`.

### Client saving
- Every model change schedules a save 500 ms later; saves never overlap.
- Status indicator in a corner: `saved`, `saving…`, `not saving: server unreachable` (retries every 5 s), `changed elsewhere — reload` (on 409; saving stops).
- Opened from `file://`: read-only. The indicator says so, and edits are disabled.

## Testing
- `node --test`: model operations: create/move/delete cards, snapping, colour, lane move carries cards whose centre is inside, stacking and piles, undo/redo, empty-card removal.
- `python3 -m unittest`: assembly round trip, `<` escaping, PUT writes file and backup, backup pruning at 50, 409 on stale `rev`, new board when the file is missing.
- Manual pass in the browser for every interaction above; final check in Firefox by the user.
