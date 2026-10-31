# Breezy Duplicate in the selection bar — design

On a phone, getting a few more cards under the one you're on took four steps: select it, Copy, unselect, Paste from the + menu, and iOS or Android then asked about the clipboard. Duplicate does it in one tap, with no clipboard involved. Replaces the phone half of `2026-10-30-breezy-copy-paste-design.md`.

## Goals

- One tap in the selection bar puts copies of the selected cards right where a paste on their own board puts them now: under the original in a lane, else in the nearest clear space.
- The copies come out selected, so a second tap makes another.
- Desktop browsers and the Mac app keep copy and paste through the keyboard and the Edit menu, as they are.

## Non-goals

- Carrying cards to another board, or card text to another app, from a phone. Duplicate replaces both, by the owner's choice.
- ⌘C/⌘V from a keyboard on an iPhone or iPad. A probe on the iOS 27 Simulator (iPad Pro 11", iPhone Duo) showed Safari fires copy only for highlighted text and paste only in a text field, so a selected card gets neither, and no key reaches the page outside a text field. Fixing that is separate work.
- A ⌘D shortcut.

## Approaches

| | Trade-off |
|---|---|
| **Duplicate replaces Copy in the bar everywhere, Paste leaves the + menu** (picked) | One bar on every device, no device check; the phone clipboard code goes away. A desktop browser gets a Duplicate button it can live with. |
| Duplicate on touch screens only | Needs a touch check the page lacks, which guesses wrong on iPads with keyboards and touch laptops; two bars to test. |
| Option 1 plus ⌘D | Work on the web and the Mac nobody asked for. |

## Design

| | |
|---|---|
| Selection bar | Duplicate where Copy stands, shown for any selection with cards; a selection's lanes are left out, as Copy left them (unchanged rule) |
| A tap | copies of the selected cards on this board, through the rules' same-board paste (`R.clip` then `R.paste`), as one undo step named "Duplicate" (my call), a haptic as Copy had, the copies selected and revealed |
| The clipboard | untouched: Duplicate reads and writes none of it (my call) |
| + menu | Card and Lane; Paste goes |
| ⌘C, ⌘X, ⌘V | unchanged in the web app and the Mac app |
| Icon | two overlapping cards with a plus (my call), labelled "Duplicate" |

Goes away with the phone clipboard: `Taps` in `web/clip.ts` and its tests, the app's `copied` fallback, the phone copy-and-paste scenario case and the devices' `tapToPaste` (iOS's Paste callout, Android's Allow). The scenario case becomes: a card duplicated with the selection bar on a phone shows right below it on the other device. The README's Copy row says Duplicate in the selection bar instead of the phone's Copy and Paste.

## Left to the builder

The test levels, by `TESTING.md`; the flight note's name; the icon's exact drawing.
