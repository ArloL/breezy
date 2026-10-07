# Breezy touch prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A web page in `web/` that runs Breezy on an iPhone from the home screen, with two switchable pan modes, to judge how the Mac app's interaction feels under fingers.

**Architecture:** Plain ES modules, no build step. Pure modules — `rules.js` (a port of BreezyKit), `model.js` (undo), `gestures.js` (touch recogniser) and `policy.js` (hit testing and the pan-mode table) — are tested with `node --test`. DOM modules — `view.js` (rendering, camera, measuring), `input.js` (gestures to actions), `ui.js` (bars), `app.js` (state and actions), `main.js` (wiring) — are checked in the iOS Simulator and by hand.

**Tech Stack:** JavaScript ES modules, CSS, Node 24 (`node:test`) for tests, Python's `http.server` for serving, Xcode's iOS Simulator for screenshots.

**Spec:** `docs/superpowers/specs/2026-10-07-breezy-touch-design.md`

## Global Constraints

- No dependencies, no build step, no service worker. Target Safari on iOS 17 or later.
- Grid 24; card width 240; back width 480, back min height 288; lane 480 × 720 (sample lanes 288 wide), min 96; lane header 48; stack top 72; stack gap: first grid line at least 12 below; undo limit 100.
- Zoom 25 %–200 %. Text 16 px on a 24 px line; card padding 12 px × 16 px, back padding 24 px.
- Hold 300 ms; slop 8 pt; double tap within 300 ms and 32 pt; touch areas 44 pt.
- Colours: the tokens of `Breezy/Style/Theme.swift`, light and dark.
- Comments state the current design only and stay as sparse as in `BreezyKit`.
- Commits end with `Claude-Session: https://claude.ai/code/session_01AuzxPWNihavyhjJd1EQqtU`, passed as a second `-m`.

Commands used throughout (`$SCRATCH` is the session's scratchpad directory):

```bash
node --test web/test/*.test.js                       # all tests
python3 -m http.server --directory web 8000          # serve; run in the background
xcrun simctl openurl booted "http://localhost:8000/?demo=select"
xcrun simctl io booted screenshot "$SCRATCH/shot.png"
```

## Review Focus

No automated test reaches these; each is pinned by a check in Task 7.

1. **Keyboard on double tap.** iOS shows the keyboard only for a `focus()` inside the touch handler's call stack. `pointerup` → `Gestures.up` → `Input.doubleTap` → `App.beginEdit` → `focus()` must stay synchronous, with no `requestAnimationFrame` or `await` on the way. Pinned by the device check "double-tap opens the keyboard" (Task 7, step 6).
2. **The card being edited stays visible.** With the keyboard up, the card sits above the keyboard bar, and the keyboard bar sits on the keyboard even when iOS shifts the visual viewport. Pinned by the device check "edit near the bottom" (Task 7, step 6).
3. **Edit and display heights agree.** Typing never makes the card jump when editing ends. The title is the first visual line (`::first-line`) in both editor and display, and the measurer uses the same CSS. Pinned by the device check "long title" (Task 7, step 6).
4. **Text after zooming is sharp.** Safari may keep a scaled bitmap after a pinch. Pinned by the device check "zoom to 200 % and read" (Task 7, step 6).
5. **Tapping a bar button keeps the keyboard up while editing.** Buttons act on `touchend` with `preventDefault`, so focus stays in the editor. Pinned by the device check "Turn while editing" (Task 7, step 6).

---

### Task 1: Rules — a port of BreezyKit

**Files:**
- Create: `web/package.json`
- Create: `web/rules.js`
- Test: `web/test/rules.test.js`

**Interfaces:**
- Produces: constants `GRID, CARD_W, BACK_W, BACK_MIN_H, LANE_W, LANE_H, LANE_MIN, LANE_HEADER, ROOM, STACK_TOP`; `snap(v)`; rect helpers `intersects(a, b)`, `contains(r, x, y)`, `containsCentre(r, b)`, `sharesColumn(a, b)`, `lineBelow(r)`, `cardRect(c, h)`, `laneRect(l)`; `newID(prefix)`; queries `card(b, id)`, `lane(b, id)`, `cardsInLane(b, id, heightOf)`, `cardsInRect(b, r, heightOf)`, `laneOf(b, id, heightOf)`, `pile(b, id, heightOf) -> string[]`, `search(b, query) -> {id, side: "front"|"back"|"title"}[]`; mutators (change `b` in place) `addCard(b, x, y) -> id`, `addLane(b, x, y) -> id`, `setText`, `setNotes`, `setLaneTitle`, `finishEdit(b, id)`, `moveCards(b, origins, dx, dy, room?)`, `setColor(b, ids: Set, n)`, `remove(b, ids: Set)`, `moveLane(b, origin, carried, dx, dy)`, `resizeLane(b, id, w, h)`, `layout(b, excluding: Set) -> {cardY: Map, laneH: Map}`, `settle`, `gravity(b, heightOf)`, `land(b, ids: Set, room)`.
- Shapes: board `{cards, lanes}`; card `{id, x, y, w, text, color, notes?}` (`notes` absent when empty); lane `{id, x, y, w, h, title}`; origin `{id, x, y}`; room `{base: layout, heightOf}`; `heightOf(id) -> number`.

- [ ] **Step 1: Write the failing tests**

`web/package.json`:

```json
{ "private": true, "type": "module" }
```

`web/test/rules.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import * as R from "../rules.js";

const board = (cards = [], lanes = []) => ({ cards, lanes });
const card = (id, x, y, text = "t") => ({ id, x, y, w: 240, text, color: 1 });
const lane = (id, x, y, w = 480, h = 720) => ({ id, x, y, w, h, title: "Lane" });
const h48 = () => 48;
const ys = (b, ...ids) => ids.map((id) => R.card(b, id).y);

function drag(b, ids) {
  return {
    origins: ids.map((id) => ({ id, x: R.card(b, id).x, y: R.card(b, id).y })),
    room: { base: R.layout(b, new Set(ids)), heightOf: h48 },
  };
}

const stackBoard = (h = 480) => board([card("a", 24, 72), card("b", 24, 144), card("d", 600, 72)], [lane("l", 0, 0, 480, h)]);

test("snap rounds to the nearest grid line, halves away from zero", () => {
  assert.deepEqual([35, 37, -37, 36, -36, -5].map(R.snap), [24, 48, -48, 48, -48, 0]);
});

test("addCard snaps and starts empty", () => {
  const b = board();
  const c = R.card(b, R.addCard(b, 40, 56));
  assert.deepEqual([c.x, c.y, c.w, c.text, c.notes, c.color], [48, 48, 240, "", undefined, 1]);
});

test("moveCards snaps relative to the drag origins", () => {
  const b = board([card("a", 0, 0), card("b", 48, 24)]);
  R.moveCards(b, [{ id: "a", x: 0, y: 0 }, { id: "b", x: 48, y: 24 }], 32, 10);
  assert.deepEqual([R.card(b, "a").x, R.card(b, "a").y, R.card(b, "b").x, R.card(b, "b").y], [24, 0, 72, 24]);
});

test("finishEdit trims trailing whitespace", () => {
  const b = board([card("a", 0, 0, "Idea\nmore\n\n")]);
  R.finishEdit(b, "a");
  assert.equal(R.card(b, "a").text, "Idea\nmore");
});

test("finishEdit trims notes and drops blank ones", () => {
  const b = board([card("a", 0, 0), card("b", 0, 0)]);
  R.setNotes(b, "a", "As a user\n\n");
  R.setNotes(b, "b", " \n");
  R.finishEdit(b, "a");
  R.finishEdit(b, "b");
  assert.equal(R.card(b, "a").notes, "As a user");
  assert.equal("notes" in R.card(b, "b"), false);
});

test("a card with only notes is kept; one blank on both sides is removed", () => {
  const b = board([card("a", 0, 0, ""), card("b", 0, 0, "")]);
  R.setNotes(b, "a", "details");
  R.finishEdit(b, "a");
  R.finishEdit(b, "b");
  assert.deepEqual(b.cards.map((c) => c.id), ["a"]);
});

test("setColor changes cards only", () => {
  const b = board([card("a", 0, 0)], [lane("l", 0, 0)]);
  R.setColor(b, new Set(["a", "l"]), 4);
  assert.equal(R.card(b, "a").color, 4);
  assert.equal("color" in R.lane(b, "l"), false);
});

test("remove deletes a lane but not the cards on it", () => {
  const b = board([card("a", 24, 72)], [lane("l", 0, 0)]);
  R.remove(b, new Set(["l"]));
  assert.deepEqual([b.lanes.length, b.cards.length], [0, 1]);
  R.remove(b, new Set(["a"]));
  assert.equal(b.cards.length, 0);
});

test("cardsInLane counts cards whose centre is inside", () => {
  const b = board([card("in", 360, 0), card("out", 384, 0)], [lane("l", 0, 0, 480, 720)]);
  assert.deepEqual(R.cardsInLane(b, "l", h48).map((c) => c.id), ["in"]);
});

test("moveLane carries its cards by the snapped delta", () => {
  const b = board([card("a", 24, 72)], [lane("l", 0, 0)]);
  R.moveLane(b, { id: "l", x: 0, y: 0 }, [{ id: "a", x: 24, y: 72 }], 61, -14);
  assert.deepEqual([R.lane(b, "l").x, R.lane(b, "l").y, R.card(b, "a").x, R.card(b, "a").y], [72, -24, 96, 48]);
});

test("resizeLane snaps and keeps a minimum size", () => {
  const b = board([], [lane("l", 0, 0)]);
  R.resizeLane(b, "l", 520, 10);
  assert.deepEqual([R.lane(b, "l").w, R.lane(b, "l").h], [528, 96]);
});

test("cardsInRect finds overlapping cards", () => {
  const b = board([card("a", 0, 0), card("b", 480, 480)]);
  assert.deepEqual(R.cardsInRect(b, { x: 228, y: 36, w: 60, h: 60 }, h48).map((c) => c.id), ["a"]);
});

test("a held card keeps a place free by its centre and lands there", () => {
  const b = stackBoard();
  const d = drag(b, ["d"]);
  R.moveCards(b, d.origins, -576, 48, d.room);
  assert.deepEqual(ys(b, "a", "d", "b"), [72, 120, 216]);
  R.land(b, new Set(["d"]), d.room);
  assert.deepEqual(ys(b, "a", "d", "b"), [72, 144, 216]);
});

test("dragging away gives cards back their places", () => {
  const b = stackBoard();
  const d = drag(b, ["d"]);
  R.moveCards(b, d.origins, -576, 0, d.room);
  assert.deepEqual(ys(b, "a", "b"), [144, 216]);
  R.moveCards(b, d.origins, 0, 0, d.room);
  assert.deepEqual(ys(b, "a", "b"), [72, 144]);
});

test("taking a card out of a stack closes the gap", () => {
  const b = board([card("a", 24, 72), card("b", 24, 144), card("c", 24, 216)], [lane("l", 0, 0)]);
  const d = drag(b, ["b"]);
  R.moveCards(b, d.origins, 576, 0, d.room);
  assert.deepEqual(ys(b, "a", "c"), [72, 144]);
});

test("held cards are ordered as a block by their top card", () => {
  const b = board([card("a", 24, 72), card("p", 600, 72), card("q", 600, 144)], [lane("l", 0, 0)]);
  const d = drag(b, ["p", "q"]);
  R.moveCards(b, d.origins, -576, 0, d.room);
  R.land(b, new Set(["p", "q"]), d.room);
  assert.deepEqual(ys(b, "p", "q", "a"), [72, 144, 216]);
});

test("gravity floats lane cards up their own column and leaves the canvas alone", () => {
  const b = board(
    [card("a", 24, 72), card("b", 24, 360), card("side", 288, 240), card("free", 720, 360)],
    [lane("l", 0, 0, 576, 480)],
  );
  R.gravity(b, h48);
  assert.deepEqual(ys(b, "a", "b", "side", "free"), [72, 144, 72, 360]);
});

test("a lane grows to fit its stack and shrinks back", () => {
  const b = stackBoard(240);
  const d = drag(b, ["d"]);
  R.moveCards(b, d.origins, -576, 0, d.room);
  assert.equal(R.lane(b, "l").h, 288);
  R.moveCards(b, d.origins, 0, 0, d.room);
  assert.equal(R.lane(b, "l").h, 240);
});

test("pile takes a lane card and those below it in its column", () => {
  const b = board(
    [card("a", 24, 72), card("b", 24, 144), card("side", 288, 144), card("c", 24, 240), card("free", 24, 840)],
    [lane("l", 0, 0, 576, 480)],
  );
  assert.deepEqual(R.pile(b, "b", h48), ["b", "c"]);
  assert.deepEqual(R.pile(b, "free", h48), ["free"]);
  assert.equal(R.laneOf(b, "free", h48), undefined);
  assert.equal(R.laneOf(b, "b", h48).id, "l");
});

test("search finds fronts, backs and lane titles in reading order, ignoring case", () => {
  const b = board(
    [card("a", 24, 72, "Plan doing"), { ...card("b", 24, 144, "x"), notes: "doing more" }, card("c", 600, 0, "Doing it")],
    [{ ...lane("l", 0, 0), title: "Doing" }],
  );
  assert.deepEqual(R.search(b, "DOING"), [
    { id: "l", side: "title" },
    { id: "c", side: "front" },
    { id: "a", side: "front" },
    { id: "b", side: "back" },
  ]);
  assert.deepEqual(R.search(b, "  "), []);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test web/test/*.test.js`
Expected: FAIL, `Cannot find module '…/web/rules.js'`.

- [ ] **Step 3: Write `web/rules.js`**

```js
export const GRID = 24;
export const CARD_W = 240;
export const BACK_W = 480;
export const BACK_MIN_H = 12 * GRID;
export const LANE_W = 480;
export const LANE_H = 720;
export const LANE_MIN = 4 * GRID;
export const LANE_HEADER = 2 * GRID;
/** Stacked cards sit on the first grid line at least this far below the card above. */
export const ROOM = GRID / 2;
/** Lane cards float up to this far below the lane top. */
export const STACK_TOP = 3 * GRID;

/** Rounds half away from zero, as Swift's `rounded()` does. */
export function snap(v) {
  const r = Math.round(Math.abs(v) / GRID) * GRID;
  return v < 0 && r ? -r : r;
}

export const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
export const contains = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
export const containsCentre = (r, b) => contains(r, b.x + b.w / 2, b.y + b.h / 2);
/** Whether the two overlap horizontally, as cards in one column of a lane do. */
export const sharesColumn = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w;
/** The first grid line at least `ROOM` below `r`. */
export const lineBelow = (r) => Math.ceil((r.y + r.h + ROOM) / GRID) * GRID;
export const cardRect = (c, h) => ({ x: c.x, y: c.y, w: c.w, h });
export const laneRect = (l) => ({ x: l.x, y: l.y, w: l.w, h: l.h });

export function newID(prefix) {
  return prefix + Date.now().toString(36) + Math.floor(Math.random() * 60466176).toString(36);
}

export const card = (b, id) => b.cards.find((c) => c.id === id);
export const lane = (b, id) => b.lanes.find((l) => l.id === id);

export function addCard(b, x, y) {
  const c = { id: newID("c"), x: snap(x), y: snap(y), w: CARD_W, text: "", color: 1 };
  b.cards.push(c);
  return c.id;
}

export function addLane(b, x, y) {
  const l = { id: newID("l"), x: snap(x), y: snap(y), w: LANE_W, h: LANE_H, title: "Lane" };
  b.lanes.push(l);
  return l.id;
}

export function setText(b, id, text) {
  const c = card(b, id);
  if (c) c.text = text;
}

export function setNotes(b, id, notes) {
  const c = card(b, id);
  if (c) c.notes = notes;
}

export function setLaneTitle(b, id, title) {
  const l = lane(b, id);
  if (l) l.title = title;
}

/** Ends editing card `id`: trailing whitespace goes, and a card blank on both sides is removed. */
export function finishEdit(b, id) {
  const i = b.cards.findIndex((c) => c.id === id);
  if (i < 0) return;
  const c = b.cards[i];
  c.text = c.text.trimEnd();
  const notes = (c.notes ?? "").trimEnd();
  if (notes) c.notes = notes;
  else delete c.notes;
  if (!c.text && !notes) b.cards.splice(i, 1);
}

/** With `room` the cards are held in a drag and the others make room for them; see `settle`. */
export function moveCards(b, origins, dx, dy, room) {
  for (const o of origins) {
    const c = card(b, o.id);
    if (!c) continue;
    c.x = snap(o.x + dx);
    c.y = snap(o.y + dy);
  }
  if (room) settle(b, room.heightOf, { held: new Set(origins.map((o) => o.id)), base: room.base });
}

export function setColor(b, ids, color) {
  for (const c of b.cards) if (ids.has(c.id)) c.color = color;
}

export function remove(b, ids) {
  b.cards = b.cards.filter((c) => !ids.has(c.id));
  b.lanes = b.lanes.filter((l) => !ids.has(l.id));
}

/** Moves lane `origin.id` by the snapped delta and carries `carried` with it. */
export function moveLane(b, origin, carried, dx, dy) {
  const l = lane(b, origin.id);
  if (!l) return;
  l.x = snap(origin.x + dx);
  l.y = snap(origin.y + dy);
  const ddx = l.x - origin.x;
  const ddy = l.y - origin.y;
  for (const o of carried) {
    const c = card(b, o.id);
    if (!c) continue;
    c.x = o.x + ddx;
    c.y = o.y + ddy;
  }
}

export function resizeLane(b, id, w, h) {
  const l = lane(b, id);
  if (!l) return;
  l.w = Math.max(LANE_MIN, snap(w));
  l.h = Math.max(LANE_MIN, snap(h));
}

export function cardsInLane(b, id, heightOf) {
  const l = lane(b, id);
  return l ? b.cards.filter((c) => containsCentre(l, cardRect(c, heightOf(c.id)))) : [];
}

export const cardsInRect = (b, r, heightOf) => b.cards.filter((c) => intersects(r, cardRect(c, heightOf(c.id))));

export function laneOf(b, id, heightOf) {
  const c = card(b, id);
  return c && b.lanes.find((l) => containsCentre(l, cardRect(c, heightOf(id))));
}

/** Where everything but cards `excluding` stands, for a drag's room. */
export function layout(b, excluding) {
  return {
    cardY: new Map(b.cards.filter((c) => !excluding.has(c.id)).map((c) => [c.id, c.y])),
    laneH: new Map(b.lanes.map((l) => [l.id, l.h])),
  };
}

/** Ends a drag: the held cards drop into the places kept for them. */
export const land = (b, ids, room) => settle(b, room.heightOf, { held: ids, base: room.base, land: true });

export const gravity = (b, heightOf) => settle(b, heightOf);

function compare(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/**
 * Floats the cards in each lane up their columns in order of their centres; lanes grow to fit.
 * Cards `held` in a drag stay where they are but are ordered as a block by their top card and
 * keep their places free; `land` moves them in. With `base` the others start from where they
 * stood when the drag began, so dragging away gives cards back their places.
 */
export function settle(b, heightOf, { held = new Set(), base = null, land = false } = {}) {
  if (base) {
    for (const c of b.cards) if (base.cardY.has(c.id)) c.y = base.cardY.get(c.id);
    for (const l of b.lanes) if (base.laneH.has(l.id)) l.h = base.laneH.get(l.id);
  }
  const boxes = b.cards.map((c, index) => ({ index, rect: cardRect(c, heightOf(c.id)), held: held.has(c.id) }));
  const done = new Set();
  for (const l of b.lanes) {
    const members = boxes.filter((x) => !done.has(x.index) && containsCentre(l, x.rect));
    for (const x of members) done.add(x.index);
    const top = members.filter((x) => x.held).reduce((t, x) => (!t || x.rect.y < t.rect.y ? x : t), null);
    const key = (x) =>
      x.held ? [top.rect.y + top.rect.h / 2, 0, x.rect.y, x.index] : [x.rect.y + x.rect.h / 2, 1, x.rect.y, x.index];
    members.sort((p, q) => compare(key(p), key(q)));
    const placed = [];
    for (const x of members) {
      let y = l.y + STACK_TOP;
      for (const p of placed) if (sharesColumn(p, x.rect)) y = Math.max(y, lineBelow(p));
      const r = { ...x.rect, y };
      placed.push(r);
      if (!x.held || land) b.cards[x.index].y = y;
      l.h = Math.max(l.h, lineBelow(r) - l.y);
    }
  }
}

/** Card `id` and the cards below it in its lane's column. */
export function pile(b, id, heightOf) {
  const c = card(b, id);
  if (!c) return [];
  const cr = cardRect(c, heightOf(id));
  const l = b.lanes.find((x) => containsCentre(x, cr));
  if (!l) return [id];
  return b.cards
    .filter((x) => {
      const xr = cardRect(x, heightOf(x.id));
      return x.id === id || (x.y > c.y && sharesColumn(cr, xr) && containsCentre(l, xr));
    })
    .map((x) => x.id);
}

/** Lane titles, card fronts and card backs containing `query`, in reading order. */
export function search(b, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const items = [
    ...b.lanes.map((l) => ({ x: l.x, y: l.y, parts: [{ id: l.id, side: "title", text: l.title }] })),
    ...b.cards.map((c) => ({
      x: c.x,
      y: c.y,
      parts: [{ id: c.id, side: "front", text: c.text }, ...(c.notes ? [{ id: c.id, side: "back", text: c.notes }] : [])],
    })),
  ];
  items.sort((p, q2) => p.y - q2.y || p.x - q2.x);
  return items
    .flatMap((i) => i.parts)
    .filter((p) => p.text.toLowerCase().includes(q))
    .map(({ id, side }) => ({ id, side }));
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --test web/test/*.test.js`
Expected: PASS, 20 tests.

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/rules.js web/test/rules.test.js
git commit -m "Port the board rules to JavaScript for the touch prototype" -m "Claude-Session: https://claude.ai/code/session_01AuzxPWNihavyhjJd1EQqtU"
```

---

### Task 2: Model with undo

**Files:**
- Create: `web/model.js`
- Test: `web/test/model.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `UNDO_LIMIT`; `class Model` with `board` (replaced on undo and redo, so always read `model.board`), `onChange()` callback, `inGesture`, `canUndo`, `canRedo`, `perform(name, change)`, `begin()`, `update(change)`, `end(name)`, `undo()`, `redo()`. `change` is `(board) => void` and mutates in place.

- [ ] **Step 1: Write the failing tests**

`web/test/model.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { Model, UNDO_LIMIT } from "../model.js";

const fresh = () => new Model({ cards: [{ id: "a", x: 0, y: 0, w: 240, text: "t", color: 1 }], lanes: [] });
const x = (m) => m.board.cards[0].x;

test("perform records one step that undo and redo replay", () => {
  const m = fresh();
  m.perform("Move", (b) => (b.cards[0].x = 24));
  m.undo();
  assert.equal(x(m), 0);
  m.redo();
  assert.equal(x(m), 24);
});

test("a change that changes nothing records nothing", () => {
  const m = fresh();
  m.perform("Move", (b) => (b.cards[0].x = 0));
  assert.equal(m.canUndo, false);
});

test("a gesture is one step however many updates it has", () => {
  const m = fresh();
  m.begin();
  for (const v of [24, 48, 72]) m.update((b) => (b.cards[0].x = v));
  m.end("Move");
  m.undo();
  assert.equal(x(m), 0);
  assert.equal(m.canUndo, false);
});

test("a gesture that ends where it began records nothing", () => {
  const m = fresh();
  m.begin();
  m.update((b) => (b.cards[0].x = 24));
  m.update((b) => (b.cards[0].x = 0));
  m.end("Move");
  assert.equal(m.canUndo, false);
});

test("undo waits while a gesture is in progress", () => {
  const m = fresh();
  m.perform("Move", (b) => (b.cards[0].x = 24));
  m.begin();
  m.update((b) => (b.cards[0].x = 48));
  m.undo();
  assert.equal(x(m), 48);
  m.end("Move");
  m.undo();
  assert.equal(x(m), 24);
});

test("history keeps the last 100 steps", () => {
  const m = fresh();
  for (let i = 1; i <= UNDO_LIMIT + 1; i++) m.perform("Move", (b) => (b.cards[0].x = i * 24));
  for (let i = 0; i <= UNDO_LIMIT; i++) m.undo();
  assert.equal(x(m), 24);
});

test("a new change clears redo", () => {
  const m = fresh();
  m.perform("Move", (b) => (b.cards[0].x = 24));
  m.undo();
  m.perform("Move", (b) => (b.cards[0].x = 48));
  assert.equal(m.canRedo, false);
});

test("onChange fires for changes, gesture steps, undo and redo", () => {
  const m = fresh();
  let n = 0;
  m.onChange = () => n++;
  m.perform("Move", (b) => (b.cards[0].x = 24));
  m.begin();
  m.update((b) => (b.cards[0].x = 48));
  m.end("Move");
  m.undo();
  m.redo();
  assert.equal(n, 5);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test web/test/*.test.js`
Expected: FAIL, `Cannot find module '…/web/model.js'`.

- [ ] **Step 3: Write `web/model.js`**

```js
export const UNDO_LIMIT = 100;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The board being edited, with undo. A change goes through `perform`, or through a gesture
 * (`begin`, `update`…, `end`) such as a drag or an edit session; either records one step, and
 * only when the board changed.
 */
export class Model {
  constructor(board) {
    this.board = board;
    this.undos = [];
    this.redos = [];
    this.start = null;
    this.onChange = () => {};
  }

  get inGesture() {
    return this.start !== null;
  }

  get canUndo() {
    return this.undos.length > 0 && !this.inGesture;
  }

  get canRedo() {
    return this.redos.length > 0 && !this.inGesture;
  }

  perform(name, change) {
    const before = structuredClone(this.board);
    change(this.board);
    if (same(before, this.board)) return;
    this.record(before, name);
    this.onChange();
  }

  begin() {
    if (!this.start) this.start = structuredClone(this.board);
  }

  /** A step within a gesture: notifies, but records nothing. */
  update(change) {
    change(this.board);
    this.onChange();
  }

  end(name) {
    const start = this.start;
    if (!start) return;
    this.start = null;
    if (!same(start, this.board)) this.record(start, name);
    this.onChange();
  }

  undo() {
    this.swap(this.undos, this.redos);
  }

  redo() {
    this.swap(this.redos, this.undos);
  }

  swap(from, to) {
    if (this.inGesture || !from.length) return;
    const step = from.pop();
    to.push({ board: this.board, name: step.name });
    this.board = step.board;
    this.onChange();
  }

  record(before, name) {
    this.undos.push({ board: before, name });
    if (this.undos.length > UNDO_LIMIT) this.undos.shift();
    this.redos = [];
  }
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --test web/test/*.test.js`
Expected: PASS, 28 tests.

- [ ] **Step 5: Commit**

```bash
git add web/model.js web/test/model.test.js
git commit -m "Add the touch prototype's undo model" -m "Claude-Session: https://claude.ai/code/session_01AuzxPWNihavyhjJd1EQqtU"
```

---

### Task 3: Gesture recogniser

**Files:**
- Create: `web/gestures.js`
- Test: `web/test/gestures.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `HOLD_MS, SLOP, DOUBLE_MS, DOUBLE_SLOP`; `class Gestures(handler)` with `down(id, x, y, t)`, `move(id, x, y, t)`, `up(id, x, y, t)`, `cancel(id)`, `tick(t)`. It calls these on `handler`, with points `{x, y}` in screen pixels and velocities `{x, y}` in px/ms:
  - `tap(p)`, `doubleTap(p)`. The first tap of a double tap is reported as a tap, at once.
  - `hold(p)`, `holdEnd(p)` (lifted without moving), `holdCancel()`.
  - `dragStart(p0, p, held)`, `dragMove(p)`, `dragEnd(p, v)`.
  - `pinchStart(c)`, `pinch(c, scale)`, `pinchEnd(v)`.
  A second finger ends a one-finger drag (`dragEnd` with zero velocity) or cancels a hold, then starts a pinch. After a pinch the remaining finger is ignored until it lifts.

- [ ] **Step 1: Write the failing tests**

`web/test/gestures.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { Gestures, HOLD_MS } from "../gestures.js";

function setup() {
  const log = [];
  const h = new Proxy({}, { get: (_, name) => (...args) => log.push([name, ...args]) });
  return { g: new Gestures(h), log, names: () => log.map((e) => e[0]) };
}

const P = (x, y) => ({ x, y });

test("a quick touch is a tap", () => {
  const { g, log } = setup();
  g.down(1, 10, 10, 0);
  g.up(1, 10, 10, 80);
  assert.deepEqual(log, [["tap", P(10, 10)]]);
});

test("a second tap nearby within 300 ms is a double tap; the first still counts as a tap", () => {
  const { g, log } = setup();
  g.down(1, 10, 10, 0);
  g.up(1, 10, 10, 50);
  g.down(2, 20, 15, 250);
  g.up(2, 20, 15, 300);
  assert.deepEqual(log, [["tap", P(10, 10)], ["doubleTap", P(20, 15)]]);
});

test("taps too far apart in time or space are separate taps", () => {
  const { g, names } = setup();
  g.down(1, 10, 10, 0);
  g.up(1, 10, 10, 50);
  g.down(2, 10, 10, 400);
  g.up(2, 10, 10, 450);
  g.down(3, 100, 10, 500);
  g.up(3, 100, 10, 550);
  assert.deepEqual(names(), ["tap", "tap", "tap"]);
});

test("a third quick tap after a double tap starts over", () => {
  const { g, names } = setup();
  for (const [id, t] of [[1, 0], [2, 100], [3, 200]]) {
    g.down(id, 10, 10, t);
    g.up(id, 10, 10, t + 30);
  }
  assert.deepEqual(names(), ["tap", "doubleTap", "tap"]);
});

test("moving less than 8 pt is still a tap", () => {
  const { g, names } = setup();
  g.down(1, 0, 0, 0);
  g.move(1, 5, 0, 20);
  g.up(1, 5, 0, 40);
  assert.deepEqual(names(), ["tap"]);
});

test("moving 8 pt or more is a drag, reported with where it started", () => {
  const { g, log } = setup();
  g.down(1, 0, 0, 0);
  g.move(1, 3, 0, 10);
  g.move(1, 10, 0, 20);
  g.move(1, 20, 0, 30);
  g.up(1, 20, 0, 40);
  assert.deepEqual(log.slice(0, 2), [["dragStart", P(0, 0), P(10, 0), false], ["dragMove", P(20, 0)]]);
  assert.equal(log[2][0], "dragEnd");
  assert.deepEqual(log[2][1], P(20, 0));
});

test("holding still for 300 ms is a hold; lifting then is not a tap", () => {
  const { g, log } = setup();
  g.down(1, 5, 5, 0);
  g.tick(HOLD_MS - 1);
  assert.deepEqual(log, []);
  g.tick(HOLD_MS);
  g.up(1, 5, 5, 500);
  assert.deepEqual(log, [["hold", P(5, 5)], ["holdEnd", P(5, 5)]]);
});

test("a hold is reported when the finger lifts late, even if no timer fired", () => {
  const { g, names } = setup();
  g.down(1, 5, 5, 0);
  g.up(1, 5, 5, 400);
  assert.deepEqual(names(), ["hold", "holdEnd"]);
});

test("a drag after a hold says so", () => {
  const { g, log } = setup();
  g.down(1, 0, 0, 0);
  g.tick(HOLD_MS);
  g.move(1, 20, 0, 400);
  assert.deepEqual(log, [["hold", P(0, 0)], ["dragStart", P(0, 0), P(20, 0), true]]);
});

test("a drag starting after 300 ms counts as held even if no timer fired", () => {
  const { g, log } = setup();
  g.down(1, 0, 0, 0);
  g.move(1, 20, 0, 350);
  assert.deepEqual(log, [["hold", P(0, 0)], ["dragStart", P(0, 0), P(20, 0), true]]);
});

test("a second finger starts a pinch; the finger left after it is ignored", () => {
  const { g, log } = setup();
  g.down(1, 0, 0, 0);
  g.down(2, 100, 0, 10);
  g.move(2, 200, 0, 20);
  g.up(2, 200, 0, 30);
  g.move(1, 50, 50, 40);
  g.up(1, 50, 50, 50);
  assert.deepEqual(log.slice(0, 2), [["pinchStart", P(50, 0)], ["pinch", P(100, 0), 2]]);
  assert.deepEqual(log.slice(2).map((e) => e[0]), ["pinchEnd"]);
});

test("a second finger ends a one-finger drag first", () => {
  const { g, log } = setup();
  g.down(1, 0, 0, 0);
  g.move(1, 20, 0, 10);
  g.down(2, 100, 0, 20);
  assert.deepEqual(log.slice(1), [["dragEnd", P(20, 0), P(0, 0)], ["pinchStart", P(60, 0)]]);
});

test("a second finger cancels a hold", () => {
  const { g, names } = setup();
  g.down(1, 0, 0, 0);
  g.tick(HOLD_MS);
  g.down(2, 100, 0, 400);
  assert.deepEqual(names(), ["hold", "holdCancel", "pinchStart"]);
});

test("velocity is measured over the last 80 ms and is zero after a pause", () => {
  const { g, log } = setup();
  g.down(1, 0, 0, 0);
  for (let t = 10; t <= 100; t += 10) g.move(1, t, 0, t);
  g.up(1, 100, 0, 100);
  assert.ok(Math.abs(log.at(-1)[2].x - 1) < 1e-9);
  const s = setup();
  s.g.down(1, 0, 0, 0);
  for (let t = 10; t <= 100; t += 10) s.g.move(1, t, 0, t);
  s.g.up(1, 100, 0, 300);
  assert.deepEqual(s.log.at(-1)[2], P(0, 0));
});

test("a cancelled drag ends where it was", () => {
  const { g, log } = setup();
  g.down(1, 0, 0, 0);
  g.move(1, 20, 0, 10);
  g.cancel(1);
  assert.deepEqual(log.at(-1), ["dragEnd", P(20, 0), P(0, 0)]);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test web/test/*.test.js`
Expected: FAIL, `Cannot find module '…/web/gestures.js'`.

- [ ] **Step 3: Write `web/gestures.js`**

```js
export const HOLD_MS = 300;
export const SLOP = 8;
export const DOUBLE_MS = 300;
export const DOUBLE_SLOP = 32;
const VELOCITY_MS = 80;

const ZERO = Object.freeze({ x: 0, y: 0 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function velocity(track, t) {
  const recent = track.filter((s) => t - s.t <= VELOCITY_MS);
  if (recent.length < 2) return { ...ZERO };
  const a = recent[0];
  const b = recent[recent.length - 1];
  const dt = b.t - a.t;
  return dt > 0 ? { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt } : { ...ZERO };
}

/** Turns pointer events into taps, holds, drags and two-finger pinches for `h`; times in ms. */
export class Gestures {
  constructor(h) {
    this.h = h;
    this.points = new Map();
    this.one = null;
    this.two = null;
    this.lastTap = null;
  }

  down(id, x, y, t) {
    const p = { x, y };
    this.points.set(id, p);
    if (this.points.size === 1) {
      const double = !!this.lastTap && t - this.lastTap.t <= DOUBLE_MS && dist(this.lastTap, p) <= DOUBLE_SLOP;
      this.one = { id, start: p, last: p, t, state: "pending", double, track: [{ ...p, t }] };
    } else if (this.points.size === 2) {
      if (this.one?.state === "drag") this.h.dragEnd(this.one.last, { ...ZERO });
      else if (this.one?.state === "held") this.h.holdCancel();
      this.one = null;
      this.lastTap = null;
      const [a, b] = this.points.values();
      const c = mid(a, b);
      this.two = { d: Math.max(dist(a, b), 1), track: [{ ...c, t }] };
      this.h.pinchStart(c);
    }
  }

  /** Reports a hold once the finger has stayed put for `HOLD_MS`; the page calls it from a timer. */
  tick(t) {
    const o = this.one;
    if (o?.state === "pending" && t - o.t >= HOLD_MS) {
      o.state = "held";
      this.h.hold(o.start);
    }
  }

  move(id, x, y, t) {
    if (!this.points.has(id)) return;
    const p = { x, y };
    this.points.set(id, p);
    if (this.two) {
      if (this.points.size < 2) return;
      const [a, b] = this.points.values();
      const c = mid(a, b);
      this.two.track.push({ ...c, t });
      this.h.pinch(c, dist(a, b) / this.two.d);
      return;
    }
    const o = this.one;
    if (o?.id !== id) return;
    o.last = p;
    o.track.push({ ...p, t });
    if (o.state === "drag") return this.h.dragMove(p);
    if (dist(o.start, p) < SLOP) return;
    this.tick(t);
    const held = o.state === "held";
    o.state = "drag";
    this.h.dragStart(o.start, p, held);
  }

  up(id, x, y, t) {
    if (!this.points.has(id)) return;
    this.points.delete(id);
    if (this.two) {
      if (this.points.size < 2) {
        this.h.pinchEnd(velocity(this.two.track, t));
        this.two = null;
      }
      return;
    }
    const o = this.one;
    if (o?.id !== id) return;
    this.tick(t);
    this.one = null;
    const p = { x, y };
    o.track.push({ ...p, t });
    if (o.state === "drag") return this.h.dragEnd(p, velocity(o.track, t));
    if (o.state === "held") return this.h.holdEnd(o.start);
    if (o.double) {
      this.lastTap = null;
      return this.h.doubleTap(o.start);
    }
    this.lastTap = { ...o.start, t };
    this.h.tap(o.start);
  }

  cancel(id) {
    if (!this.points.has(id)) return;
    this.points.delete(id);
    if (this.two) {
      if (this.points.size < 2) {
        this.h.pinchEnd({ ...ZERO });
        this.two = null;
      }
      return;
    }
    const o = this.one;
    if (o?.id !== id) return;
    this.one = null;
    if (o.state === "drag") this.h.dragEnd(o.last, { ...ZERO });
    else if (o.state === "held") this.h.holdCancel();
  }
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --test web/test/*.test.js`
Expected: PASS, 43 tests.

- [ ] **Step 5: Commit**

```bash
git add web/gestures.js web/test/gestures.test.js
git commit -m "Add the touch gesture recogniser" -m "Claude-Session: https://claude.ai/code/session_01AuzxPWNihavyhjJd1EQqtU"
```

---

### Task 4: Hit testing and the pan-mode table

**Files:**
- Create: `web/policy.js`
- Test: `web/test/policy.test.js`

**Interfaces:**
- Consumes: `LANE_HEADER`, `card`, `contains` from `rules.js`.
- Produces: `TOUCH = 44`; `hitTest(b, p, {rectOf, zoom, turned}) -> {kind: "fold"|"card"|"corner"|"header"|"empty", id?}`, where `p` is a world point and `rectOf(card)` the card's drawn rect; `dragAction(mode: "one"|"two", hit, selection: Set, held: boolean) -> "pan"|"move"|"lane"|"resize"|"marquee"`.

- [ ] **Step 1: Write the failing tests**

`web/test/policy.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { hitTest, dragAction } from "../policy.js";

const rectOf = (c) => ({ x: c.x, y: c.y, w: c.w, h: 48 });
const card = (id, x, y, notes) => ({ id, x, y, w: 240, text: "t", color: 1, ...(notes ? { notes } : {}) });
const lane = { id: "l", x: 0, y: 0, w: 480, h: 720, title: "Lane" };
const at = (b, x, y, zoom = 1, turned = null) => hitTest(b, { x, y }, { rectOf, zoom, turned });

test("the folded corner takes a 44 pt touch area, reaching outside the card", () => {
  const b = { cards: [card("a", 0, 0, "n")], lanes: [] };
  assert.deepEqual(at(b, 250, 50), { kind: "fold", id: "a" });
  assert.deepEqual(at(b, 200, 24), { kind: "card", id: "a" });
});

test("a card without notes has no fold", () => {
  const b = { cards: [card("a", 0, 0)], lanes: [] };
  assert.deepEqual(at(b, 238, 46), { kind: "card", id: "a" });
  assert.deepEqual(at(b, 250, 50), { kind: "empty" });
});

test("cards win over the lane header beneath them", () => {
  const b = { cards: [card("a", 24, 24)], lanes: [lane] };
  assert.deepEqual(at(b, 100, 40), { kind: "card", id: "a" });
  assert.deepEqual(at(b, 300, 40), { kind: "header", id: "l" });
});

test("the header and the resize corner grow to 44 pt at low zoom", () => {
  const b = { cards: [], lanes: [lane] };
  assert.deepEqual(at(b, 100, 150, 0.25), { kind: "header", id: "l" });
  assert.deepEqual(at(b, 100, 150, 1), { kind: "empty" });
  assert.deepEqual(at(b, 480, 720), { kind: "corner", id: "l" });
  assert.deepEqual(at(b, 420, 660, 0.25), { kind: "corner", id: "l" });
  assert.deepEqual(at(b, 420, 660, 1), { kind: "empty" });
});

test("a turned card is on top of later cards", () => {
  const b = { cards: [card("a", 0, 0), card("b", 24, 0)], lanes: [] };
  assert.deepEqual(at(b, 100, 24), { kind: "card", id: "b" });
  assert.deepEqual(at(b, 100, 24, 1, "a"), { kind: "card", id: "a" });
});

test("one finger pans unless the drag starts on a selected card or after a hold", () => {
  const sel = new Set(["a"]);
  const cases = [
    [{ kind: "empty" }, false, "pan"],
    [{ kind: "empty" }, true, "marquee"],
    [{ kind: "card", id: "b" }, false, "pan"],
    [{ kind: "card", id: "b" }, true, "move"],
    [{ kind: "card", id: "a" }, false, "move"],
    [{ kind: "fold", id: "a" }, false, "move"],
    [{ kind: "header", id: "l" }, false, "pan"],
    [{ kind: "header", id: "l" }, true, "lane"],
    [{ kind: "corner", id: "l" }, false, "resize"],
  ];
  for (const [hit, held, want] of cases) assert.equal(dragAction("one", hit, sel, held), want, JSON.stringify([hit, held]));
});

test("with two-finger panning one finger moves, draws a box or moves lanes at once", () => {
  const sel = new Set();
  const cases = [
    [{ kind: "empty" }, "marquee"],
    [{ kind: "card", id: "b" }, "move"],
    [{ kind: "header", id: "l" }, "lane"],
    [{ kind: "corner", id: "l" }, "resize"],
  ];
  for (const [hit, want] of cases) {
    assert.equal(dragAction("two", hit, sel, false), want);
    assert.equal(dragAction("two", hit, sel, true), want);
  }
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test web/test/*.test.js`
Expected: FAIL, `Cannot find module '…/web/policy.js'`.

- [ ] **Step 3: Write `web/policy.js`**

```js
import { LANE_HEADER, card, contains } from "./rules.js";

export const TOUCH = 44;

/** What is under world point `p`, top first; touch areas are `TOUCH` screen points at `zoom`. */
export function hitTest(b, p, { rectOf, zoom, turned }) {
  const reach = TOUCH / 2 / zoom;
  const near = (x, y) => Math.abs(p.x - x) <= reach && Math.abs(p.y - y) <= reach;
  const order = [...b.cards].reverse();
  const t = turned && card(b, turned);
  if (t) order.unshift(...order.splice(order.indexOf(t), 1));
  for (const c of order) {
    const r = rectOf(c);
    const ear = c.id === turned ? 24 : c.notes ? 16 : 0;
    if (ear && near(r.x + r.w - ear / 2, r.y + r.h - ear / 2)) return { kind: "fold", id: c.id };
    if (contains(r, p.x, p.y)) return { kind: "card", id: c.id };
  }
  for (const l of [...b.lanes].reverse()) {
    if (near(l.x + l.w - 10, l.y + l.h - 10)) return { kind: "corner", id: l.id };
    const header = { x: l.x, y: l.y, w: l.w, h: Math.max(LANE_HEADER, TOUCH / zoom) };
    if (contains(header, p.x, p.y)) return { kind: "header", id: l.id };
  }
  return { kind: "empty" };
}

/** What a one-finger drag does, by pan mode: see the spec's table. */
export function dragAction(mode, hit, selection, held) {
  const free = mode === "two" || held;
  switch (hit.kind) {
    case "corner":
      return "resize";
    case "card":
    case "fold":
      return free || selection.has(hit.id) ? "move" : "pan";
    case "header":
      return free ? "lane" : "pan";
    default:
      return free ? "marquee" : "pan";
  }
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --test web/test/*.test.js`
Expected: PASS, 50 tests.

- [ ] **Step 5: Commit**

```bash
git add web/policy.js web/test/policy.test.js
git commit -m "Add hit testing and the pan-mode table" -m "Claude-Session: https://claude.ai/code/session_01AuzxPWNihavyhjJd1EQqtU"
```

---

### Task 5: Page, look and rendering

Renders the sample board with its bars; nothing responds to touch yet.

**Files:**
- Create: `web/index.html`, `web/style.css`, `web/manifest.webmanifest`
- Create: `web/view.js`, `web/sample.js`, `web/main.js` (replaced in Task 6)
- Create: `scripts/make-web-icons.swift`; generated `web/icon-180.png`, `web/icon-512.png`

**Interfaces:**
- Consumes: `rules.js`, `model.js`.
- Produces:
  - From `view.js`: `MIN_ZOOM`, `MAX_ZOOM`, `clampZoom(z)`, and `class View(root, model, state)` with:
    - Camera: `cam {x, y, zoom}`, `toWorld(p)`, `toScreen(p)`, `setCamera(cam, animate?)`, `stopGlide()`, `zoomAround(screenPoint, zoom, animate?)`, `centre()`, `reveal(rect, prefer: "top"|"bottom")`, `centreOn(rect)`.
    - Rendering and measuring: `invalidate()`, `render()`, `heightOf(id)`, `frontHeight(text, w)`, `rectOf(card)`, `editorOf(id, back)`, `titleOf(id)`, `animateTurn(ids, change)`.
    - Hooks: `area` (assignable, returns `{top, bottom, left, right}`) and `onCamera` (assignable callback).
  - `state`: `{selection: Set, turned: id|null, editing: {id, back, name}|null, renaming: id|null, held: Set, lifted: Set, marquee: rect|null, found: id|null}`.
  - From `sample.js`: `sampleBoard()` (card id `c-offsite` has notes) and `stressBoard()`.
  - From `index.html`: elements `#board .world .lanes|.cards|.marquee`, `#top`, `#find`, `#bottom .add|.menu|.selection`, `#keys`, `#settings`, `.measure`, and buttons with `data-act` as listed in Task 6's `UI.act`.

- [ ] **Step 1: Write the icons script and generate the icons**

`scripts/make-web-icons.swift`:

```swift
import AppKit

// Writes the web app's home-screen icons, full-bleed as iOS wants them, into the directory given.
let out = URL(fileURLWithPath: CommandLine.arguments[1])

func hex(_ v: UInt32, _ a: CGFloat = 1) -> NSColor {
  NSColor(srgbRed: CGFloat(v >> 16 & 0xff) / 255, green: CGFloat(v >> 8 & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: a)
}

for px in [180, 512] {
  let s = CGFloat(px)
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                             hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  hex(0xf1efea).setFill()
  NSRect(x: 0, y: 0, width: s, height: s).fill()
  let card = NSRect(x: s * 0.2, y: s * 0.26, width: s * 0.6, height: s * 0.48)
  let shadow = NSShadow()
  shadow.shadowColor = NSColor.black.withAlphaComponent(0.22)
  shadow.shadowOffset = NSSize(width: 0, height: -s * 0.015)
  shadow.shadowBlurRadius = s * 0.04
  NSGraphicsContext.saveGraphicsState()
  shadow.set()
  hex(0xf8eca2).setFill()
  card.fill()
  NSGraphicsContext.restoreGraphicsState()
  hex(0x2b2a27, 0.8).setFill()
  NSRect(x: card.minX + s * 0.06, y: card.maxY - s * 0.13, width: card.width * 0.55, height: s * 0.04).fill()
  hex(0x2b2a27, 0.35).setFill()
  for i in 0..<2 {
    NSRect(x: card.minX + s * 0.06, y: card.maxY - s * 0.23 - CGFloat(i) * s * 0.08, width: card.width * (i == 0 ? 0.75 : 0.5), height: s * 0.025).fill()
  }
  NSGraphicsContext.restoreGraphicsState()
  try! rep.representation(using: .png, properties: [:])!.write(to: out.appendingPathComponent("icon-\(px).png"))
}
```

Run: `swift scripts/make-web-icons.swift web && file web/icon-180.png web/icon-512.png`
Expected: `PNG image data, 180 x 180` and `512 x 512`.

- [ ] **Step 2: Write `web/index.html` and `web/manifest.webmanifest`**

`web/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Breezy">
<meta name="theme-color" content="#f1efea" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1f1e1c" media="(prefers-color-scheme: dark)">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icon-180.png">
<link rel="stylesheet" href="style.css">
<title>Breezy</title>
<script type="module" src="main.js"></script>
</head>
<body>
<div id="board">
  <div class="world"><div class="lanes"></div><div class="cards"></div><div class="marquee" hidden></div></div>
</div>

<header id="top">
  <button data-act="undo" aria-label="Undo"><svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg></button>
  <button data-act="redo" aria-label="Redo"><svg viewBox="0 0 24 24"><path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></svg></button>
  <button data-act="zoom" class="zoom">100 %</button>
  <button data-act="search" aria-label="Find"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg></button>
  <button data-act="settings" aria-label="Settings"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></svg></button>
</header>

<div id="find" hidden>
  <input type="search" placeholder="Find" enterkeyhint="search" autocomplete="off" autocorrect="off">
  <span class="count"></span>
  <button data-act="prev" aria-label="Previous"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg></button>
  <button data-act="next" aria-label="Next"><svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg></button>
  <button data-act="close-find">Done</button>
</div>

<footer id="bottom">
  <div class="add">
    <div class="menu" hidden><button data-act="new-card">Card</button><button data-act="new-lane">Lane</button></div>
    <button data-act="add" class="plus" aria-label="Add">+</button>
  </div>
  <div class="selection" hidden>
    <button data-act="colour" data-colour="1" class="swatch" aria-label="Yellow"><i class="c1"></i></button>
    <button data-act="colour" data-colour="2" class="swatch" aria-label="Pink"><i class="c2"></i></button>
    <button data-act="colour" data-colour="3" class="swatch" aria-label="Blue"><i class="c3"></i></button>
    <button data-act="colour" data-colour="4" class="swatch" aria-label="Green"><i class="c4"></i></button>
    <button data-act="colour" data-colour="5" class="swatch" aria-label="Grey"><i class="c5"></i></button>
    <button data-act="turn" aria-label="Turn over"><svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 0 1 14-5.3L20 9"/><path d="M20 4v5h-5"/><path d="M20 12a8 8 0 0 1-14 5.3L4 15"/><path d="M4 20v-5h5"/></svg></button>
    <button data-act="pile" aria-label="Select the cards below"><svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="5" rx="1"/><rect x="5" y="10" width="14" height="5" rx="1"/><rect x="5" y="17" width="14" height="4" rx="1"/></svg></button>
    <button data-act="delete" aria-label="Delete"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>
  </div>
</footer>

<div id="keys" hidden><button data-act="key-turn">Turn</button><button data-act="key-done" class="strong">Done</button></div>

<div id="settings" hidden>
  <div class="panel">
    <p class="label">Panning</p>
    <button data-act="mode" data-mode="one"><b>One finger pans</b><span>Hold a card to pick it up</span></button>
    <button data-act="mode" data-mode="two"><b>Two fingers pan</b><span>One finger moves cards and draws a selection box</span></button>
    <button data-act="close-settings" class="strong">Done</button>
  </div>
</div>

<div class="measure" aria-hidden="true"></div>
</body>
</html>
```

`web/manifest.webmanifest`:

```json
{
  "name": "Breezy",
  "short_name": "Breezy",
  "display": "standalone",
  "start_url": "./",
  "background_color": "#f1efea",
  "theme_color": "#f1efea",
  "icons": [
    { "src": "icon-180.png", "sizes": "180x180", "type": "image/png" },
    { "src": "icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

- [ ] **Step 3: Write `web/style.css`**

```css
:root {
  --paper: #f1efea;
  --ink: #2b2a27;
  --ink2: rgb(43 42 39 / 0.68);
  --ink3: rgb(43 42 39 / 0.42);
  --hairline: rgb(43 42 39 / 0.12);
  --dot: rgb(43 42 39 / 0.16);
  --accent: #e8620a;
  --lane: rgb(255 255 255 / 0.45);
  --bar: rgb(241 239 234 / 0.85);
  --c1: #f8eca2;
  --c2: #f5d2ca;
  --c3: #cfe0ee;
  --c4: #d6e6c6;
  --c5: #e3e0d9;
  --ease: cubic-bezier(0.2, 0.8, 0.2, 1);
  color-scheme: light dark;
}

@media (prefers-color-scheme: dark) {
  :root {
    --paper: #1f1e1c;
    --ink: #e9e6df;
    --ink2: rgb(233 230 223 / 0.68);
    --ink3: rgb(233 230 223 / 0.42);
    --hairline: rgb(233 230 223 / 0.12);
    --dot: rgb(233 230 223 / 0.16);
    --accent: #ff8a3d;
    --lane: rgb(255 255 255 / 0.04);
    --bar: rgb(31 30 28 / 0.85);
    --c1: #4f4628;
    --c2: #553a35;
    --c3: #2f4152;
    --c4: #384731;
    --c5: #403e3a;
  }
}

[hidden] { display: none !important; }

html, body { margin: 0; height: 100%; overflow: hidden; overscroll-behavior: none; background: var(--paper); }
body {
  position: fixed; inset: 0;
  font: 16px/24px -apple-system, system-ui, sans-serif; color: var(--ink);
  -webkit-text-size-adjust: 100%;
  -webkit-user-select: none; user-select: none;
  -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent;
}

#board {
  position: absolute; inset: 0; overflow: hidden; touch-action: none;
  background-color: var(--paper);
  background-image: radial-gradient(circle, var(--dot) 0.9px, transparent 1.1px);
}
#board.no-dots { background-image: none; }
#board.glide { transition: background-position 0.25s var(--ease), background-size 0.25s var(--ease); }
.world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.world.glide { transition: transform 0.25s var(--ease); }

.lane {
  position: absolute; left: 0; top: 0; box-sizing: border-box;
  background: var(--lane); border: 1px solid var(--hairline); border-radius: 6px;
  transition: transform 0.2s var(--ease), width 0.2s var(--ease), height 0.2s var(--ease);
}
.lane.selected { border: 2px solid var(--accent); }
.lane.held { transition: none; }
.lane .header { height: 47px; margin: 0 16px; border-bottom: 1px solid var(--hairline); display: flex; align-items: center; }
.lane .title {
  font-weight: 600; color: var(--ink2); text-transform: uppercase; letter-spacing: 0.08em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; outline: none; min-width: 1em; border-radius: 3px;
}
.lane.renaming .title { text-transform: none; letter-spacing: 0; color: var(--ink); text-overflow: clip; }
.lane.found .title { box-shadow: 0 0 0 3px var(--accent); }
.lane .grip {
  position: absolute; right: 4px; bottom: 4px; width: 12px; height: 12px;
  background: linear-gradient(135deg, transparent 0 40%, var(--ink3) 40% 46%, transparent 46% 60%, var(--ink3) 60% 66%, transparent 66% 80%, var(--ink3) 80% 86%, transparent 86%);
}

.card {
  position: absolute; left: 0; top: 0;
  filter: drop-shadow(0 1px 1px rgb(0 0 0 / 0.16));
  transition: transform 0.2s var(--ease), width 0.2s var(--ease), height 0.2s var(--ease);
}
.card.held { transition: none; }
.card.turned, .card.lifted { filter: drop-shadow(0 5px 9px rgb(0 0 0 / 0.24)); }
.card.selected::after, .card.found::after {
  content: ""; position: absolute; inset: -4px; border: 2px solid var(--accent); border-radius: 4px; pointer-events: none;
}
.card.found::after { border-width: 3px; }
.sheet { position: absolute; inset: 0; background: var(--c1); transition: scale 0.15s var(--ease); }
.card.lifted .sheet { scale: 1.03; }
.c1 { background: var(--c1); }
.c2 { background: var(--c2); }
.c3 { background: var(--c3); }
.c4 { background: var(--c4); }
.c5 { background: var(--c5); }
.card.notes .sheet { clip-path: polygon(0 0, 100% 0, 100% calc(100% - 16px), calc(100% - 16px) 100%, 0 100%); }
.card.turned .sheet { clip-path: polygon(0 0, 100% 0, 100% calc(100% - 24px), calc(100% - 24px) 100%, 0 100%); }
.ear { display: none; position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; background: linear-gradient(135deg, rgb(0 0 0 / 0.12) 50%, transparent 50%); }
.card.notes .ear { display: block; }
.card.turned .ear { display: block; width: 24px; height: 24px; }

.front { padding: 12px 16px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ink2); outline: none; }
.front::first-line { font-weight: 600; color: var(--ink); }
.back {
  display: none; position: absolute; inset: 0; padding: 24px;
  background: repeating-linear-gradient(to bottom, transparent 0 23px, var(--hairline) 23px 24px) content-box;
}
.card.turned .front { display: none; }
.card.turned .back { display: block; }
.heading { font-weight: 600; white-space: pre-wrap; overflow-wrap: anywhere; }
.notes { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ink); outline: none; min-height: 24px; }
.notes.placeholder { color: var(--ink3); }
[contenteditable="plaintext-only"] {
  -webkit-user-select: text; user-select: text; -webkit-touch-callout: default; caret-color: var(--accent);
}
.marquee {
  position: absolute; left: 0; top: 0; z-index: 2000000;
  border: 1px solid var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.ghost { pointer-events: none; transition: none; }

button {
  font: inherit; color: var(--ink2); background: none; border: 0; border-radius: 10px;
  min-width: 44px; height: 44px; padding: 0 10px; touch-action: manipulation;
}
button:disabled { color: var(--ink3); }
button svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; vertical-align: middle; }
button .strong, button.strong { font-weight: 600; color: var(--accent); }

#top, #find, #keys, .selection, .menu, .panel {
  background: var(--bar); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px);
}
#top {
  position: fixed; top: 0; left: 0; right: 0; display: flex; align-items: center; gap: 2px;
  padding: env(safe-area-inset-top) 8px 0; border-bottom: 1px solid var(--hairline);
}
#top .zoom { margin: 0 auto; font-variant-numeric: tabular-nums; font-size: 15px; }
#find {
  position: fixed; left: 0; right: 0; top: calc(env(safe-area-inset-top) + 45px);
  display: flex; align-items: center; gap: 2px; padding: 4px 8px; border-bottom: 1px solid var(--hairline);
}
#find input {
  flex: 1; min-width: 0; height: 36px; padding: 0 10px; font: inherit; color: var(--ink);
  background: var(--paper); border: 1px solid var(--hairline); border-radius: 10px;
  -webkit-user-select: text; user-select: text;
}
#find .count { color: var(--ink3); font-size: 15px; font-variant-numeric: tabular-nums; padding: 0 4px; }

#bottom {
  position: fixed; left: 0; right: 0; bottom: 0; display: flex; justify-content: center;
  padding: 8px 12px calc(8px + env(safe-area-inset-bottom)); pointer-events: none;
}
#bottom > * { pointer-events: auto; }
.add { position: relative; }
.plus {
  width: 56px; height: 56px; border-radius: 28px; font-size: 30px; font-weight: 300; line-height: 56px; padding: 0;
  color: var(--paper); background: var(--ink); box-shadow: 0 2px 10px rgb(0 0 0 / 0.2);
}
.menu {
  position: absolute; bottom: 68px; left: 50%; translate: -50% 0; display: flex; flex-direction: column;
  min-width: 160px; border: 1px solid var(--hairline); border-radius: 14px; box-shadow: 0 6px 20px rgb(0 0 0 / 0.16); overflow: hidden;
}
.menu button { color: var(--ink); text-align: left; padding: 0 16px; border-radius: 0; height: 48px; }
.selection { display: flex; align-items: center; padding: 2px 6px; border: 1px solid var(--hairline); border-radius: 16px; box-shadow: 0 4px 14px rgb(0 0 0 / 0.12); }
.swatch { min-width: 38px; width: 38px; padding: 0; }
.swatch i { display: inline-block; width: 26px; height: 26px; border-radius: 13px; border: 1px solid var(--hairline); vertical-align: middle; }

#keys {
  position: fixed; left: 0; right: 0; top: 0; height: 44px; box-sizing: border-box;
  display: flex; justify-content: space-between; padding: 0 8px; border-top: 1px solid var(--hairline);
}

#settings { position: fixed; inset: 0; display: flex; align-items: flex-end; background: rgb(0 0 0 / 0.3); }
.panel { width: 100%; padding: 8px 16px calc(16px + env(safe-area-inset-bottom)); border-radius: 16px 16px 0 0; }
.panel .label { margin: 8px 4px; color: var(--ink3); font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; }
.panel button { display: block; width: 100%; height: auto; padding: 10px 12px; text-align: left; color: var(--ink); }
.panel button span { display: block; color: var(--ink3); font-size: 15px; }
.panel button[aria-pressed="true"] { background: var(--hairline); }
.panel button[aria-pressed="true"] b { color: var(--accent); }
.panel .strong { text-align: center; margin-top: 8px; }

.measure { position: absolute; left: -10000px; top: 0; visibility: hidden; }

@media (prefers-reduced-motion: reduce) {
  .card, .lane, .sheet, .world.glide, #board.glide { transition: none !important; }
}
```

- [ ] **Step 4: Write `web/view.js`**

```js
import * as R from "./rules.js";

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;
export const clampZoom = (z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

const SHEET = '<div class="sheet"><div class="front"></div><div class="back"><div class="heading"></div><div class="notes"></div></div><div class="ear"></div></div>';
const PLACEHOLDER = "Double-tap to write on the back";

/** Draws the board as DOM in a world layer moved by the camera; measures card heights with the same CSS. */
export class View {
  constructor(root, model, state) {
    this.root = root;
    this.model = model;
    this.state = state;
    this.world = root.querySelector(".world");
    this.lanesEl = root.querySelector(".lanes");
    this.cardsEl = root.querySelector(".cards");
    this.marqueeEl = root.querySelector(".marquee");
    const m = document.querySelector(".measure");
    m.innerHTML = `<div class="card">${SHEET}</div><div class="card turned">${SHEET}</div>`;
    [this.mFront, this.mBack] = m.children;
    this.cam = { x: 0, y: 0, zoom: 1 };
    this.els = new Map();
    this.sizes = new Map();
    this.frame = 0;
    this.area = () => ({ top: 0, bottom: innerHeight, left: 0, right: innerWidth });
    this.onCamera = () => {};
    this.heightOf = (id) => {
      const c = R.card(this.model.board, id);
      return c ? this.frontHeight(c.text, c.w) : 0;
    };
    addEventListener("resize", () => this.invalidate());
  }

  /** A trailing newline counts as a line, as the editor shows it. */
  frontHeight(text, w) {
    return this.cached(`f|${w}|${text}`, () => {
      this.mFront.style.width = `${w}px`;
      const f = this.mFront.querySelector(".front");
      f.textContent = !text || text.endsWith("\n") ? text + "​" : text;
      return Math.max(1, Math.ceil((f.offsetHeight - R.GRID) / R.GRID)) * R.GRID + R.GRID;
    });
  }

  backHeight(c, w) {
    const title = c.text.split("\n")[0];
    const notes = c.notes || PLACEHOLDER;
    return this.cached(`b|${w}|${title}|${notes}`, () => {
      this.mBack.style.width = `${w}px`;
      const head = this.mBack.querySelector(".heading");
      const body = this.mBack.querySelector(".notes");
      head.textContent = title || "​";
      body.textContent = notes.endsWith("\n") ? notes + "​" : notes;
      return Math.max(R.BACK_MIN_H, Math.ceil((head.offsetHeight + body.offsetHeight) / R.GRID) * R.GRID + 2 * R.GRID);
    });
  }

  cached(key, measure) {
    let h = this.sizes.get(key);
    if (h === undefined) {
      if (this.sizes.size > 10000) this.sizes.clear();
      h = measure();
      this.sizes.set(key, h);
    }
    return h;
  }

  /** A turned card is 480 wide, or the screen less 32 pt if that is narrower, but never narrower than its front. */
  backWidth() {
    return Math.max(R.CARD_W, Math.min(R.BACK_W, (innerWidth - 32) / this.cam.zoom));
  }

  rectOf(c) {
    if (c.id !== this.state.turned) return R.cardRect(c, this.frontHeight(c.text, c.w));
    const w = this.backWidth();
    return { x: c.x, y: c.y, w, h: this.backHeight(c, w) };
  }

  toWorld(p) {
    const { x, y, zoom } = this.cam;
    return { x: (p.x - x) / zoom, y: (p.y - y) / zoom };
  }

  toScreen(p) {
    const { x, y, zoom } = this.cam;
    return { x: p.x * zoom + x, y: p.y * zoom + y };
  }

  setCamera(cam, animate = false) {
    const zoom = clampZoom(cam.zoom);
    this.cam = { x: cam.x, y: cam.y, zoom };
    this.world.classList.toggle("glide", animate);
    this.root.classList.toggle("glide", animate);
    this.world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${zoom})`;
    const t = R.GRID * zoom;
    this.root.style.backgroundSize = `${t}px ${t}px`;
    this.root.style.backgroundPosition = `${cam.x}px ${cam.y}px`;
    this.root.classList.toggle("no-dots", zoom < 0.4);
    this.onCamera();
  }

  stopGlide() {
    this.world.classList.remove("glide");
    this.root.classList.remove("glide");
  }

  /** Zooms keeping the world point under screen point `c` in place. */
  zoomAround(c, zoom, animate = false) {
    const z = clampZoom(zoom);
    const w = this.toWorld(c);
    this.setCamera({ x: c.x - w.x * z, y: c.y - w.y * z, zoom: z }, animate);
  }

  centre() {
    const a = this.area();
    return { x: (a.left + a.right) / 2, y: (a.top + a.bottom) / 2 };
  }

  /** Pans the least needed to show world rect `r`; a rect too tall to fit shows its `prefer` edge. */
  reveal(r, prefer = "top") {
    const a = this.area();
    const pad = 16;
    const { zoom } = this.cam;
    let { x, y } = this.cam;
    const s = this.toScreen(r);
    const w = r.w * zoom;
    const h = r.h * zoom;
    if (w + 2 * pad > a.right - a.left || s.x < a.left + pad) x += a.left + pad - s.x;
    else if (s.x + w > a.right - pad) x += a.right - pad - (s.x + w);
    if (h + 2 * pad > a.bottom - a.top) y += prefer === "bottom" ? a.bottom - pad - (s.y + h) : a.top + pad - s.y;
    else if (s.y < a.top + pad) y += a.top + pad - s.y;
    else if (s.y + h > a.bottom - pad) y += a.bottom - pad - (s.y + h);
    if (x !== this.cam.x || y !== this.cam.y) this.setCamera({ x, y, zoom }, true);
  }

  centreOn(r) {
    const c = this.centre();
    const { zoom } = this.cam;
    this.setCamera({ zoom, x: c.x - (r.x + r.w / 2) * zoom, y: c.y - (r.y + r.h / 2) * zoom }, true);
  }

  invalidate() {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.render());
  }

  render() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    const b = this.model.board;
    const live = new Set();
    for (const l of b.lanes) {
      live.add(l.id);
      this.renderLane(l);
    }
    b.cards.forEach((c, i) => {
      live.add(c.id);
      this.renderCard(c, i);
    });
    for (const [id, e] of this.els) {
      if (live.has(id)) continue;
      e.el.remove();
      this.els.delete(id);
    }
    const m = this.state.marquee;
    this.marqueeEl.hidden = !m;
    if (m) Object.assign(this.marqueeEl.style, { transform: `translate(${m.x}px, ${m.y}px)`, width: `${m.w}px`, height: `${m.h}px` });
  }

  element(id, parent, html) {
    let e = this.els.get(id);
    if (!e) {
      const el = document.createElement("div");
      el.innerHTML = html;
      parent.append(el);
      e = { el, key: "" };
      this.els.set(id, e);
    }
    return e;
  }

  renderCard(c, i) {
    const s = this.state;
    const editing = s.editing?.id === c.id ? s.editing : null;
    const turned = s.turned === c.id;
    const r = this.rectOf(c);
    const flags = ["card", c.notes && "notes", turned && "turned", s.selection.has(c.id) && "selected", s.held.has(c.id) && "held",
      s.lifted.has(c.id) && "lifted", s.found === c.id && "found", editing && "editing"].filter(Boolean).join(" ");
    const e = this.element(c.id, this.cardsEl, SHEET);
    const key = JSON.stringify([flags, c.x, c.y, r.w, r.h, c.color, c.text, c.notes, i]);
    if (e.key === key) return;
    e.key = key;
    const el = e.el;
    el.className = flags;
    el.style.transform = `translate(${c.x}px, ${c.y}px)`;
    el.style.width = `${r.w}px`;
    el.style.height = `${r.h}px`;
    el.style.zIndex = turned || s.lifted.has(c.id) ? 1000000 : i;
    const sheet = el.firstChild;
    sheet.className = `sheet c${c.color}`;
    const [front, back] = sheet.children;
    const [heading, notes] = back.children;
    if (!editing || editing.back) front.textContent = c.text;
    heading.textContent = c.text.split("\n")[0];
    if (!editing || !editing.back) {
      notes.textContent = c.notes || PLACEHOLDER;
      notes.classList.toggle("placeholder", !c.notes);
    }
  }

  renderLane(l) {
    const s = this.state;
    const renaming = s.renaming === l.id;
    const flags = ["lane", s.selection.has(l.id) && "selected", s.held.has(l.id) && "held", s.found === l.id && "found",
      renaming && "renaming"].filter(Boolean).join(" ");
    const e = this.element(l.id, this.lanesEl, '<div class="header"><div class="title"></div></div><div class="grip"></div>');
    const key = JSON.stringify([flags, l.x, l.y, l.w, l.h, l.title]);
    if (e.key === key) return;
    e.key = key;
    const el = e.el;
    el.className = flags;
    el.style.transform = `translate(${l.x}px, ${l.y}px)`;
    el.style.width = `${l.w}px`;
    el.style.height = `${l.h}px`;
    if (!renaming) el.querySelector(".title").textContent = l.title;
  }

  editorOf(id, back) {
    return this.els.get(id)?.el.querySelector(back ? ".notes" : ".front");
  }

  titleOf(id) {
    return this.els.get(id)?.el.querySelector(".title");
  }

  /** Runs `change` at once and renders; copies of the old faces swing away while the new ones swing in. */
  animateTurn(ids, change) {
    const animate = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ghosts = animate
      ? ids.map((id) => this.els.get(id)?.el).filter(Boolean).map((el) => {
          const g = el.cloneNode(true);
          g.classList.add("ghost");
          g.style.zIndex = 1000001;
          this.cardsEl.append(g);
          return g;
        })
      : [];
    change();
    this.render();
    if (!animate) return;
    const p = "perspective(1000px) ";
    for (const g of ghosts) {
      g.firstChild
        .animate([{ transform: `${p}rotateY(0deg)` }, { transform: `${p}rotateY(90deg)` }], { duration: 130, easing: "ease-in", fill: "forwards" })
        .finished.then(() => g.remove());
    }
    for (const id of ids) {
      this.els.get(id)?.el.firstChild.animate([{ transform: `${p}rotateY(-90deg)` }, { transform: `${p}rotateY(0deg)` }],
        { duration: 130, delay: 130, easing: "ease-out", fill: "backwards" });
    }
  }
}
```

- [ ] **Step 5: Write `web/sample.js`**

```js
const lane = (id, x, title) => ({ id, x, y: 0, w: 288, h: 720, title });

function card(id, laneX, order, text, color, notes) {
  return { id, x: laneX + 24, y: 72 + order * 96, w: 240, text, color, ...(notes ? { notes } : {}) };
}

export function sampleBoard() {
  return {
    lanes: [lane("l-todo", 0, "To do"), lane("l-doing", 336, "Doing"), lane("l-done", 672, "Done")],
    cards: [
      card("c-offsite", 0, 0, "Plan the offsite\nVenue, dates, budget", 1, "Ask about the place in Lisbon.\nKeep it under 40 people.\nBudget sign-off by the 20th."),
      card("c-hiring", 0, 1, "Review the hiring loop", 3),
      card("c-goals", 0, 2, "Write Q4 goals\nDraft before Friday", 1),
      card("c-flaky", 0, 3, "Fix the flaky login test", 2),
      card("c-dentist", 0, 4, "Book the dentist", 5),
      card("c-proto", 336, 0, "Touch prototype\nOne finger or two?", 4, "Try each pan mode for a day.\nNote what feels wrong."),
      card("c-relnotes", 336, 1, "Release notes 2.3", 1),
      card("c-interview", 336, 2, "Interview: backend role\nThursday 14:00", 3),
      card("c-search", 672, 0, "Ship search", 4),
      card("c-ci", 672, 1, "Migrate CI", 4),
      card("c-retro", 672, 2, "Team retro", 5),
      { id: "c-ideas", x: 1008, y: 72, w: 240, text: "Ideas\nArrows between cards?\nImages?", color: 5 },
      { id: "c-pinch", x: 1008, y: 216, w: 240, text: "Pinch to zoom, hold to lift", color: 1 },
      { id: "c-rams", x: 1008, y: 312, w: 240, text: "Read: Less but better", color: 3, notes: "Ten principles.\nGood design is as little design as possible." },
    ],
  };
}

function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 500 cards: ten lanes of 30 and 200 loose, as scripts/make-stress-board.py makes for the Mac. */
export function stressBoard() {
  const r = random(1);
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = (a) => a[Math.floor(r() * a.length)];
  const words = "Kafka Task Matches Interview Firms View Training Trip Plan Review Budget Sprint Client Offer Release Bug Idea".split(" ");
  const phrase = (n) => Array.from({ length: n }, () => pick(words)).join(" ");
  const lanes = [];
  const cards = [];
  for (let l = 0; l < 10; l++) {
    lanes.push({ id: `l${l}`, x: l * 504, y: 0, w: 288, h: 2400, title: `Lane ${l}` });
    let y = 72;
    for (let k = 0; k < 30; k++) {
      const n = pick([1, 1, 2, 3, 4]);
      const text = Array.from({ length: n }, () => phrase(int(1, 3))).join("\n");
      cards.push({ id: `c${l}_${k}`, x: l * 504 + 24, y, w: 240, text, color: int(1, 5) });
      y += (n + 1) * 24 + 24;
    }
  }
  for (let k = 0; k < 200; k++) {
    cards.push({ id: `f${k}`, x: int(-100, 99) * 24, y: int(110, 199) * 24, w: 240, text: phrase(3), color: int(1, 5) });
  }
  return { cards, lanes };
}
```

- [ ] **Step 6: Write a first `web/main.js` that only renders**

```js
import * as R from "./rules.js";
import { Model } from "./model.js";
import { View } from "./view.js";
import { sampleBoard, stressBoard } from "./sample.js";

const params = new URLSearchParams(location.search);
const state = { selection: new Set(), turned: null, editing: null, renaming: null, held: new Set(), lifted: new Set(), marquee: null, found: null };
const model = new Model(params.has("stress") ? stressBoard() : sampleBoard());
const view = new View(document.getElementById("board"), model, state);
R.gravity(model.board, view.heightOf);
view.setCamera({ x: 16, y: document.getElementById("top").getBoundingClientRect().bottom + 16, zoom: 0.75 });
if (params.get("demo") === "turn") state.turned = "c-offsite";
if (params.get("demo") === "select") state.selection = new Set(["c-offsite"]);
view.render();
```

- [ ] **Step 7: Look at it in the iOS Simulator**

```bash
python3 -m http.server --directory web 8000    # in the background
xcrun simctl boot "iPhone 17" 2>/dev/null; open -a Simulator
xcrun simctl openurl booted "http://localhost:8000/"
# wait about 3 s for the page, then:
xcrun simctl io booted screenshot "$SCRATCH/t5-board.png"
xcrun simctl openurl booted "http://localhost:8000/?demo=turn"
xcrun simctl io booted screenshot "$SCRATCH/t5-turn.png"
xcrun simctl ui booted appearance dark
xcrun simctl openurl booted "http://localhost:8000/?demo=select"
xcrun simctl io booted screenshot "$SCRATCH/t5-dark.png"
xcrun simctl ui booted appearance light
```

Open each screenshot. Expected:
- **Board:** three lanes with spaced capital titles and a hairline under each header. Cards are stacked a grid line apart. The first line of each card is semibold. The dot grid shows. Cards with notes show a folded corner. The top bar and the **+** button sit inside the safe areas.
- **Turned card:** the offsite card is wider, with ruled lines and the heading, above the others.
- **Dark mode:** dark paper and dark card tints, with an orange selection ring around the offsite card.

Fix anything that differs before committing.

- [ ] **Step 8: Commit**

```bash
git add web/index.html web/style.css web/manifest.webmanifest web/view.js web/sample.js web/main.js web/icon-180.png web/icon-512.png scripts/make-web-icons.swift
git commit -m "Render the touch prototype's board" -m "Claude-Session: https://claude.ai/code/session_01AuzxPWNihavyhjJd1EQqtU"
```

---

### Task 6: Interaction — gestures, editing, bars, search, settings

**Files:**
- Create: `web/app.js`, `web/input.js`, `web/ui.js`
- Modify: `web/main.js` (replace entirely)

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces:
  - `class App(board)` with:
    - Parts and state: `state`, `model`, `view`, `ui`, `input`, `mode`, `heightOf`.
    - Selection: `selectedCards()`, `selectedLanes()`, `select(ids)`, `toggle(id)`, `takePile()`.
    - Cards and lanes: `turn(id|null)`, `newCard(worldPoint)`, `newLane()`, `colour(n)`, `removeSelection()`.
    - Editing: `beginEdit(id, name?)`, `edited()`, `endEditing()`, `switchSide()`, `beginRename(id)`, `revealEditing()`.
    - History and search: `undo()`, `redo()`, `reveal(match)`.
  - `class Input(app)` implements every `Gestures` handler method plus `touchStart()`.
  - `class UI(app)` with `mode`, `act(name, button)`, `update()`, `updateZoom()`, `area()`, `place()`, `closeMenu()`, `openFind()`, `closeFind()`, `find(q)`, `step(d)`, `openSettings()`.

- [ ] **Step 1: Write `web/app.js`**

```js
import * as R from "./rules.js";
import { Model } from "./model.js";
import { View } from "./view.js";
import { UI } from "./ui.js";
import { Input } from "./input.js";

function caretToEnd(el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
}

/** The board, what is selected, turned and being edited, and every action on them. */
export class App {
  constructor(board) {
    this.state = { selection: new Set(), turned: null, editing: null, renaming: null, held: new Set(), lifted: new Set(), marquee: null, found: null };
    this.switching = false;
    this.model = new Model(board);
    this.view = new View(document.getElementById("board"), this.model, this.state);
    R.gravity(this.model.board, this.view.heightOf);
    this.ui = new UI(this);
    this.input = new Input(this);
    this.view.area = () => this.ui.area();
    this.view.onCamera = () => {
      this.ui.updateZoom();
      if (this.state.turned) this.view.invalidate();
    };
    this.model.onChange = () => {
      this.view.invalidate();
      this.ui.update();
    };
  }

  get mode() {
    return this.ui.mode;
  }

  get heightOf() {
    return this.view.heightOf;
  }

  selectedCards() {
    return this.model.board.cards.filter((c) => this.state.selection.has(c.id));
  }

  selectedLanes() {
    return this.model.board.lanes.filter((l) => this.state.selection.has(l.id));
  }

  select(ids) {
    this.state.selection = new Set(ids);
    this.view.invalidate();
    this.ui.update();
  }

  toggle(id) {
    const s = new Set(this.state.selection);
    if (!s.delete(id)) s.add(id);
    this.select(s);
  }

  /** Turns card `id` over, putting back the one turned before; null just puts it back. */
  turn(id) {
    const s = this.state;
    const next = id && R.card(this.model.board, id) ? id : null;
    if (next === s.turned) return;
    this.view.animateTurn([s.turned, next].filter(Boolean), () => (s.turned = next));
    if (next) this.view.reveal(this.view.rectOf(R.card(this.model.board, next)));
    this.ui.update();
  }

  newCard(w) {
    this.endEditing();
    this.turn(null);
    this.model.begin();
    let id;
    this.model.update((b) => {
      id = R.addCard(b, w.x - R.CARD_W / 2, w.y - R.GRID);
      R.gravity(b, this.heightOf);
    });
    this.select([id]);
    this.beginEdit(id, "New Card");
  }

  newLane() {
    this.endEditing();
    const p = this.view.toWorld(this.view.centre());
    let id;
    this.model.perform("New Lane", (b) => {
      id = R.addLane(b, p.x - R.LANE_W / 2, p.y - R.LANE_H / 2);
      R.gravity(b, this.heightOf);
    });
    this.select([id]);
  }

  /** Edits the side of card `id` facing up; focus stays synchronous so iOS shows the keyboard. */
  beginEdit(id, name = "Edit Card") {
    const c = R.card(this.model.board, id);
    if (!c) return;
    this.endEditing();
    this.model.begin();
    const back = this.state.turned === id;
    this.state.editing = { id, back, name };
    this.view.render();
    const el = this.view.editorOf(id, back);
    el.textContent = back ? (c.notes ?? "") : c.text;
    el.classList.remove("placeholder");
    el.contentEditable = "plaintext-only";
    el.oninput = () => this.edited();
    el.onblur = () => {
      if (!this.switching) this.endEditing();
    };
    el.focus({ preventScroll: true });
    caretToEnd(el);
    if (this.view.cam.zoom < 1) this.view.zoomAround(this.view.toScreen({ x: c.x + c.w / 2, y: c.y }), 1, true);
    this.ui.update();
    this.revealEditing();
  }

  edited() {
    const e = this.state.editing;
    if (!e) return;
    const raw = this.view.editorOf(e.id, e.back).innerText.replace(/​/g, "");
    const text = raw === "\n" ? "" : raw;
    this.model.update((b) => {
      if (e.back) return R.setNotes(b, e.id, text);
      R.setText(b, e.id, text);
      R.gravity(b, this.heightOf);
    });
    this.revealEditing();
  }

  /** Ends the card edit or lane rename in progress, if any. */
  endEditing() {
    const s = this.state;
    if (s.renaming) {
      const id = s.renaming;
      s.renaming = null;
      const el = this.view.titleOf(id);
      const title = el?.textContent.trim() || "Lane";
      if (el) {
        el.onblur = el.oninput = el.onkeydown = null;
        el.blur();
        el.contentEditable = "false";
      }
      this.model.update((b) => R.setLaneTitle(b, id, title));
      this.model.end("Rename Lane");
    }
    const e = s.editing;
    if (e) {
      s.editing = null;
      const el = this.view.editorOf(e.id, e.back);
      if (el) {
        el.onblur = el.oninput = null;
        el.blur();
        el.contentEditable = "false";
      }
      this.model.update((b) => {
        R.finishEdit(b, e.id);
        R.gravity(b, this.heightOf);
      });
      this.model.end(e.name);
    }
    this.ui.update();
  }

  /** Turn while editing: turns the card and goes on editing the other side, in the same undo step. */
  switchSide() {
    const e = this.state.editing;
    if (!e) return;
    this.switching = true;
    const old = this.view.editorOf(e.id, e.back);
    old.oninput = old.onblur = null;
    this.state.editing = null;
    this.turn(e.back ? null : e.id);
    this.beginEdit(e.id, e.name);
    old.contentEditable = "false";
    this.switching = false;
  }

  beginRename(id) {
    const l = R.lane(this.model.board, id);
    if (!l) return;
    this.endEditing();
    this.model.begin();
    this.state.renaming = id;
    this.view.render();
    const el = this.view.titleOf(id);
    el.textContent = l.title;
    el.contentEditable = "plaintext-only";
    el.oninput = () => this.model.update((b) => R.setLaneTitle(b, id, el.textContent));
    el.onkeydown = (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      this.endEditing();
    };
    el.onblur = () => this.endEditing();
    el.focus({ preventScroll: true });
    caretToEnd(el);
    this.ui.update();
  }

  revealEditing() {
    const e = this.state.editing;
    const c = e && R.card(this.model.board, e.id);
    if (c) this.view.reveal(this.view.rectOf(c), "bottom");
  }

  colour(n) {
    this.model.perform("Colour", (b) => R.setColor(b, this.state.selection, n));
  }

  removeSelection() {
    const ids = new Set(this.state.selection);
    if (ids.has(this.state.turned)) this.state.turned = null;
    this.model.perform("Delete", (b) => {
      R.remove(b, ids);
      R.gravity(b, this.heightOf);
    });
    this.select([]);
  }

  /** Pile: the selected lane card and those below it, so the next drag moves them as a block. */
  takePile() {
    const [c] = this.selectedCards();
    if (c) this.select(R.pile(this.model.board, c.id, this.heightOf));
  }

  undo() {
    this.endEditing();
    this.model.undo();
  }

  redo() {
    this.endEditing();
    this.model.redo();
  }

  /** Shows search match `m`, turning a card over for a match on its back. */
  reveal(m) {
    const s = this.state;
    const b = this.model.board;
    s.found = m.id;
    const c = R.card(b, m.id);
    if (c) this.turn(m.side === "back" ? m.id : s.turned === m.id ? null : s.turned);
    const l = !c && R.lane(b, m.id);
    if (c || l) this.view.centreOn(c ? this.view.rectOf(c) : R.laneRect(l));
    this.view.invalidate();
  }
}
```

- [ ] **Step 2: Write `web/input.js`**

```js
import * as R from "./rules.js";
import { hitTest, dragAction } from "./policy.js";
import { clampZoom } from "./view.js";

const EDGE = 48;
const EDGE_SPEED = 12;
const FRICTION = 0.95;

const isCard = (h) => h?.kind === "card" || h?.kind === "fold";

/** Turns gestures into camera moves and board changes, by pan mode. */
export class Input {
  constructor(app) {
    this.app = app;
    this.drag = null;
    this.pinchBase = null;
    this.holdHit = null;
    this.coast = 0;
    this.scroll = 0;
  }

  hit(p) {
    const { view, state, model } = this.app;
    return hitTest(model.board, view.toWorld(p), { rectOf: (c) => view.rectOf(c), zoom: view.cam.zoom, turned: state.turned });
  }

  touchStart() {
    this.stopCoast();
    this.app.view.stopGlide();
    this.app.ui.closeMenu();
  }

  tap(p) {
    const app = this.app;
    const s = app.state;
    const h = this.hit(p);
    if (s.editing && s.editing.id === h.id) return;
    app.endEditing();
    if (h.kind === "fold") {
      app.select([h.id]);
      return app.turn(s.turned === h.id ? null : h.id);
    }
    if (s.turned && h.id !== s.turned) app.turn(null);
    app.select(h.kind === "empty" ? [] : [h.id]);
  }

  doubleTap(p) {
    const app = this.app;
    const h = this.hit(p);
    if (isCard(h)) return app.beginEdit(h.id);
    if (h.kind === "header") return app.beginRename(h.id);
    if (h.kind === "empty") app.newCard(app.view.toWorld(p));
  }

  hold(p) {
    this.holdHit = this.hit(p);
    if (!isCard(this.holdHit)) return;
    this.app.state.lifted = new Set([this.holdHit.id]);
    this.app.view.invalidate();
  }

  /** Lifting a held card without moving it adds it to the selection or takes it out. */
  holdEnd() {
    const h = this.holdHit;
    this.holdHit = null;
    this.app.state.lifted = new Set();
    if (isCard(h)) this.app.toggle(h.id);
    this.app.view.invalidate();
  }

  holdCancel() {
    this.holdHit = null;
    this.app.state.lifted = new Set();
    this.app.view.invalidate();
  }

  dragStart(p0, p, held) {
    const app = this.app;
    const s = app.state;
    const b = app.model.board;
    const h = held && this.holdHit ? this.holdHit : this.hit(p0);
    this.holdHit = null;
    const action = dragAction(app.mode, h, s.selection, held);
    if (action !== "pan") {
      app.endEditing();
      if (s.turned && h.id !== s.turned) app.turn(null);
    }
    const d = { action, id: h.id, p0, w0: app.view.toWorld(p0), cam0: { ...app.view.cam }, last: p };
    this.drag = d;
    if (action === "move") {
      if (!s.selection.has(h.id)) app.select([h.id]);
      const ids = new Set(app.selectedCards().map((c) => c.id));
      d.origins = app.selectedCards().map((c) => ({ id: c.id, x: c.x, y: c.y }));
      d.room = { base: R.layout(b, ids), heightOf: app.heightOf };
      s.held = new Set(ids);
      s.lifted = new Set(ids);
      app.model.begin();
    } else if (action === "lane") {
      app.select([h.id]);
      const l = R.lane(b, h.id);
      d.laneOrigin = { id: l.id, x: l.x, y: l.y };
      d.origins = R.cardsInLane(b, h.id, app.heightOf).map((c) => ({ id: c.id, x: c.x, y: c.y }));
      s.held = new Set([h.id, ...d.origins.map((o) => o.id)]);
      app.model.begin();
    } else if (action === "resize") {
      app.select([h.id]);
      const l = R.lane(b, h.id);
      d.size = { w: l.w, h: l.h };
      s.held = new Set([h.id]);
      app.model.begin();
    } else if (action === "marquee") {
      app.select([]);
    }
    this.dragMove(p);
  }

  dragMove(p) {
    const d = this.drag;
    if (!d) return;
    d.last = p;
    const app = this.app;
    if (d.action === "pan") {
      app.view.setCamera({ ...d.cam0, x: d.cam0.x + p.x - d.p0.x, y: d.cam0.y + p.y - d.p0.y });
      return;
    }
    const w = app.view.toWorld(p);
    const dx = w.x - d.w0.x;
    const dy = w.y - d.w0.y;
    if (d.action === "move") app.model.update((b) => R.moveCards(b, d.origins, dx, dy, d.room));
    if (d.action === "lane") app.model.update((b) => R.moveLane(b, d.laneOrigin, d.origins, dx, dy));
    if (d.action === "resize") app.model.update((b) => R.resizeLane(b, d.id, d.size.w + dx, d.size.h + dy));
    if (d.action === "marquee") {
      const r = { x: Math.min(d.w0.x, w.x), y: Math.min(d.w0.y, w.y), w: Math.abs(dx), h: Math.abs(dy) };
      app.state.marquee = r;
      app.select(R.cardsInRect(app.model.board, r, app.heightOf).map((c) => c.id));
    }
    this.edgeScroll(p);
  }

  dragEnd(p, v) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    cancelAnimationFrame(this.scroll);
    const app = this.app;
    const s = app.state;
    s.held = new Set();
    s.lifted = new Set();
    if (d.action === "pan") this.coastFrom(v);
    if (d.action === "move") {
      app.model.update((b) => R.land(b, new Set(d.origins.map((o) => o.id)), d.room));
      app.model.end("Move");
    }
    if (d.action === "lane") app.model.end("Move Lane");
    if (d.action === "resize") app.model.end("Resize Lane");
    if (d.action === "marquee") s.marquee = null;
    app.view.invalidate();
  }

  pinchStart(c) {
    this.stopCoast();
    this.pinchBase = { cam: { ...this.app.view.cam }, c };
  }

  /** Zooms and pans together: the world point first under the fingers stays under them. */
  pinch(c, scale) {
    const { cam, c: c0 } = this.pinchBase;
    const zoom = clampZoom(cam.zoom * scale);
    const wx = (c0.x - cam.x) / cam.zoom;
    const wy = (c0.y - cam.y) / cam.zoom;
    this.app.view.setCamera({ zoom, x: c.x - wx * zoom, y: c.y - wy * zoom });
  }

  pinchEnd(v) {
    this.pinchBase = null;
    this.coastFrom(v);
  }

  /** Near the edge of the visible area a drag scrolls the board, faster the closer it gets. */
  edgeScroll(p) {
    cancelAnimationFrame(this.scroll);
    const a = this.app.ui.area();
    const speed = (v, lo, hi) =>
      v < lo + EDGE ? Math.min(1, (lo + EDGE - v) / EDGE) : v > hi - EDGE ? -Math.min(1, (v - hi + EDGE) / EDGE) : 0;
    const sx = speed(p.x, a.left, a.right) * EDGE_SPEED;
    const sy = speed(p.y, a.top, a.bottom) * EDGE_SPEED;
    if (!sx && !sy) return;
    this.scroll = requestAnimationFrame(() => {
      if (!this.drag) return;
      const c = this.app.view.cam;
      this.app.view.setCamera({ ...c, x: c.x + sx, y: c.y + sy });
      this.dragMove(this.drag.last);
    });
  }

  coastFrom(v) {
    let vx = v.x;
    let vy = v.y;
    let t0 = performance.now();
    const step = (t) => {
      const dt = Math.min(t - t0, 32);
      t0 = t;
      if (Math.hypot(vx, vy) < 0.02) return (this.coast = 0);
      const c = this.app.view.cam;
      this.app.view.setCamera({ ...c, x: c.x + vx * dt, y: c.y + vy * dt });
      const f = Math.pow(FRICTION, dt / 16);
      vx *= f;
      vy *= f;
      this.coast = requestAnimationFrame(step);
    };
    this.coast = requestAnimationFrame(step);
  }

  stopCoast() {
    cancelAnimationFrame(this.coast);
    this.coast = 0;
  }
}
```

- [ ] **Step 3: Write `web/ui.js`**

```js
import * as R from "./rules.js";

const MODE_KEY = "breezy.panMode";
const KEYS_H = 44;

function loadMode() {
  try {
    return localStorage.getItem(MODE_KEY);
  } catch {
    return null;
  }
}

function saveMode(mode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {}
}

/** Acts on `touchend` and cancels it, so the tap takes no focus from the editor. */
function press(el, fn) {
  el.addEventListener("touchend", (e) => {
    e.preventDefault();
    if (!el.disabled) fn();
  });
  el.addEventListener("click", () => {
    if (!el.disabled) fn();
  });
}

/** The bars around the board: top, find, add and selection, keyboard and settings. */
export class UI {
  constructor(app) {
    this.app = app;
    this.mode = loadMode() === "two" ? "two" : "one";
    this.matches = [];
    this.index = -1;
    this.$ = (sel) => document.querySelector(sel);
    for (const b of document.querySelectorAll("[data-act]")) press(b, () => this.act(b.dataset.act, b));
    const field = this.$("#find input");
    field.addEventListener("input", () => this.find(field.value));
    field.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      this.step(1);
    });
    visualViewport.addEventListener("resize", () => {
      this.place();
      this.app.revealEditing();
    });
    visualViewport.addEventListener("scroll", () => this.place());
    this.update();
  }

  act(name, b) {
    const app = this.app;
    switch (name) {
      case "undo": return app.undo();
      case "redo": return app.redo();
      case "zoom": return app.view.zoomAround(app.view.centre(), 1, true);
      case "search": return this.openFind();
      case "settings": return this.openSettings();
      case "add": this.$(".menu").hidden = !this.$(".menu").hidden; return;
      case "new-card": this.closeMenu(); return app.newCard(app.view.toWorld(app.view.centre()));
      case "new-lane": this.closeMenu(); return app.newLane();
      case "colour": return app.colour(Number(b.dataset.colour));
      case "turn": {
        const [c] = app.selectedCards();
        return c && app.turn(app.state.turned === c.id ? null : c.id);
      }
      case "pile": return app.takePile();
      case "delete": return app.removeSelection();
      case "key-turn": return app.switchSide();
      case "key-done": return app.endEditing();
      case "prev": return this.step(-1);
      case "next": return this.step(1);
      case "close-find": return this.closeFind();
      case "mode":
        this.mode = b.dataset.mode;
        saveMode(this.mode);
        return this.update();
      case "close-settings": this.$("#settings").hidden = true; return;
    }
  }

  update() {
    const app = this.app;
    const s = app.state;
    const cards = app.selectedCards();
    const lanes = app.selectedLanes();
    const typing = !!(s.editing || s.renaming);
    this.$('[data-act="undo"]').disabled = !(app.model.canUndo || app.model.inGesture);
    this.$('[data-act="redo"]').disabled = !app.model.canRedo;
    this.$("#bottom").hidden = typing;
    const selecting = cards.length + lanes.length > 0;
    this.$("#bottom .selection").hidden = !selecting;
    this.$("#bottom .add").hidden = selecting;
    for (const sw of document.querySelectorAll(".swatch")) sw.hidden = !cards.length;
    const one = cards.length === 1 && !lanes.length ? cards[0] : null;
    this.$('[data-act="turn"]').hidden = !one;
    this.$('[data-act="pile"]').hidden = !(one && R.laneOf(app.model.board, one.id, app.heightOf));
    this.$("#keys").hidden = !s.editing;
    for (const m of document.querySelectorAll('[data-act="mode"]')) m.setAttribute("aria-pressed", String(m.dataset.mode === this.mode));
    this.place();
    this.updateZoom();
  }

  updateZoom() {
    this.$('[data-act="zoom"]').textContent = `${Math.round(this.app.view.cam.zoom * 100)} %`;
  }

  /** Puts the keyboard bar on the keyboard, wherever iOS has moved the visual viewport. */
  place() {
    const vv = visualViewport;
    this.$("#keys").style.top = `${vv.offsetTop + vv.height - KEYS_H}px`;
  }

  /** The part of the screen the board shows through, between the bars and above the keyboard. */
  area() {
    const vv = visualViewport;
    const above = this.$("#find").hidden ? this.$("#top") : this.$("#find");
    const keyboard = vv.height < innerHeight - 100;
    const bottom = keyboard
      ? vv.offsetTop + vv.height - (this.app.state.editing ? KEYS_H : 0)
      : this.$("#bottom").getBoundingClientRect().top;
    return { top: above.getBoundingClientRect().bottom, bottom, left: 0, right: innerWidth };
  }

  closeMenu() {
    this.$(".menu").hidden = true;
  }

  openSettings() {
    this.$("#settings").hidden = false;
    this.update();
  }

  openFind() {
    this.$("#find").hidden = false;
    const field = this.$("#find input");
    field.focus();
    field.select();
    this.find(field.value);
  }

  closeFind() {
    this.$("#find").hidden = true;
    this.$("#find input").blur();
    this.matches = [];
    this.app.state.found = null;
    this.app.view.invalidate();
  }

  find(q) {
    this.matches = R.search(this.app.model.board, q);
    this.index = -1;
    this.$("#find .count").textContent = q.trim() ? "0" : "";
    if (this.matches.length) return this.step(1);
    this.app.state.found = null;
    this.app.view.invalidate();
  }

  step(d) {
    const n = this.matches.length;
    if (!n) return;
    this.index = (this.index + d + n) % n;
    this.$("#find .count").textContent = `${this.index + 1}/${n}`;
    this.app.reveal(this.matches[this.index]);
  }
}
```

- [ ] **Step 4: Replace `web/main.js`**

```js
import { App } from "./app.js";
import { Gestures, HOLD_MS } from "./gestures.js";
import { sampleBoard, stressBoard } from "./sample.js";

const params = new URLSearchParams(location.search);
const app = new App(params.has("stress") ? stressBoard() : sampleBoard());
app.view.setCamera({ x: 16, y: app.ui.area().top + 16, zoom: 0.75 });
app.view.render();

const gestures = new Gestures(app.input);
document.getElementById("board").addEventListener("pointerdown", (e) => {
  if (e.target.closest('[contenteditable="plaintext-only"]')) return;
  app.input.touchStart();
  gestures.down(e.pointerId, e.clientX, e.clientY, e.timeStamp);
  setTimeout(() => gestures.tick(performance.now()), HOLD_MS + 10);
});
addEventListener("pointermove", (e) => gestures.move(e.pointerId, e.clientX, e.clientY, e.timeStamp));
addEventListener("pointerup", (e) => gestures.up(e.pointerId, e.clientX, e.clientY, e.timeStamp));
addEventListener("pointercancel", (e) => gestures.cancel(e.pointerId));
for (const type of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(type, (e) => e.preventDefault());

// States for screenshots, since the Simulator cannot be driven by touch from the command line.
const demo = params.get("demo");
const id = "c-offsite";
if (demo === "select") app.select([id]);
if (demo === "turn") {
  app.select([id]);
  app.turn(id);
}
if (demo === "edit") app.beginEdit(id);
if (demo === "lift") {
  app.state.lifted = new Set([id]);
  app.select([id]);
}
if (demo === "find") {
  app.ui.openFind();
  document.querySelector("#find input").value = "plan";
  app.ui.find("plan");
}
if (demo === "settings") app.ui.openSettings();
if (demo === "add") app.ui.act("add");
```

- [ ] **Step 5: Run the unit tests**

Run: `node --test web/test/*.test.js`
Expected: PASS, 50 tests (no test changes; this confirms nothing pure broke).

- [ ] **Step 6: Smoke-test in a desktop browser**

With the server running, open `http://localhost:8000/` in Chrome. Use claude-in-chrome if it's available; otherwise ask the user to do it. A mouse acts as one finger. Check the following, and that the console shows no errors:
- **New card:** double-click empty space. A card appears, ready to type. Type `Hello`, then press Done in the keyboard bar. The card stays, with `Hello` in semibold.
- **Move:** click a lane card, then drag it. It moves at once, and the others make room.
- **Pan:** drag empty space. The board pans with momentum (in one-finger mode).
- **Two-finger mode:** in ⋯, choose Two fingers pan. Dragging empty space now draws a selection box. Reload, and the mode is still set.
- **Undo:** undo and redo step back and forth through these changes.

- [ ] **Step 7: Screenshots in the iOS Simulator**

For each of `?demo=select`, `?demo=turn`, `?demo=edit`, `?demo=lift`, `?demo=find`, `?demo=settings` and `?demo=add`, run `xcrun simctl openurl booted "http://localhost:8000/?demo=…"`. Wait about 3 s, take a screenshot into `$SCRATCH`, and open it. Expected:
- **select:** the selection bar shows five swatches, Turn, Pile and Delete, and fits the screen width.
- **turn:** the back is at most the screen width minus 32 pt.
- **edit:** the keyboard bar is visible and the bottom bar is hidden. (The Simulator may not show a software keyboard.)
- **lift:** the card is slightly larger, with a deeper shadow.
- **find:** the field shows `1/2`, and the offsite card is centred with an orange ring.
- **settings:** a sheet with the two modes, One finger pans marked.
- **add:** the Card/Lane menu sits above the **+** button.

Fix anything that differs.

- [ ] **Step 8: Commit**

```bash
git add web/app.js web/input.js web/ui.js web/main.js
git commit -m "Make the touch prototype respond to touch, with two pan modes" -m "Claude-Session: https://claude.ai/code/session_01AuzxPWNihavyhjJd1EQqtU"
```

---

### Task 7: README and the hand-over on a real iPhone

**Files:**
- Modify: `README.md` (add a section after "Develop")

- [ ] **Step 1: Add the README section**

Append to `README.md`:

````markdown
## Touch prototype

`web/` is a touch version for trying Breezy's interaction on an iPhone. It keeps nothing: reloading starts from the sample board, `?stress` loads 500 cards.

```bash
python3 -m http.server --directory web 8000
```

On the iPhone, on the same Wi-Fi, open `http://<the Mac's address>:8000` in Safari and Add to Home Screen. ⋯ switches between one-finger and two-finger panning. `node --test web/test/*.test.js` runs its tests; `swift scripts/make-web-icons.swift web` redraws its icons.
````

- [ ] **Step 2: Run all tests**

Run: `node --test web/test/*.test.js`
Expected: PASS, 50 tests.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Describe how to try the touch prototype" -m "Claude-Session: https://claude.ai/code/session_01AuzxPWNihavyhjJd1EQqtU"
```

- [ ] **Step 4: Check the stress board**

`xcrun simctl openurl booted "http://localhost:8000/?stress"`, take a screenshot and confirm that 500 cards render. Any lag can only be judged on the device (step 6).

- [ ] **Step 5: Serve it to the phone**

Start `python3 -m http.server --directory web 8000` in the background and tell the user the URL: `http://$(ipconfig getifaddr en0):8000`.

- [ ] **Step 6: Hand over with the device checklist**

Give the user these checks to run on the phone. They pin the Review Focus items:
1. **Double-tap opens the keyboard.** Double-tap empty space and double-tap a card. The keyboard appears both times.
2. **Edit near the bottom.** Pan so that a card sits near the bottom of the screen, then double-tap it. It moves above the keyboard bar, and the bar sits right on the keyboard.
3. **Long title.** Type a title longer than one line, then tap Done. The card keeps its height and doesn't jump.
4. **Zoom to 200 % and read.** Pinch to the maximum. After you let go, the text is sharp.
5. **Turn while editing.** While typing, tap Turn. The card turns over and the keyboard stays up.
6. **Both modes.** Try each pan mode for a while, on a crowded part of the board.

Collect their impressions. Any change that follows is a new request.
