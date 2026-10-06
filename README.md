# Breezy

A whiteboard for work thoughts: sticky-note cards and lanes on an infinite canvas, kept in one self-contained HTML file.

## Run

```bash
python3 breezy.py ~/Documents/board.html   # created if missing; --port to change 64570
```

Open http://localhost:64570/. Changes are written into the board file half a second after you make them. Earlier versions go to `backups/` beside it: at most one per 10 minutes, newest 50 kept. Opened straight from disk, the file shows the board read-only.

## Use

| Do | How |
|---|---|
| New card | double-click empty space |
| Edit card | double-click it; Esc or ⌘↩ to finish; first line is the title |
| Card back | Space over a card (or with one selected), or its folded corner, turns it over to show its notes; double-click to edit, Tab while editing turns it again |
| Move | drag; ⇧-click or ⇧-drag on empty space to select several |
| Colour | `1`–`5` |
| Delete | ⌫ |
| New lane | `L` at the cursor, or **+ Lane** |
| Lane | drag the header to move it with its cards, the corner to resize, double-click the header to rename |
| Pan / zoom | drag empty space or scroll / pinch or ⌘-scroll |
| Undo / redo | ⌘Z / ⇧⌘Z |

## Develop

```bash
node --test
python3 -m unittest discover --start-directory tests
```
