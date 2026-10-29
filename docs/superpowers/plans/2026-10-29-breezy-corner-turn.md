# Breezy Corner Turn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every card has a 32 pt corner, a crease without notes and a fold with them, and a double tap or double-click on it turns the card, on the web and the Mac alike.

**Architecture:** The web app's hit test (`web/policy.ts`) gives every card a `fold` hit, sized per input and cut off for touch at low zoom; a single press on it acts as on the card, a double one turns it (`web/input.ts`). The Swift core (`CanvasCore`) does the same for the mouse, so the parity tests keep holding the two cores to the same transitions. Both apps draw the crease and the 32 pt fold.

**Tech Stack:** TypeScript (node --test, tsc), Swift (BreezyKit, swift-testing), AppKit/Core Graphics, CSS.

**Spec:** `docs/superpowers/specs/2026-10-29-breezy-corner-turn-design.md`

## Global Constraints

- Corner: 32 pt on every card, front or back, on both platforms.
- Pointer fold area: the corner's own 32 pt square, at any zoom.
- Finger fold area: inside the card, anchored bottom-right, side `64 * min(zoom, 1)` pt on screen; none below zoom `44 / 64` (0.6875).
- A single press or tap on the fold acts exactly as on the card; a double one turns the card (or turns it back).
- Space, Tab while editing and the selection bar's Turn over keep turning.
- The turn's animation is unchanged.

## Review Focus

1. Double-click on another card's corner while one is turned: the turned one goes back, then the other turns; both cores record the same transitions (Task 3's parity case).
2. Double tap on the corner of the card being edited ends the edit before turning, never leaves an editor on the wrong side (Task 1).
3. Double tap on the corner below the cut-off edits the card (Task 1).
4. A mouse drag from the corner moves the card, a shift-click there toggles it, as on the card (Task 1, policy test).
5. A finger drag from the corner of an unselected card pans (Task 1, existing `dragAction` test keeps `fold` → `pan`/`move` as `card`).

---

### Task 1: Web hit test and gestures

**Files:**
- Modify: `web/policy.ts` (`hitTest`, `pressAction`, `PressAction`)
- Modify: `web/input.ts` (`tap`, `doubleTap`, `doubleClick`)
- Modify: `web/mouse.ts` (`down`)
- Test: `web/test/policy.test.ts`, `web/test/mouse.test.ts`, `web/test/input.test.ts`

**Interfaces:**
- Produces: `export const FOLD = 32`, `export const FOLD_TOUCH = 64`, `export const FOLD_MIN_ZOOM = TOUCH / FOLD_TOUCH` in `web/policy.ts`; `PressAction` loses `turn`.

- [ ] **Step 1: Write the failing tests**

In `web/test/policy.test.ts` (its `rectOf` makes cards 240 × 48), replace "the folded corner takes a 44 pt touch area…", "a card without notes has no fold", "a pointer's fold is the card's own corner…" and "a press on a fold turns the card…" with:

```ts
test("every card's corner takes a 64 pt touch area inside the card", () => {
  const b = { cards: [card("a", 0, 0)], lanes: [] };
  assert.deepEqual(at(b, 180, 10), { kind: "fold", id: "a" });
  assert.deepEqual(at(b, 170, 40), { kind: "card", id: "a" });
  assert.deepEqual(at(b, 250, 50), { kind: "empty" });
});

test("zoomed in, the touch corner stays 64 pt on screen", () => {
  const b = { cards: [card("a", 0, 0)], lanes: [] };
  assert.deepEqual(at(b, 210, 20, 2), { kind: "fold", id: "a" });
  assert.deepEqual(at(b, 200, 20, 2), { kind: "card", id: "a" });
});

test("below 69 % the touch corner is the card's", () => {
  const b = { cards: [card("a", 0, 0)], lanes: [] };
  assert.deepEqual(at(b, 230, 40, 0.7), { kind: "fold", id: "a" });
  assert.deepEqual(at(b, 230, 40, 0.68), { kind: "card", id: "a" });
});

test("a pointer's fold is the card's own 32 pt corner, at any zoom", () => {
  const b = { cards: [card("a", 0, 0)], lanes: [] };
  assert.deepEqual(mouseAt(b, 210, 20), { kind: "fold", id: "a" });
  assert.deepEqual(mouseAt(b, 200, 40), { kind: "card", id: "a" });
  assert.deepEqual(mouseAt(b, 210, 10), { kind: "card", id: "a" });
  assert.deepEqual(mouseAt(b, 210, 20, 0.25), { kind: "fold", id: "a" });
});

test("a press on a fold is a press on the card", () => {
  for (const mods of [{}, { shift: true }, { alt: true }]) for (const sel of [[], ["a", "b"]]) {
    assert.deepEqual(press("fold", mods, sel), press("card", mods, sel));
  }
});
```

In `web/test/mouse.test.ts`, replace "a press anywhere but the turned card turns it back; on its fold it turns" with "a press anywhere but the turned card turns it back, its fold too": a press at the `fold` of `b` while `a` is turned calls `["turn", null]` and no `["turn", "b"]`.

In `web/test/input.test.ts` (card `a` at 600,72, 240 × 48, camera at zoom 1; the fold's square is x > 808, y > 88):

```ts
test("a click on the corner selects the card, a double-click turns it", () => {
  const { app: a, mouse } = app();
  mouse.down({ x: 830, y: 110, shiftKey: false, altKey: false }, 0);
  mouse.up({ x: 830, y: 110 });
  assert.equal(a.state.turned, null);
  assert.deepEqual([...a.state.selection], ["a"]);
  mouse.down({ x: 830, y: 110, shiftKey: false, altKey: false }, 100);
  mouse.up({ x: 830, y: 110 });
  assert.equal(a.state.turned, "a");
  assert.equal(a.state.editing, null);
});

test("a double tap on the corner turns the card; below 69 % it edits", () => {
  const { app: a } = app();
  a.input.doubleTap({ x: 830, y: 110 });
  assert.equal(a.state.turned, "a");
  // the back is bigger: its corner is elsewhere
  const r = a.view.rectOf(a.model.board.cards[0]!);
  a.input.doubleTap({ x: r.x + r.w - 10, y: r.y + r.h - 10 });
  assert.equal(a.state.turned, null);
  a.view.setCamera({ x: 0, y: 0, zoom: 0.5 });
  a.input.doubleTap({ x: 415, y: 55 });
  assert.equal(a.state.turned, null);
  assert.equal(a.state.editing?.id, "a");
});

test("a double tap on the corner of the card being edited ends the edit and turns it", () => {
  const { app: a } = app();
  a.beginEdit("a");
  a.input.doubleTap({ x: 830, y: 110 });
  assert.equal(a.state.editing, null);
  assert.equal(a.state.turned, "a");
});
```

A single `a.input.tap` on the corner selects without turning; add that assertion to the first touch test before the double tap.

- [ ] **Step 2: Run them to see them fail**

Run: `node --test web/test/policy.test.ts web/test/mouse.test.ts web/test/input.test.ts`
Expected: the new tests FAIL (no fold on a card without notes; a click on the fold turns).

- [ ] **Step 3: Implement**

- `hitTest`: every card has a fold, checked only inside `contains(r, p)`: side `FOLD` for a pointer; for touch, none when `zoom < FOLD_MIN_ZOOM`, else `FOLD_TOUCH * Math.min(zoom, 1) / zoom`, clipped to the card. Update its doc comment.
- `pressAction`: `case "fold":` falls through to `case "card":`; drop `turn` from `PressAction`.
- `Input.tap`: drop the `fold` branch, so a tap on it selects as on the card.
- `Input.doubleTap` and `Input.doubleClick`: a `fold` hit ends editing, selects the card alone and toggles its turn (`app.turn(s.turned === h.id ? null : h.id)`); other hits as now.
- `Mouse.down`: the turned card goes back on a press on anything but itself, fold included (drop `&& h.kind !== "fold"`); drop the `a.turn` line.

- [ ] **Step 4: Run the tests and the type check**

Run: `npm test && npm run check`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/policy.ts web/input.ts web/mouse.ts web/test/policy.test.ts web/test/mouse.test.ts web/test/input.test.ts
git commit -m "Turn a card on the web by a double tap or double-click on its corner, which every card has: …"
```

### Task 2: Web drawing

**Files:**
- Modify: `web/style.css` (`.card.notes .sheet`, `.card.turned .sheet`, `.ear` rules)
- Modify: `web/view.ts` (`renderCard`: the `--ear` while turning)

**Interfaces:**
- Consumes: `FOLD` from Task 1 for the turning ear.

- [ ] **Step 1: Implement**

- Every card's `.ear` is drawn. Without `notes`, not `turned` or `turning`, it is a crease: the sheet not clipped, a 1.5 px diagonal from the corner's bottom-left to its top-right in the card's colour mixed 70 % with black (`color-mix(in srgb, var(--cN) 70%, #000)` via a per-colour custom property or `currentColor` on `.sheet`), as the "Breezy Card Corners" artifact's option 3.
- With `notes`, `turned` or `turning`: the sheet clipped and the fold drawn at 32 px, as today's fold at 16/24.
- `renderCard` while turning: `ear` is `FOLD` with notes, else 0, growing to `FOLD`: a card without notes grows its fold out of the crease.

- [ ] **Step 2: Check it by eye**

Run: `npm run dev`; open localhost (never breezy.k5d.de) with Playwright, light and dark, at 100 % and 25 %: one card per colour with notes, one without, one turned. Screenshot each to the scratchpad and look: crease visible on all five colours in both themes, the fold 32 pt, the turn growing the fold.

- [ ] **Step 3: Commit**

```bash
git add web/style.css web/view.ts
git commit -m "Draw every card's corner on the web: a crease without notes, a 32 pt fold with them …"
```

### Task 3: Mac core, drawing and parity

**Files:**
- Modify: `BreezyKit/Sources/BreezyKit/Geometry.swift` (`Metrics.fold = 32.0`)
- Modify: `BreezyKit/Sources/BreezyKit/CanvasCore.swift` (`hitsFold`, `press`)
- Modify: `Breezy/Canvas/CardLayer.swift` (`Input.ear`, `paint`)
- Modify: `README.md` ("Card back" row)
- Test: `BreezyKit/Tests/BreezyKitTests/CanvasCoreTests.swift`, `scenarios/conformance.test.ts`

**Interfaces:**
- Consumes: Task 1's behaviour, which the parity case holds the Swift core to.

- [ ] **Step 1: Write the failing tests**

Replace `theFoldTurnsACardWithNotesOverAndBack` with `aDoubleClickOnAnyCardsCornerTurnsItOverAndBack`: card `a` (no notes) at 0,0, 240 × 48 as drawn; `hitsFold(a, (230, 40))` and `(210, 20)` true, `(200, 40)` and `(210, 10)` false; `press(at: (230, 40))` leaves `turned == nil`, `selection == ["a"]`; `press(at: (230, 40), clickCount: 2)` makes `turned == "a"` and `selection == ["a"]`; on the back (480 × 288) `hitsFold(a, (460, 270))` true, and a `press(at: (460, 270), clickCount: 2)` turns it back. A second test, `aDoubleClickOnAnotherCardsCornerTurnsTheTurnedOneBackFirst`: `a` turned, a double-click on `b`'s corner leaves `turned == "b"`.

In `scenarios/conformance.test.ts`, after "Space turns the card clicked over":

```ts
parity("a double-click on a card's corner turns it, and on another's turns that one", laneAndCards, async (d, made) => {
  const s = await d.scene();
  const corner = (i: SceneItem) => ({ x: i.x + i.w - 8, y: i.y + i.h - 8 });
  await d.doubleClick(corner(item(s, made[2]!)));
  await d.doubleClick(corner(item(await d.scene(), made[3]!)));
});
```

(use whichever two cards `laneAndCards` makes; import `SceneItem` as the file's other helpers do.)

- [ ] **Step 2: Run them to see them fail**

Run: `swift test --package-path BreezyKit --filter CanvasCoreTests`
Expected: FAIL (`hitsFold` false on a card without notes; a single press turns).

- [ ] **Step 3: Implement**

- `hitsFold`: `Metrics.fold` on every card, front or back.
- `press`: with `clickCount == 2` on a card's fold, select it alone and toggle its turn, before `onDoubleClick`; a single press on the fold goes on as a press on the card (drop the fold branch).
- `CardLayer.Input.ear`: `Metrics.fold` with notes or on the back, else 0; while turning, from that to `Metrics.fold`.
- `paint`: with `ear == 0`, stroke the crease, 1.5 pt, from `(maxX - fold, maxY)` to `(maxX, maxY - fold)`, in `tint.blended(withFraction: 0.3, of: .black)`.
- README "Card back": "Space over a card, or a double-click or double tap on its corner, turns it over; Tab while editing turns it too".

- [ ] **Step 4: Run all checks**

Run: `swift test --package-path BreezyKit && npm test && npm run check && node --test scenarios/conformance.test.ts scenarios/parity.test.ts`
Expected: PASS.

- [ ] **Step 5: Check the Mac by eye**

Build and launch with `-BreezyCapture`, light and dark, `-BreezyTurn any` for a turned card (`docs/performance-journal.md` "Pixels"); compare a card with and without notes against Task 2's web screenshots at 100 %.

- [ ] **Step 6: Commit**

```bash
git add BreezyKit Breezy/Canvas/CardLayer.swift scenarios/conformance.test.ts README.md
git commit -m "Turn a card on the Mac by a double-click on its corner, which every card has, drawn as on the web: …"
```

### Task 4: Pull request and the phone

- [ ] Push, open the PR off main, wait for Main to go green.
- [ ] `gh workflow run nightly.yaml --ref turn-by-corner-double-tap --field only=ios` and `--field only=android`; read `build/scenarios/*/timeline.txt` of any failure.
- [ ] The owner tries the cut-off and the crease on the phone against `npm run dev`; tune `FOLD_MIN_ZOOM` if asked.
