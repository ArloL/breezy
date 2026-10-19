# Breezy platform input — design

An emoji can't be typed into a card in Firefox on the Mac, and nothing noticed: the scenarios type through Playwright and DevTools, which skip each platform's own text input. Pickers, input methods, dictation, autocorrect and system panels reach the app as events the code doesn't expect, or take focus for a moment. This design lists what people assume works on each platform, tests each against the platform's real input, keeps what each platform sends as a trace that replays on every push, and fixes what fails.

For now it covers three targets: the Mac app (`mac`), stock Firefox on macOS (`firefox-mac`), and Chrome on the Android emulator (`android`). Windows (UTM and `windows-latest`), Linux (UTM and `ubuntu-latest`) and iOS (the simulator, `scripts/sim-touch.py`, `scripts/wda.py`) come later; rows only they have are listed, with no layer yet.

## Layers

| Layer | What | When |
|---|---|---|
| 1 Native | The platform's own input, automated: OS key events, input sources, the Character Viewer on macOS; a test input method on Android | nightly, and on demand; it takes over the Mac for its run |
| 2 Replay | Each trace that layers 1 and 3 recorded, replayed into the app, checked against its row's expectation | every push |
| 3 Manual | A guided page on a phone, or a Debug menu in the Mac app, for what no automation reaches; records a trace | when a row or platform changes |

A trace records what the platform did, and a row states what should come of it. Replay checks the row, not the recorded outcome, so a trace recorded while a bug happens stays red until the fix. A bug can also change what the platform sends next, as an edit that ended takes no more input: once fixed, the row's trace is recorded again natively, and that trace keeps the fix from regressing.

## Drivers

| Target | Native input | State read through |
|---|---|---|
| `mac` | `tools/oskeys` with the board window frontmost | `-BreezyControl`, plus `record` and `replay` commands |
| `firefox-mac` | `tools/oskeys` into stock release Firefox, headed, fresh profile | Playwright over WebDriver BiDi (`channel: "moz-firefox"`), which drives the installed Firefox |
| `android` | `tools/breezy-ime`; real Gboard, tapped by key position, for its emoji tab and a few smoke rows | CDP, as `BrowserDevice` does |

`tools/oskeys` is a SwiftPM command-line tool:

| Command | Does |
|---|---|
| `key <code> [mods]`, `text <s>` | posts `CGEvent`s, so text goes through the frontmost app's `NSTextInputClient` |
| `source <id>` | enables and selects an input source with TIS: ABC, ABC Extended, German, Russian, Hebrew, Kotoeri Hiragana, Pinyin, Korean 2-Set |
| `emoji <name>` | ⌃⌘Space, then through Accessibility types `name` into the Character Viewer's search and picks the first result |
| `hold <key> <n>` | holds a key for the accent popup, picks with digit `n` |
| `menu <path>`, `context <x> <y> <item>` | picks from the menu bar or a context menu through Accessibility |
| `scroll <dx> <dy> [line] [mods]`, `drag` | mouse and wheel events |
| `away <panel>` | takes focus briefly: ⌘Tab and back, a notification, the screenshot tool |

It needs Accessibility permission for the terminal running it.

`tools/breezy-ime` is an Android input method built in the repo. It takes a script over `adb shell am broadcast` and makes the InputConnection calls a keyboard makes: `setComposingText`, `commitText`, `finishComposingText`, `setComposingRegion`, `deleteSurroundingText`, `setSelection`, `sendKeyEvent`, `performEditorAction`, `commitContent`. It also sets the clipboard. Scripts come from rows, and from phone traces converted back into these calls.

## Traces

`scenarios/traces/<target>/<row>-<variant>.json`:

```json
{ "row": "A2", "target": "firefox-mac", "source": "native", "ua": "…", "keyboard": "Kotoeri Hiragana",
  "before": { "text": "Plan", "at": 4, "kind": "front" },
  "steps": [
    { "t": 0, "type": "keydown", "key": "Process", "code": "KeyK", "isComposing": false },
    { "t": 3, "type": "compositionupdate", "data": "k" },
    { "t": 3, "type": "beforeinput", "inputType": "insertCompositionText", "data": "k", "range": [4, 4] },
    { "t": 90, "type": "blur" }
  ],
  "after": { "text": "Plan日本", "at": 6, "editing": true } }
```

Web steps are DOM events: key, `beforeinput` and `input` with type, data and target range, composition, focus, blur and selection. `web/record.ts` records them; it loads only with `?record` or `?check`. The Mac app's steps are the text input calls AppKit makes on `EditorTextView`, e.g. `{ "call": "setMarkedText", "text": "にほん", "selected": [3, 0], "replacement": null }`, plus `keyDown`, `doCommandBySelector`, and the window's key status; `Breezy/Support/Record.swift`, Debug only, records and replays them.

| Replays into | How |
|---|---|
| Chromium, Firefox, WebKit | each recorded event dispatched as recorded, each input's edit made to the DOM just before its input event; `document.hasFocus()` as the platform reported it around focus changes |
| Android | CDP's trusted `Input.imeSetComposition`, `Input.insertText`, `Input.dispatchKeyEvent` |
| `mac` | the same calls on `EditorTextView` through `-BreezyControl` |
| `android`, from a phone | the trace converted to a `breezy-ime` script |

## Rows

`scenarios/platform/rows.ts` has one entry per row: `id`, `targets`, `native(device)` for layer 1, and `expect(before, after)`, the outcome stated for the row (for A1: the text gained the emoji at the caret, the card is still being edited, the title's weight is unchanged). `docs/platform-expectations.md` is the readable catalogue with each row's status. Tests are named by row; a failing row is marked `todo` until its fix lands, so CI stays green while the catalogue shows what is open.

Layers per target; 2 replays every row that has a 1 or a 3 for that target. `–` means the row does not apply there; a row naming other platforms waits for them.

| Row | Expectation | mac | firefox-mac | android |
|---|---|---|---|---|
| A1 | Emoji picker inserts at the caret | 1 | 1 | 1, 3 |
| A2 | Input method: Enter confirms, Esc cancels, edit goes on | 1 | 1 | 1 |
| A3 | Korean commits a syllable on any key or click | 1 | 1 | 1 |
| A4 | Dead keys and ⌥ accents | 1 | 1 | – |
| A5 | Press-and-hold accent popup | 1 | 1 | – |
| A6 | AltGr and ⌥ characters on other layouts | 1 | 1 | – |
| A7 | Autocorrect, suggestions, undoing a correction | 1 | – | 1, 3 |
| A8 | Text replacements, smart quotes and dashes | 1 | 1 | – |
| A9 | Dictation | 3 | 3 | 3 |
| A10 | Swipe typing | – | – | 1, 3 |
| A11 | Handwriting | – | – | 3 |
| A12 | Spell-check suggestion replaces the word | 1 | 1 | 1 |
| A13 | Writing Tools, Proofread | 3 | 3 | 3 |
| A14 | Inline suggestions, Win+V (Windows) | – | – | – |
| A15 | Input methods on Wayland (Linux) | – | – | – |
| B1 | Rich paste arrives as plain text | 1 | 1 | 1 |
| B2 | Pasted CRLF leaves no stray carriage returns | 1 | 1 | 1 |
| B3 | Pasting or inserting an image or file does no harm | 1 | 1 | 1 |
| B4 | Paste from context menu, long-press menu, keyboard clipboard | 1 | 1 | 1 |
| B5 | Middle-click paste (Linux) | – | – | – |
| B6 | Drag text in, out and within a card; drop files and links | 1 | 1 | 3 |
| C1 | Multi-code-point emoji are one character; caret offsets agree | 1 | 1 | 1 |
| C2 | Precomposed and decomposed accents match in Find | 1 | 1 | 1 |
| C3 | Locale-aware case folding in Find | unit | unit | unit |
| C4 | Right-to-left and mixed text | 1 | 1 | 1 |
| C5 | Typed zero-width characters survive | 1 | 1 | 1 |
| C6 | Emoji render, not boxes or letters (Windows, Linux) | – | – | – |
| C7 | Titles bold in CJK | 1 | 1 | 1 |
| D1 | Word, line, document movement keys | 1 | 1 | 1 |
| D2 | Emacs keys | 1 | 1 | – |
| D3 | Word, line and forward delete | 1 | 1 | 1 |
| D4 | Ctrl+Y redo (Windows) | – | – | – |
| D5 | Every undo path shares one history | 1 | 1 | 3 |
| D6 | Double/triple-click, long-press select | 1 | 1 | 1 |
| D7 | Spacebar trackpad | – | – | 1, 3 |
| D8 | Shortcuts on non-Latin layouts | 1 | 1 | 1 |
| D9 | Shortcuts don't take browser ones | – | 1 | – |
| D10 | Firefox type-ahead find vs board keys | – | 1 | – |
| D11 | Soft keyboards' `Unidentified` keys | – | – | 1 |
| D12 | Hardware keyboard on a phone | – | – | 1 |
| D13 | Tab | 1 | 1 | 1 |
| E1 | Trackpad pinch | 3 | 1 | 1 |
| E2 | ⇧-wheel pans sideways; line-unit wheels | 1 | 1 | – |
| E3 | Middle-drag autoscroll (Windows) | – | – | – |
| E4 | Pen and stylus | – | – | 1 |
| E5 | Touch, mouse and keyboard mixed (Windows, Linux) | – | – | – |
| E6 | Context menu | 1 | 1 | 1 |
| E7 | Back gesture, overscroll, pull-to-refresh | – | – | 1 |
| E8 | No double-tap zoom, magnifier or callout on the board | – | – | 1 |
| F1 | Edit survives focus leaving briefly | 1 | 1 | 1 |
| F2 | Keyboard changes, rotation, split screen | – | – | 1 |
| F3 | Text survives the app being killed mid-edit | 1 | 1 | 1 |
| F4 | Sleep, wake and network changes mid-edit | 3 | 1, 3 | 1 |
| G1 | Grammarly and LanguageTool | 3 | 1, 3 | – |
| G2 | Page translation | – | 1 | 1 |
| G3 | Storage persists | – | 1 | 1 |
| G4 | Browser zoom and OS text size | – | 1 | 1 |
| G5 | Fractional scaling, screens of other scaling | 3 | 1 | – |
| G6 | Dark mode, contrast, reduced motion | 1 | 1 | 1 |
| G7 | Screen readers, Voice Control, Full Keyboard Access | 1 | 1 | 1, 3 |

Rows E, F2, F3 and G on Android use `scenarios/cases.ts`' devices and gestures rather than traces. G7 uses Guidepup for VoiceOver and `adb` for TalkBack. C3 needs no platform input and is a unit test on both cores.

## Files

| Path | What |
|---|---|
| `docs/platform-expectations.md` | the catalogue |
| `scenarios/platform/rows.ts` | rows |
| `scenarios/platform/native.e2e.ts` | layer 1 |
| `scenarios/platform/replay.test.ts` | layer 2 |
| `scenarios/traces/` | traces |
| `tools/oskeys/` | macOS input driver |
| `tools/breezy-ime/` | Android test input method |
| `web/record.ts`, `web/check.ts` | recorder; guided manual page |
| `Breezy/Support/Record.swift` | the Mac app's recorder and replayer, Debug only |

A native run retries once, as `SCENARIO_RUNS` does. On failure it keeps a screenshot and the trace it recorded in `build/platform/`, so every native failure leaves a replayable fixture.

## Order

1. Spikes, thrown away after:
   1. With `oskeys` and the Character Viewer, does the emoji bug happen in stock Firefox, and why? If not there, in Playwright's Firefox?
   2. Do `CGEvent` posting and Accessibility work from this terminal, and on GitHub's macOS runners?
   3. Does Chrome on the emulator take a test input method's calls as it takes Gboard's?
2. The catalogue, the trace format with `web/record.ts`, `rows.ts`, web replay.
3. `firefox-mac` natively: A1 first, whose trace is the first red replay; then the other `oskeys` rows.
4. `mac`: `Record.swift`, replay, the same rows natively.
5. `android`: `breezy-ime` and its rows, Gboard's emoji tab, the E and F rows.
6. Layer 3: `?check` and the Mac's Debug recorder; traces from the iPhone and the Android phone. iPhone traces wait as fixtures for iOS.
7. G rows.
8. Fixes, each with its red test first; they start as soon as a row is red.

Each step ends with its tests committed.

## Suspects already seen

| Row | Where |
|---|---|
| A1, F1 | `web/field.ts` ends the edit on any blur; `composeInTitle` changes the DOM as a composition starts |
| A2 | Esc ends the edit with no `isComposing` check (`web/keys.ts`); Enter in a lane's title (`web/field.ts`) and in Find (`web/ui.ts`) likewise; `EditorTextView.keyDown` takes Esc and Tab before the input method |
| C5 | `DomField.text` drops every U+200B |
| D4 | no Ctrl+Y |
| D8 | `keys.ts` matches `e.key`, which a Cyrillic layout makes non-Latin |
| G2 | no `translate="no"` on cards |
| G3 | no `navigator.storage.persist()` |

## Spike results

| Spike | Result | Consequence |
|---|---|---|
| 1 Firefox emoji | The picker, ⌃⌘Space or Globe, takes the window's focus: the editor gets `focusout` with `document.hasFocus()` false, then `window blur`, and `DomField`'s `onblur` ends the edit, so the picked emoji has nowhere to go. Playwright hides it: it starts Firefox with `focusmanager.testmode` on, under which Firefox keeps its window focused, and the emoji went in every way tried | A1 and F1 have one cause, and F1's fix is A1's. Native runs start Firefox with `focusmanager.testmode` off; every Playwright-started Firefox in `scenarios/` has it on and cannot see focus bugs |
| oskeys | An app that is frontmost as the input source changes keeps the old source until it comes to the front again, about two times in three; selecting the source and then ⌘Tab and back holds every time. The picker inserts its first result only after ↓; live conversion may mark 日本 for `nihonn` | A row names its input source; the harness selects it and switches away and back before the edit opens, so the switch is not a focus change inside the row |
| 2 macOS runners | GitHub's `macos-latest`, after `automationmodetool enable-automationmode-without-authentication`, trusts the terminal for Accessibility. `oskeys` passed 5 of 6 against its echo app; the echo app's emoji pick timed out at 10 s, as the picker's first launch on a fresh runner is slow (A1 took 20 s). The native rows passed 5 of 5 in stock Firefox installed with `brew install --cask firefox` | The native layer can run nightly in CI; give the emoji pick a longer first wait there |
| 3 Test input method | Chrome 145 on the emulator takes a test input method's calls as it takes a keyboard's, once a real touch on the editor has shown the keyboard: `setComposingText` gives `compositionstart`, then `compositionupdate` and `insertCompositionText` with `isComposing` for each step; `commitText` ends the composition or, with none, gives `insertText`, emoji too; `sendKeyEvent` Enter gives a real Enter and `insertLineBreak`. Every other key arrives as `keydown` `Unidentified`, keyCode 229. Before a real touch, as after DevTools focus alone, its text arrives as keyCode 229 only and inserts nothing | `breezy-ime` drives the Android rows; each row opens its editor with a real touch through the emulator's touchscreen |
