# Platform expectations

What people assume works when they type, paste, pick and point on each platform, one row each. `docs/superpowers/specs/2026-10-19-breezy-platform-input-design.md` says how each is tested; `scenarios/platform/rows.ts` holds the rows that have tests, and `scenarios/traces/` what each platform sent for them.

Layers: 1 the platform's own input, automated; 2 replays of recorded traces, on every push; 3 by hand on a device, recording a trace. `–` means the row does not apply to that target; a row naming other platforms waits for them.

| Row | Expectation | mac | firefox-mac | android | Status |
|---|---|---|---|---|---|
| A1 | Emoji picker inserts at the caret | 1 | 1 | 1, 3 | green on firefox-mac: the picker took the window's focus and the edit ended on the blur, fixed |
| A2 | Input method: Enter confirms, Esc cancels, edit goes on | 1 | 1 | 1 | green on firefox-mac, where keys while composing come as `Process`; Chrome and Safari send Esc and Enter as such, with `isComposing` |
| A3 | Korean commits a syllable on any key or click | 1 | 1 | 1 | untested |
| A4 | Dead keys and ⌥ accents | 1 | 1 | – | untested |
| A5 | Press-and-hold accent popup | 1 | 1 | – | untested |
| A6 | AltGr and ⌥ characters on other layouts | 1 | 1 | – | untested |
| A7 | Autocorrect, suggestions, undoing a correction | 1 | – | 1, 3 | untested |
| A8 | Text replacements, smart quotes and dashes | 1 | 1 | – | untested |
| A9 | Dictation | 3 | 3 | 3 | untested |
| A10 | Swipe typing | – | – | 1, 3 | untested |
| A11 | Handwriting | – | – | 3 | untested |
| A12 | Spell-check suggestion replaces the word | 1 | 1 | 1 | untested |
| A13 | Writing Tools, Proofread | 3 | 3 | 3 | untested |
| A14 | Inline suggestions, Win+V (Windows) | – | – | – | untested |
| A15 | Input methods on Wayland (Linux) | – | – | – | untested |
| B1 | Rich paste arrives as plain text | 1 | 1 | 1 | untested |
| B2 | Pasted CRLF leaves no stray carriage returns | 1 | 1 | 1 | untested |
| B3 | Pasting or inserting an image or file does no harm | 1 | 1 | 1 | untested |
| B4 | Paste from context menu, long-press menu, keyboard clipboard | 1 | 1 | 1 | untested |
| B5 | Middle-click paste (Linux) | – | – | – | untested |
| B6 | Drag text in, out and within a card; drop files and links | 1 | 1 | 3 | untested |
| C1 | Multi-code-point emoji are one character; caret offsets agree | 1 | 1 | 1 | untested |
| C2 | Precomposed and decomposed accents match in Find | 1 | 1 | 1 | untested |
| C3 | Locale-aware case folding in Find | unit | unit | unit | untested |
| C4 | Right-to-left and mixed text | 1 | 1 | 1 | untested |
| C5 | Typed zero-width characters survive | 1 | 1 | 1 | untested |
| C6 | Emoji render, not boxes or letters (Windows, Linux) | – | – | – | untested |
| C7 | Titles bold in CJK | 1 | 1 | 1 | untested |
| D1 | Word, line, document movement keys | 1 | 1 | 1 | untested |
| D2 | Emacs keys | 1 | 1 | – | untested |
| D3 | Word, line and forward delete | 1 | 1 | 1 | untested |
| D4 | Ctrl+Y redo (Windows) | – | – | – | untested |
| D5 | Every undo path shares one history | 1 | 1 | 3 | untested |
| D6 | Double/triple-click, long-press select | 1 | 1 | 1 | untested |
| D7 | Spacebar trackpad | – | – | 1, 3 | untested |
| D8 | Shortcuts on non-Latin layouts | 1 | 1 | 1 | untested |
| D9 | Shortcuts don't take browser ones | – | 1 | – | untested |
| D10 | Firefox type-ahead find vs board keys | – | 1 | – | untested |
| D11 | Soft keyboards' `Unidentified` keys | – | – | 1 | untested |
| D12 | Hardware keyboard on a phone | – | – | 1 | untested |
| D13 | Tab | 1 | 1 | 1 | untested |
| E1 | Trackpad pinch | 3 | 1 | 1 | untested |
| E2 | ⇧-wheel pans sideways; line-unit wheels | 1 | 1 | – | untested |
| E3 | Middle-drag autoscroll (Windows) | – | – | – | untested |
| E4 | Pen and stylus | – | – | 1 | untested |
| E5 | Touch, mouse and keyboard mixed (Windows, Linux) | – | – | – | untested |
| E6 | Context menu | 1 | 1 | 1 | untested |
| E7 | Back gesture, overscroll, pull-to-refresh | – | – | 1 | untested |
| E8 | No double-tap zoom, magnifier or callout on the board | – | – | 1 | untested |
| F1 | Edit survives focus leaving briefly | 1 | 1 | 1 | green on firefox-mac |
| F2 | Keyboard changes, rotation, split screen | – | – | 1 | untested |
| F3 | Text survives the app being killed mid-edit | 1 | 1 | 1 | untested |
| F4 | Sleep, wake and network changes mid-edit | 3 | 1, 3 | 1 | untested |
| G1 | Grammarly and LanguageTool | 3 | 1, 3 | – | untested |
| G2 | Page translation | – | 1 | 1 | untested |
| G3 | Storage persists | – | 1 | 1 | untested |
| G4 | Browser zoom and OS text size | – | 1 | 1 | untested |
| G5 | Fractional scaling, screens of other scaling | 3 | 1 | – | untested |
| G6 | Dark mode, contrast, reduced motion | 1 | 1 | 1 | untested |
| G7 | Screen readers, Voice Control, Full Keyboard Access | 1 | 1 | 1, 3 | untested |

## Running

```bash
node --test scenarios/platform/*.test.ts                 # rows' checks and every trace's replay, on every push
node --test scenarios/platform/native.e2e.ts             # each row through the platform's own input; takes over this Mac
RECORD=1 node --test scenarios/platform/native.e2e.ts    # the same, keeping each trace in scenarios/traces/
```

Native runs need Accessibility permission for the terminal, and Japanese added once under System Settings → Keyboard → Input Sources.
