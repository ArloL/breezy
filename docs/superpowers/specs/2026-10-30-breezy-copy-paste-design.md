# Breezy copy and paste of cards — design

A card held a food order; someone else wanted the same. Making a second card meant retyping it. Copy and paste makes the second card in two keys, ready to change the name on. Tried in the browser on branch `spike/copy-paste` (throwaway): the placement below felt good.

## Goals

- ⌘C / ⌘V (Ctrl on other systems) copy and paste the selected cards, in the web app and the Mac app alike.
- On phones, the same by buttons, on iPhone and Android.
- A copy carries the front, the back and the colour, and is a card of its own: a fresh id, synced and undone on its own.
- A copy lands where you'd look for it, never on top of anything.
- What one app copies, the other pastes, and so does another board, space or browser tab.

## Non-goals

- Copying lanes. A selection's lanes are left out; its cards are copied (my call).
- Pasting text from other apps as new cards (my call).

## Design

| | |
|---|---|
| Copy | the selected cards to the clipboard, as cards and as plain text |
| Cut | copy, then delete the selected cards, not its lanes, as one undo step (my call) |
| Paste | copies of the clipboard's cards, selected, as one undo step named "Paste" |
| Copy of a card that stood in a lane, pasted on its board | goes into the stack right below its original; the cards below make room, as when a card is dragged in. After a cut, it goes back where the original stood in that lane (my call) |
| Every other copy, on its board | the copies move as one block, keeping their arrangement, to the clear space nearest where the originals stand (`openSpot`): a grid from every card and lane, as Finder pastes |
| On another board | the block goes to the clear space nearest the view's centre (my call) |
| After any paste | the view reveals the copies, as after a new card |
| Pasting again | the same rule, the earlier copies now taken: lane copies stack under the original, free copies spread out around it |
| While editing a card or lane title, or in the find field | the keys copy and paste text, as now |

The clipboard carries each card's id and where it stood, and the board pasted to tells "its board" by finding an original's id, or, after a cut, the lane under where it stood.

**Phones.** The selection bar gets Copy, beside Turn over, Colour and Delete, for any selection with cards; Cut stays a key (my call). The + menu gets Paste after Card and Lane (my call). Paste reads the clipboard with `navigator.clipboard.read()`, which on iOS shows its own Paste callout to tap, and on Android may ask once; if the read is refused or holds no cards, it pastes what this page last copied, if anything (my call). Copy writes with `navigator.clipboard.write()`, from the tap itself, as both require.

**Plain text.** The selected cards' fronts in reading order, separated by a blank line, for pasting into a message.

**Both apps.** The placement is a rule of the board, in `web/rules.ts` and BreezyKit's `Edits.swift`, tested on both and held to the same results by the parity tests. The Mac's `CanvasView` answers `copy:`, `cut:` and `paste:` while no editor is first responder and enables the Edit menu's items by the selection and the clipboard; the web app answers the document's `copy`, `cut` and `paste` events while the board has the keyboard. The README's table gets a Copy row.

**Clipboard between the apps.** A browser's custom clipboard types (`application/x-…` in a `DataTransfer`) stay inside that browser, so the cards also travel as HTML both sides can write and read: the plain text, with the cards as JSON in an attribute. Three carriers were measured, each with a copy written in a `copy` event (on the Mac, `public.html` through `NSPasteboard`) and read in a `paste` event (on the Mac, `public.html`), on macOS 27.0.1 with Chromium 156 for Chrome, Safari 27.0.1, Firefox 159 and Safari on the iOS 27.0 Simulator:

| Pasted in ← copied in | `<div data-breezy="JSON">` | `<!--breezy:JSON-->` | `<meta name="breezy" content="JSON">` |
|---|---|---|---|
| Chrome ← Chrome, Firefox, the Mac | kept | kept | kept |
| Firefox ← Firefox, Chrome, the Mac | kept | kept | kept |
| Safari ← Safari, same origin | kept | kept | kept |
| Safari ← Safari of another origin, Chrome, Firefox, the Mac | kept | dropped | dropped |
| Chrome, Firefox, the Mac ← Safari | kept | dropped | dropped |
| the Mac ← Chrome, Firefox | kept | kept | kept |
| iOS Safari ← iOS Safari, another origin | kept | dropped | dropped |
| iOS Safari ← the Mac, another browser | not measured | not measured | not measured |

Safari serialises what it writes, and what it reads from another origin, afresh: it adds a `<head>` and inline styles and drops comments and `<meta>`, but keeps `data-` attributes. The carrier is `<div data-breezy="JSON">text</div>`, kept on every path measured: the JSON with `<`, `>` and `&` written as `\u003c`, `\u003e` and `\u0026`, then `&` and `"` escaped for the attribute; a reader finds the element by its attribute, as browsers wrap the fragment.

## Approaches to placement, tried or weighed

| Approach | | |
|---|---|---|
| Offset a grid step down and right, overlapping | tried: repeated pastes hide each other | |
| Cascade a step further each paste | weighed | |
| Repeat the move of the last copy | weighed | |
| Under the pointer | weighed | |
| Nearest clear space, and below the original in a lane | tried: felt good | chosen |

## Left to the builder

- The clipboard's JSON and HTML shape, versioned so a later field can be added.
- Tests at each level `TESTING.md` gives: placement in both cores' unit tests, the commands in the parity tests, copy in one app pasted in the other on real devices, and the phone buttons on the iPhone and Android in the nightly.
- The Copy button's icon, and whether Paste is greyed when this page has copied nothing (the clipboard cannot be read without a tap).
