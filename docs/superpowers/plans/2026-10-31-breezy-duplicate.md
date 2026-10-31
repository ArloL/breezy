# Breezy Duplicate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Duplicate button in the web app's selection bar replaces Copy, and Paste leaves the + menu, with the phone clipboard code removed.

**Architecture:** `App.duplicateSelection()` clips the selected cards and pastes them on the same board through the existing rules (`R.clip`, `R.paste`), sharing `App.paste`'s placement, selection and reveal. The bar's button calls it. `Taps` (phone clipboard by buttons) and the scenario devices' `tapToPaste` go. ⌘C/⌘X/⌘V in `web/main.ts` and the Mac app stay untouched.

**Tech Stack:** TypeScript run directly by Node 24 (`node --test`), Playwright scenarios.

**Spec:** `docs/superpowers/specs/2026-10-31-breezy-duplicate-design.md`

## Global Constraints

- Undo step name: `"Duplicate"`. Flight note: `transition` `"duplicate"` with `{ ids: <copies> }`, as copy and paste note theirs.
- Duplicate reads and writes no clipboard.
- The button: `data-act="duplicate"`, `aria-label="Duplicate"`, where `data-act="copy"` stands, hidden unless the selection has a card.
- `web/main.ts`'s copy/cut/paste handlers, `App.copySelection`, `App.cutSelection`, `App.paste` and the Mac app keep working as they do.

## Review Focus

1. Duplicate twice in a lane: the second copy goes under the first, the column reading original, copy, copy. Test in Task 1.
2. Duplicate while a card is being edited: the edit ends, its text kept, then the copy is made. Test in Task 1.
3. Duplicate of a turned card: it turns back and the copy is revealed. Test in Task 1.
4. A selection of cards and a lane: cards copied, the lane not. Test in Task 1.
5. Duplicate during a drag: nothing happens. Test in Task 1.

---

### Task 1: `App.duplicateSelection`

**Files:**
- Modify: `web/app.ts` (beside `copySelection` and `paste`, ~lines 366–405)
- Test: `web/test/flight-app.test.ts` (after the paste tests, ~line 222, using its `board(n)` helper and `of(app, kind)`)

**Interfaces:**
- Produces: `App.duplicateSelection(): string[]`, the copies' ids, empty when nothing was duplicated.

- [ ] **Step 1: Write the failing tests** in `web/test/flight-app.test.ts`, each on a board with a lane `l` at 0,0 and its cards stacked in it where the test needs a lane (put `c0` at `x: 24, y: 72` inside `l`, w 360 h 200, or build the board inline):

  - `"duplicate puts a lane card's copy right below it, selected, as one undo step named Duplicate"`: select `c0` in the lane; `duplicateSelection()` returns one id ≠ `c0`; `app.state.selection` is exactly that id; the copy's `y` > `c0`'s `y` and its `x` equals `c0`'s; `app.model.undos.at(-1).name === "Duplicate"` and undos grew by one; the flight's transitions end with `["duplicate", { ids: 1 }]`; one `model.undo()` leaves 1 card.
  - `"duplicate twice stacks the second copy under the first"`: select `c0` in a lane, duplicate, duplicate again (the selection is now the first copy); the three cards' `y`s ordered original < first < second.
  - `"duplicate leaves a selection's lanes and copies its cards"`: `board(2)`, select `c0`, `c1`, `l`; returns 2 ids; lanes still 1, cards 4.
  - `"duplicate with only lanes selected does nothing"`: select `l`; returns `[]`; no transitions noted; undos unchanged.
  - `"duplicate during a drag does nothing"`: select `c0`, `model.begin()`; returns `[]`; cards still 1.
  - `"duplicate during an edit ends it and copies the card with its new text"`: select `c0`, `beginEdit("c0")`, change its text through the same path the existing edit tests use (see `web/test/flight-app.test.ts` / `fakes.ts` `FakeField`), `duplicateSelection()`; `state.editing === null`; two cards carry the new text.
  - `"duplicate turns a turned card back"`: select `c0`, `turn("c0")`, duplicate; `state.turned === null`.

- [ ] **Step 2: Run them to see them fail**

  Run: `node --test web/test/flight-app.test.ts`
  Expected: FAIL, `app.duplicateSelection is not a function`.

- [ ] **Step 3: Implement `duplicateSelection(): string[]` in `web/app.ts`**

  Extract `App.paste`'s body after its guards into `private place(name: string, clip: Clip, centre: Point): string[]` (perform with `name`, note `transition` with `name.toLowerCase()`, select, reveal, return ids); `paste` calls it with `"Paste"`. `duplicateSelection` ends editing, returns `[]` in a gesture, clips with `R.clip(board, this.library?.id ?? "", selection, heightOf)` (no `copy` note, no `copied`), returns `[]` without a clip, turns back, and calls `place("Duplicate", clip, view centre)`.

- [ ] **Step 4: Run the tests**

  Run: `node --test web/test/flight-app.test.ts`
  Expected: PASS; `npm run check && npm test` pass.

- [ ] **Step 5: Commit** `web/app.ts`, `web/test/flight-app.test.ts`.

### Task 2: Duplicate in the selection bar, Paste out of the + menu, `Taps` gone

**Files:**
- Modify: `web/index.html:115` (+ menu), `web/index.html:130` (Copy button)
- Modify: `web/ui.ts:8,47,51` (Taps import, field, construction), `:120` (paste), `:126` (copy), `:168` (hidden rule)
- Modify: `web/clip.ts:62-119` (delete `Copier` and `Taps`; drop the now-unused `Flight` import)
- Modify: `web/test/clip.test.ts:68-90` (delete the `ClipboardItem` shim and the Taps test; drop `Taps` from the import)
- Modify: `README.md:32`

**Interfaces:**
- Consumes: `App.duplicateSelection(): string[]` (Task 1).

- [ ] **Step 1:** In `index.html`, remove `<button data-act="paste">Paste</button>`; replace the Copy button with `<button data-act="duplicate" aria-label="Duplicate">` and an SVG in the bar's 24×24 stroke style: the Copy icon's two overlapping rounded rects with a plus in the front one (e.g. `M14.5 11.5v6M11.5 14.5h6`).
- [ ] **Step 2:** In `ui.ts`, `case "duplicate": return void (app.duplicateSelection().length && haptic());`, delete the `paste` and `copy` cases, `Taps`, and point the hidden rule at `[data-act="duplicate"]`.
- [ ] **Step 3:** Delete `Taps` and `Copier` from `clip.ts` and their test and shim from `clip.test.ts`; then `App.copied` (`web/app.ts` ~58) and its assignment in `copySelection` have no reader: remove them.
- [ ] **Step 4:** README row 32 becomes: `| Copy | ⌘C, ⌘X and ⌘V copy, cut and paste cards; a copy goes below its original in a lane, else in the nearest clear space; Duplicate in the selection bar does both in one tap, without the clipboard |`
- [ ] **Step 5: Verify**

  Run: `npm run check && npm test`
  Expected: no type errors; all tests pass.

  Then `npm run dev`, open localhost in Playwright's Chromium with a phone viewport and touch, select a card in a lane, tap Duplicate: a second card shows under it, selected; + menu reads Card, Lane. Screenshot for the PR.

- [ ] **Step 6: Commit** the files above.

### Task 3: The phone scenario case, by Duplicate

**Files:**
- Modify: `scenarios/cases.ts:753-783` (the selection-bar case)
- Modify: `scenarios/device.ts:155-159`, `scenarios/browser.ts:420-430,778-790`, `scenarios/ios.ts:148-158,624-640` (delete `tapToPaste`, `allow()`, `pasteCallout`, and `labelled` if nothing else uses it)
- Modify: `scenarios/prompts.ts` (delete `ALLOW`, `allowance`), `scenarios/prompts.test.ts:15-22` (its two tests), `scenarios/browser.ts:24` import

**Interfaces:**
- Consumes: `data-act="duplicate"` (Task 2).

- [ ] **Step 1:** Rename the case `"a card duplicated with the selection bar on a phone shows right below it on the other device"`; after the drag leaves the card selected, `await a.tapOn('[data-act="duplicate"]')`; drop the tap on nothing, `+`, `tapToPaste` and the clipboard flight check; keep the wait for two cards and the `[72, 144]` column on `b`.
- [ ] **Step 2:** Delete the clipboard-prompt helpers listed above.
- [ ] **Step 3: Verify**

  Run: `npm run check && npm test && node --test scenarios/prompts.test.ts scenarios/cases.test.ts`
  Expected: pass. Then run the case on the desktop pairs locally if the scenarios' browsers run here (`SCENARIO_PAIRS` and a name filter, as `scenarios/browsers.e2e.ts` reads them); on a phone it runs in the nightly (`only=android`, `only=ios`) on this branch, after asking the owner, and its timeline is read from `build/scenarios/*/timeline.txt`.
- [ ] **Step 4: Commit** the files above.
