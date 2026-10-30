# Breezy copy and paste of cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Copy, cut and paste of cards in the web app (keys and phone buttons) and the Mac app, each pasting what the other copied.

**Architecture:** The placement rule and the clipboard's format are part of each core: `web/rules.ts` + `web/clip.ts`, mirrored in BreezyKit's `Clip.swift`, held together by unit tests on a shared fixture and by the parity steps. Each app's glue is thin: the document's `copy`/`cut`/`paste` events and `navigator.clipboard` on the web, `copy:`/`cut:`/`paste:` and `NSPasteboard` on the Mac. The cards travel as HTML both sides read, plus plain text.

**Tech Stack:** TypeScript (node:test), Swift (Swift Testing), AppKit, Playwright scenarios.

**Spec:** `docs/superpowers/specs/2026-10-30-breezy-copy-paste-design.md`

## Global Constraints

- Small PRs off main, each green on every job before merging (CLAUDE.md). PRs: A = Tasks 1–3, B = Task 4, C = Task 5, D = Task 6.
- The spike branch `spike/copy-paste` is throwaway: nothing is merged from it. Delete it once PR A is open.
- A copy carries front, back and colour, with a fresh id. Lanes are never copied. Cut deletes the selected cards, not lanes.
- Cut and Paste are one undo step each, named "Cut" and "Paste"; Copy changes nothing on the board.
- Placement: a copy of a card in a lane on its board goes right below the original; after a cut, back where it stood in that lane; every other copy on its board goes with its block to the clear space nearest where the originals stood (`openSpot`); on another board, to the clear space nearest the view's centre. After a paste the copies are selected and revealed.
- Plain text: the fronts in reading order (by y, then x), joined by a blank line.
- While editing a card or lane title, or in the find field, the keys copy and paste text as now.
- Every wait bounded; test files exit on their own (CLAUDE.md).

## Review Focus

1. ⌘C with text selected in the find field or a card's editor copies the text, not the cards (Task 4's e2e test).
2. A clip whose lane original has since been moved to another lane, or deleted without a cut, pastes by the remaining rules without throwing (Task 2).
3. HTML from another site carrying `data-breezy` with wrong types, an unknown version or a colour of 9 pastes nothing or clamps, never throws (Task 2's codec test).
4. Pasting 200 cards is one undo step, and undo removes every copy (Task 3).
5. Copy with only lanes selected leaves the clipboard as it was (Task 3, Task 4).

---

### Task 1: Settle the clipboard carrier

No code is kept from this task; its result goes into the spec.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-30-breezy-copy-paste-design.md` ("Clipboard between the apps")

- [ ] **Step 1: Build a scratch page** (in the scratchpad, served by `npx http-server` or `python3 -m http.server`) whose `paste` listener prints `e.clipboardData.types` and `getData("text/html")`, and whose button writes candidate HTML on `copy`.
- [ ] **Step 2: Measure each candidate** — (a) `<div data-breezy="JSON">text</div>`, (b) `<!--breezy:JSON-->` before the text, (c) `<meta name="breezy" content="JSON">` — through each path: Chrome, Safari and Firefox pasting from themselves, from each other, and from the Mac (write `public.html` with a 10-line Swift script via `NSPasteboard.general.setString(_:forType: .html)`). On iOS Simulator Safari, paste from a page of another origin.
- [ ] **Step 3: Record** the table of candidate × path → kept/dropped in the spec, and name the carrier: the first candidate kept on every path. If none is, name per browser the one it keeps and which paths stay unsupported, as the spec's fallback allows. Later tasks call it `CARRIER`; Task 2 implements it.

### Task 2: The clip, its codec and placement, on both cores

**Files:**
- Modify: `web/types.ts`, `web/rules.ts`, `web/test/rules.test.ts`
- Create: `web/clip.ts`, `web/test/clip.test.ts`, `web/test/clip-fixture.html`
- Create: `BreezyKit/Sources/BreezyKit/Clip.swift`, `BreezyKit/Tests/BreezyKitTests/ClipTests.swift`

**Interfaces:**
- Produces (web):
  - `interface ClipCard { id: string; x: number; y: number; w: number; h: number; text: string; color: number; notes?: string }` and `interface Clip { v: 1; board: string; cards: ClipCard[] }` in `web/types.ts`
  - `R.clip(b: Board, board: string, ids: ReadonlySet<string>, heightOf: HeightOf): Clip | null` — the selected cards in reading order; null when none are cards
  - `R.paste(b: Board, clip: Clip, here: { board: string; centre: Point }, heightOf: HeightOf): string[]` — the copies' ids, in clip order
  - `clipText(c: Clip): string`, `clipHTML(c: Clip): string`, `readClip(html: string): Clip | null` in `web/clip.ts`
- Produces (Swift): `public struct ClipCard: Codable, Equatable`, `public struct Clip: Codable, Equatable` with the same fields; `Board.clip(board:ids:heightOf:) -> Clip?`; `mutating Board.paste(_:board:centre:heightOf:) -> [String]`; `Clip.text`, `Clip.html`, `Clip(html:)` (failable).

- [ ] **Step 1: Write the failing web tests** in `web/test/rules.test.ts`, on the file's `board`/`card`/`lane`/`h48` helpers:
  - `clip takes the selected cards in reading order and leaves lanes out` — cards b (0,96), a (0,0), lane l selected → `cards.map(c => c.id)` is `["a", "b"]`, each with `h: 48`; only `l` selected → `null`.
  - `a copy of a card in a lane pastes right below it, the cards below making room` — `stackBoard()`, clip of `a` from board `"B"`, paste on `"B"` → `ys(b, "a", copy, "b")` is `[72, 144, 216]`, copy's x 24.
  - `pasting a lane card twice stacks both copies below it` — the two copies sit at 144 and 216, `b` at 288.
  - `after a cut a lane card pastes back where it stood` — clip `b` from `stackBoard()` with a third card c at (24, 216), remove `b`, gravity, paste → copy at y 144, c at 216.
  - `free cards paste as a block to the nearest clear space` — cards a (600,0) and b (912,0), clip both, paste on its board → the copies are 312 apart in x, as the originals are, neither intersects any original, both a grid clear.
  - `on another board the block pastes nearest the view's centre` — empty board, `here.centre` (1000, 1000), clip of one card → copy's centre within a grid of (1000, 1000).
  - `a lane original moved to another lane or deleted pastes without throwing` — original moved out of its lane: copy goes below it in the new lane; original deleted and its old spot now outside every lane: copy lands in clear space.
- [ ] **Step 2: Run** `node --test web/test/rules.test.ts` — Expected: FAIL, `R.clip is not a function`.
- [ ] **Step 3: Implement `R.clip` and `R.paste` in `web/rules.ts`.** Paste's order matters:

```
same = clip.board === here.board
for each card k of clip:
  o = same && card(b, k.id)
  if o in a lane:                       push copy at (o.x, o.y + 1)         // centre just after o's: settle orders it next
  else if same && !o && centre of k's stored rect is in a lane L:
    n = first card of L's column whose y >= k.y
    push copy at (k.x, n ? n.y + heightOf(n.id)/2 - k.h/2 - 1 : k.y)       // centre just before n's
  else: add k to free
free block: its bounding box; anchor = same ? its top-left : centre - half its size
s = openSpot(b, w, h, anchor, heightOf); push each free card offset by s - top-left
gravity(b, heightOf)
```

- [ ] **Step 4: Run** `node --test web/test/rules.test.ts` — Expected: PASS.
- [ ] **Step 5: Write the failing codec tests** in `web/test/clip.test.ts`:
  - `clipText joins fronts with a blank line` — fronts "Pizza\nfor Al", "Soup" → `"Pizza\nfor Al\n\nSoup"`.
  - `readClip reads the fixture` — `readClip(fs.readFileSync("web/test/clip-fixture.html", "utf8"))` deep-equals the clip it holds (write the fixture by hand in `CARRIER`'s form: board "B", one card with notes, one without, text with `"`, `<`, `&` and an emoji).
  - `readClip(clipHTML(c))` deep-equals `c`.
  - `readClip rejects what is not a clip` — plain HTML, `v: 2`, cards not an array, a card without a string `text` → `null`; colour 9 → 5, colour 0 → 1; `w` ≤ 0 → 240.
- [ ] **Step 6: Run** `node --test web/test/clip.test.ts` — Expected: FAIL, module not found. **Implement** `web/clip.ts` in `CARRIER`'s form: the plain text HTML-escaped as the visible part, the JSON (keys as in `Clip`) entity-escaped in the carrier. **Run** again — Expected: PASS.
- [ ] **Step 7: Mirror both test files** in `ClipTests.swift`, same names in Swift's style (`@Test func aCopyOfACardInALanePastesRightBelowIt()`…), the same boards and values; the fixture read through `URL(fileURLWithPath: #filePath)` up to the repo root, then `web/test/clip-fixture.html`.
- [ ] **Step 8: Run** `swift test --package-path BreezyKit --filter ClipTests` — Expected: FAIL. **Implement** `Clip.swift` (placement in an `extension Board`, beside `openSpot`'s use in `Edits.swift`). **Run** — Expected: PASS.
- [ ] **Step 9: Commit** — `git commit -m "Add a clip of cards to both cores: its placement on paste and its HTML, which each reads from the other"`

### Task 3: Copy, cut and paste in both cores, held together by the parity steps

**Files:**
- Modify: `web/app.ts`, `BreezyKit/Sources/BreezyKit/CanvasCore.swift`, `scripts/fuzz/web-device.ts`, `BreezyKit/Sources/BreezySim/SimDevice.swift`, `scenarios/parity/steps.ts`, `scenarios/cases.ts`, `web/test/` (the App's tests — use the file that tests `removeSelection`), `BreezyKit/Tests/BreezyKitTests/CanvasCoreTests.swift`

**Interfaces:**
- Consumes: Task 2's `R.clip`, `R.paste`, `Board.clip`, `Board.paste`.
- Produces:
  - web `App.copySelection(): Clip | null`, `App.cutSelection(): Clip | null`, `App.paste(clip: Clip, centre?: Point): void` — board id from `this.library?.id ?? ""`; `centre` defaults to the view's centre in world points.
  - Swift `CanvasCore.copySelection(board: String) -> Clip?`, `cutSelection(board: String) -> Clip?`, `paste(_ clip: Clip, board: String, centre: Point)`.
  - Both note `transition` `"copy"` / `"cut"` / `"paste"` with `{ ids: n }`; paste ends any edit, puts back a turned card, selects the copies and, on the web, reveals their bounding rect with `view.reveal(r, "top", 48)`.

- [ ] **Step 1: Write the failing tests**, on each side: `cut is one undo step and leaves lanes`; `paste of 200 cards is one undo step that undo takes back whole`; `copy with only lanes selected returns null`; `paste during a drag does nothing` (pass `model.inGesture`).
- [ ] **Step 2: Run** `node --test web/test/<file>.test.ts` and `swift test --package-path BreezyKit --filter CanvasCoreTests` — Expected: FAIL.
- [ ] **Step 3: Implement** both cores' three methods; cut is `begin`/`remove`/`gravity`/`end("Cut")` as `deleteSelection` is.
- [ ] **Step 4: Run** both — Expected: PASS.
- [ ] **Step 5: Teach the sim devices ⌘C, ⌘X, ⌘V**: each device keeps its own last clip; `key` with `meta` and `c`/`x`/`v` calls the core's method, pasting with `centre` the board's centre. In `steps.ts` add a weighted step `clip: 1` drawing `{ do: "key", key: r.pick(["c", "x", "v"]), meta: true }`.
- [ ] **Step 6: Add the hub case** to `scenarios/cases.ts`: `"a card in a lane copied and pasted shows right below it on the other device"`, input mouse, on `laneAndCard`: drag the card into the lane, click it, ⌘C, ⌘V, settle; the second device shows two cards of the same text in the column at y 72 and 144 within the lane.
- [ ] **Step 7: Run** `node --test scenarios/parity.test.ts scenarios/cases.test.ts scenarios/conformance.test.ts` — Expected: PASS.
- [ ] **Step 8: Commit**, then open PR A (Tasks 1–3).

### Task 4: Keys in the web app

**Files:**
- Modify: `web/main.ts`, `README.md`, `scenarios/browsers.e2e.ts`

**Interfaces:**
- Consumes: Task 3's `App` methods, Task 2's `clipHTML`, `clipText`, `readClip`.

- [ ] **Step 1: Write the failing e2e test** in `scenarios/browsers.e2e.ts`, in Chromium, WebKit and Firefox on localhost: select a card, ⌘C (Ctrl+C off the Mac), ⌘V → two cards; type into the find field, select its text, ⌘C, then read the clipboard in the page → the field's text, not a card's; select only a lane, ⌘C → the clipboard is unchanged.
- [ ] **Step 2: Run** `npx playwright test scenarios/browsers.e2e.ts -g copy` — Expected: FAIL.
- [ ] **Step 3: Implement** document listeners for `copy`, `cut` and `paste` in `web/main.ts`, acting only when the board has the keyboard (no edit, no rename, target not an `input`/`textarea`, not the boards screen): set `text/plain` and `text/html`, `preventDefault`; paste reads `text/html` through `readClip` and does nothing for anything else. Add `| Copy | ⌘C, ⌘X and ⌘V copy, cut and paste cards; a copy goes below its original in a lane, else in the nearest clear space |` after README's Delete row.
- [ ] **Step 4: Run** the e2e test — Expected: PASS. Run `npm test` — Expected: PASS.
- [ ] **Step 5: Commit**, open PR B.

### Task 5: The Mac app

**Files:**
- Create: `Breezy/Canvas/CanvasView+Clipboard.swift`
- Modify: `scenarios/mac.ts` (`codes`: `c` 8, `x` 7, `v` 9), `scenarios/browsers.e2e.ts`

**Interfaces:**
- Consumes: Task 3's `CanvasCore` methods; Task 2's `Clip.html`, `Clip.text`, `Clip(html:)`; the board id from `BoardWindowController.boardID`.

- [ ] **Step 1: Write the failing e2e test** `"a card copied in the Mac app pastes in each browser, and back"`: the Mac copies a card with ⌘C; Chromium, WebKit and Firefox each paste it with ⌘V onto a board of their own → a card of the same front, back and colour; then the reverse.
- [ ] **Step 2: Run** it — Expected: FAIL, no menu action.
- [ ] **Step 3: Implement** `copy(_:)`, `cut(_:)`, `paste(_:)` on `CanvasView`: write `.html` and `.string` to `NSPasteboard.general` after `clearContents()`; read `.html`; centre is `visibleWorldCentre`; after paste, `scrollToVisible` the copies' union inset by -48, as `reveal(_:back:)` does. `validateMenuItem` enables Copy and Cut when the selection has a card, Paste when the pasteboard has `.html`.
- [ ] **Step 4: Run** the e2e test and `xcodebuild -project Breezy.xcodeproj -scheme Breezy -derivedDataPath build test` — Expected: PASS.
- [ ] **Step 5: Commit**, open PR C.

### Task 6: Phones

**Files:**
- Modify: `web/index.html`, `web/ui.ts`, `web/style.css`, `scenarios/cases.ts`

**Interfaces:**
- Consumes: Task 3's `App` methods; Task 2's codec.
- Produces: `data-act="copy"` in `.selection`, after Turn over; `data-act="paste"` in the + menu after Lane.

- [ ] **Step 1: Write the failing case** `"a card copied and pasted with the selection bar on a phone shows right below it on the other device"`, input touch, as Task 3's case with taps on Copy, +, Paste; on the iPhone it taps iOS's Paste callout by where it is, as the scenarios tap the share sheet.
- [ ] **Step 2: Run** `node --test scenarios/cases.test.ts` — Expected: FAIL, no Copy button.
- [ ] **Step 3: Implement**: Copy writes `new ClipboardItem({ "text/html": …, "text/plain": … })` with `navigator.clipboard.write`, from the tap; it shows while the selection has a card. Paste reads `navigator.clipboard.read()`; a refused read, or one with no clip, pastes the clip this page last copied, or does nothing. On the hub, where no browser clipboard exists, the read is refused and the case passes by the page's own clip; if the hub's fakes have no selection bar to tap, flag the case as the cases flag what fakes cannot do (`Case` in `scenarios/cases.ts`).
- [ ] **Step 4: Run** the case — Expected: PASS. Try the branch on devices: `gh workflow run nightly.yaml --ref <branch> --field only=ios`, then `only=android` — Expected: the new case green.
- [ ] **Step 5: Commit**, open PR D.
