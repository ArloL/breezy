# Breezy corner turn — design

Turning a card on a phone feels too quick, and a card without notes has nothing to turn it by: the folded corner shows only once a card has notes, and a single tap on it turns the card. Tried on a phone with five corner sizes (artifact "Breezy Card Corners"), a double tap on a big corner felt right.

## Goals

- Every card has a corner to turn it by, on every platform.
- Turning takes a deliberate gesture: a double tap or a double-click on the corner.
- At a glance, cards with notes still stand out from cards without.
- A card at 100 % looks the same on the phone and the Mac.

## Non-goals

- The turn's animation, which stays as it is.
- Turning from far out: zoomed out, you zoom in to turn a card.

## Design

| | Now | Then |
|---|---|---|
| Corner, no notes | none | a 32 pt crease, a diagonal line where the fold would be, the sheet not cut |
| Corner, notes | 16 pt fold | 32 pt fold |
| Corner, turned | 24 pt fold | 32 pt fold |
| Single tap or click on the corner | turns | selects, as on the rest of the card |
| Double tap or double-click on the corner | edits | turns |
| Double tap or double-click elsewhere on the card | edits | edits |
| Space, Tab while editing, the selection bar's Turn over | turns | turns |
| Pointer tap area | the fold's own square | the corner's own 32 pt square |
| Finger tap area | 44 pt centred on the fold | a square inside the card, anchored to its bottom-right: 64 pt on screen at 100 % and above, shrinking with the card below 100 % |

**Cut-off.** Below a zoom level, a finger's double tap on the corner edits the card like anywhere else on it, as the corner is too small on screen to aim at. The crease and fold are drawn at every zoom; the owner judges on the phone whether that looks right. The zoom starts at 44 / 64 ≈ 69 %, where the finger's square shrinks under 44 pt, and is tuned on the phone. A pointer has no cut-off.

**Both apps.** The web app and the Mac app change together, as the parity tests hold their cores to the same transitions for mouse and keys: `hitTest` and `pressAction` in `web/policy.ts`, `Input.tap`/`doubleTap` in `web/input.ts`, `web/mouse.ts`, `CanvasCore.hitsFold`/`press` in BreezyKit, the drawing in `web/view.ts`/`style.css` and `Breezy/Canvas/CardLayer.swift`. The README's "Card back" row changes with them.

## Approaches

| Approach | Trade-off | |
|---|---|---|
| Double tap on a corner every card has | deliberate; a near miss edits the front | chosen |
| Single tap on a bigger corner | tried: too quick | |
| Triple tap anywhere | invisible; always lands in the editor, keyboard up | |
| Peel the corner by dragging | most physical; must be told apart from a pan; most work | |
| Two-finger tap | invisible; awkward one-handed | |

## Left to the builder

- The cut-off zoom, tuned on the phone.
- The crease's line weight and colour per card colour and theme.
- Which scenario, hub and UI tests move from a tap or click on the fold to a double one.
