# Breezy web on the desktop — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The web prototype answers a mouse, a trackpad and a keyboard as the Mac app does, while touch stays as it is.

**Architecture:** `main.js` routes each pointer event by `pointerType`: touch and pen to the existing `Gestures`, a mouse to a new `Mouse`. Both call the shared drag actions in `input.js`. Decisions are pure functions with unit tests: `pressAction` (policy.js), `pile` (rules.js), `wheelAction` (wheel.js) and `command` (keys.js).

**Tech Stack:** JavaScript ES modules, no bundler; Node 24's `node:test` for tests.

**Spec:** `docs/superpowers/specs/2026-10-07-breezy-desktop-design.md`

## Global Constraints

- Touch behaviour does not change; the existing tests keep passing unchanged.
- The mouse follows the Mac app where it and touch differ.
- Zoom stays within 25–200 % (`MIN_ZOOM`, `MAX_ZOOM`).
- Shortcuts use ⌘ on Mac and Ctrl elsewhere.
- Run tests with `node --test web/test/*.test.js` from the repo root.

## Review Focus

1. A Ctrl-wheel from a physical mouse arrives as one large delta (±100 or more): a notch must zoom about one 1.25× step, not jump to a limit. Pinned in Task 3.
2. A key typed into a card, a lane title or the find field must type, not act: Space, digits, L, ⌫. Pinned in Task 4.
3. ⇧1 types "!" and must not colour; ⇧L is still L. Pinned in Task 4.
4. A mouse press that does not move must not start a drag or an undo step, and must collapse a multi-selection to the pressed card. Pinned in Task 2.
5. Two presses far apart or slow are two clicks, not a double-click. Pinned in Task 2.

---

### Task 1: Pile, Mac-sized hit areas and the press policy

**Files:**
- Modify: `web/rules.js` (add `pile` after `cardsInRect`)
- Modify: `web/policy.js`
- Test: `web/test/rules.test.js`, `web/test/policy.test.js`

**Interfaces:**
- Produces: `R.pile(b, id, heightOf) → string[]`; `hitTest(b, p, { rectOf, zoom, turned, touch = true })`; `pressAction(hit, { shift, alt }, selection) → { select: "only"|"toggle"|"pile"|"none"|"keep", drag: null|"move"|"lane"|"resize"|"marquee", turn?: true, collapse?: true }`.

- [ ] **Step 1: Write the failing tests**

Append to `web/test/rules.test.js`:

```js
test("a pile is the card and the cards below it in its lane's column", () => {
  const b = board([card("a", 24, 72), card("b", 24, 144), card("c", 24, 216), card("side", 264, 144)], [lane("l", 0, 0, 480, 720)]);
  assert.deepEqual(R.pile(b, "b", h48), ["b", "c"]);
  assert.deepEqual(R.pile(b, "a", h48), ["a", "b", "c"]);
});

test("outside a lane a card piles alone", () => {
  const b = board([card("a", 1000, 0), card("b", 1000, 72)]);
  assert.deepEqual(R.pile(b, "a", h48), ["a"]);
});
```

Append to `web/test/policy.test.js` (and add `pressAction` to its import):

```js
const mouseAt = (b, x, y, zoom = 1, turned = null) => hitTest(b, { x, y }, { rectOf, zoom, turned, touch: false });

test("a pointer's fold is the card's own corner, without a touch area", () => {
  const b = { cards: [card("a", 0, 0, "n")], lanes: [] };
  assert.deepEqual(mouseAt(b, 236, 44), { kind: "fold", id: "a" });
  assert.deepEqual(mouseAt(b, 250, 50), { kind: "empty" });
  assert.deepEqual(mouseAt(b, 220, 30), { kind: "card", id: "a" });
});

test("a pointer's lane corner is 20 pt and its header 48 pt at any zoom", () => {
  const b = { cards: [], lanes: [lane] };
  assert.deepEqual(mouseAt(b, 470, 710), { kind: "corner", id: "l" });
  assert.deepEqual(mouseAt(b, 455, 700), { kind: "empty" });
  assert.deepEqual(mouseAt(b, 100, 40, 0.25), { kind: "header", id: "l" });
  assert.deepEqual(mouseAt(b, 100, 60, 0.25), { kind: "empty" });
});

const press = (kind, mods = {}, sel = []) => pressAction({ kind, id: "a" }, { shift: false, alt: false, ...mods }, new Set(sel));

test("a press on a card selects it alone and drags; in a selection it keeps the selection", () => {
  assert.deepEqual(press("card"), { select: "only", drag: "move", collapse: true });
  assert.deepEqual(press("card", {}, ["a", "b"]), { select: "keep", drag: "move", collapse: true });
  assert.deepEqual(press("card", { shift: true }), { select: "toggle", drag: null });
  assert.deepEqual(press("card", { alt: true }), { select: "pile", drag: "move", collapse: true });
});

test("a press on a fold turns the card, with or without shift", () => {
  assert.deepEqual(press("fold"), { select: "only", drag: null, turn: true });
  assert.deepEqual(press("fold", { shift: true }), { select: "only", drag: null, turn: true });
});

test("lane presses select the lane; shift on the header toggles it", () => {
  assert.deepEqual(press("corner"), { select: "only", drag: "resize" });
  assert.deepEqual(press("header"), { select: "only", drag: "lane" });
  assert.deepEqual(press("header", { shift: true }), { select: "toggle", drag: null });
});

test("a press on empty space clears the selection, or with shift keeps it, and boxes", () => {
  assert.deepEqual(press("empty"), { select: "none", drag: "marquee" });
  assert.deepEqual(press("empty", { shift: true }), { select: "keep", drag: "marquee" });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test web/test/rules.test.js web/test/policy.test.js`
Expected: FAIL — `R.pile is not a function`, `pressAction` not exported.

- [ ] **Step 3: Implement**

In `web/rules.js`, after `cardsInRect`:

```js
/** Card `id` and the cards below it in its lane's column; outside a lane, the card alone. */
export function pile(b, id, heightOf) {
  const c = card(b, id);
  if (!c) return [];
  const cr = cardRect(c, heightOf(id));
  const l = b.lanes.find((x) => containsCentre(laneRect(x), cr));
  if (!l) return [id];
  return b.cards
    .filter((x) => {
      const xr = cardRect(x, heightOf(x.id));
      return x.id === id || (x.y > c.y && sharesColumn(cr, xr) && containsCentre(laneRect(l), xr));
    })
    .map((x) => x.id);
}
```

In `web/policy.js`, replace `hitTest` and add `pressAction`:

```js
/**
 * What is under world point `p`, top first. Touch areas are `TOUCH` screen points at `zoom`; a pointer gets the Mac's:
 * the fold's own square, a 20 pt lane corner and the 48 pt header.
 */
export function hitTest(b, p, { rectOf, zoom, turned, touch = true }) {
  const reach = TOUCH / 2 / zoom;
  const near = (x, y, r) => Math.abs(p.x - x) <= r && Math.abs(p.y - y) <= r;
  const order = [...b.cards].reverse();
  const t = turned && card(b, turned);
  if (t) order.unshift(...order.splice(order.indexOf(t), 1));
  for (const c of order) {
    const r = rectOf(c);
    const ear = c.id === turned ? 24 : c.notes ? 16 : 0;
    if (ear && near(r.x + r.w - ear / 2, r.y + r.h - ear / 2, touch ? reach : ear / 2)) return { kind: "fold", id: c.id };
    if (contains(r, p.x, p.y)) return { kind: "card", id: c.id };
  }
  for (const l of [...b.lanes].reverse()) {
    if (near(l.x + l.w - 10, l.y + l.h - 10, touch ? reach : 10)) return { kind: "corner", id: l.id };
    const header = { x: l.x, y: l.y, w: l.w, h: touch ? Math.max(LANE_HEADER, TOUCH / zoom) : LANE_HEADER };
    if (contains(header, p.x, p.y)) return { kind: "header", id: l.id };
  }
  return { kind: "empty" };
}

/** What a mouse press does, as on the Mac: how the selection changes, and what a drag from it does. */
export function pressAction(hit, { shift, alt }, selection) {
  switch (hit.kind) {
    case "fold":
      return { select: "only", drag: null, turn: true };
    case "card":
      if (shift) return { select: "toggle", drag: null };
      if (alt) return { select: "pile", drag: "move", collapse: true };
      return { select: selection.has(hit.id) ? "keep" : "only", drag: "move", collapse: true };
    case "corner":
      return { select: "only", drag: "resize" };
    case "header":
      return shift ? { select: "toggle", drag: null } : { select: "only", drag: "lane" };
    default:
      return { select: shift ? "keep" : "none", drag: "marquee" };
  }
}
```

- [ ] **Step 4: Run all tests**

Run: `node --test web/test/*.test.js`
Expected: all pass, the old touch hit tests included.

- [ ] **Step 5: Commit** — "Add the Mac's press rules and piles to the web rules"

---

### Task 2: The mouse handler

**Files:**
- Modify: `web/input.js` (split `dragStart`; `hit` takes `touch`; add `doubleClick`)
- Modify: `web/app.js` (`newCard` anchor, `newLane` at a point, `selectAll`, `zoomTo`, `zoomBy`)
- Modify: `web/ui.js` (the "new-card" action passes the centre as before)
- Create: `web/mouse.js`
- Test: `web/test/mouse.test.js`

**Interfaces:**
- Consumes: `pressAction`, `R.pile` (Task 1).
- Produces: `class Mouse(app)` with `down({x, y, shiftKey, altKey}, t)`, `move({x, y})`, `up({x, y})`, `cancel()`, `leave()`, `hoveredCard() → id|null`; `Input#beginDrag(action, hit, p0, p)`, `Input#hit(p, touch = true)`, `Input#doubleClick(p, hit)`; `App#newCard(w, anchor = "centre"|"corner")`, `App#newLane(p?)`, `App#selectAll()`, `App#zoomTo(z)`, `App#zoomBy(f)`.

- [ ] **Step 1: Write the failing tests** — `web/test/mouse.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mouse, DOUBLE_MS } from "../mouse.js";

const card = (id, x, y) => ({ id, x, y, w: 240, text: "t", color: 1 });

/** An app whose input and actions record what the mouse asks of them. */
function fakeApp(hits = {}) {
  const calls = [];
  const app = {
    calls,
    state: { selection: new Set(), turned: null },
    model: { board: { cards: [card("a", 0, 0), card("b", 0, 72)], lanes: [] } },
    heightOf: () => 48,
    select: (ids) => { app.state.selection = new Set(ids); calls.push(["select", [...ids]]); },
    toggle: (id) => calls.push(["toggle", id]),
    turn: (id) => { app.state.turned = id; calls.push(["turn", id]); },
    endEditing: () => {},
    ui: { closeMenu: () => {} },
    input: {
      drag: null,
      stopCoast: () => {},
      hit: (p) => hits[`${p.x},${p.y}`] ?? { kind: "empty" },
      beginDrag: (action, h) => { app.input.drag = { action }; calls.push(["drag", action, h.id]); },
      dragMove: () => calls.push(["move"]),
      dragEnd: () => { app.input.drag = null; calls.push(["end"]); },
      dragCancel: () => { app.input.drag = null; calls.push(["cancel"]); },
      doubleClick: (p, h) => calls.push(["double", h.kind]),
    },
  };
  return app;
}
const at = (x, y, mods = {}) => ({ x, y, shiftKey: false, altKey: false, ...mods });
const names = (app) => app.calls.map((c) => c[0]);

test("a press that does not move selects without dragging, and collapses a selection to the card", () => {
  const app = fakeApp({ "10,10": { kind: "card", id: "a" } });
  app.state.selection = new Set(["a", "b"]);
  const m = new Mouse(app);
  m.down(at(10, 10), 0);
  m.move({ x: 12, y: 11 });
  m.up({ x: 12, y: 11 });
  assert.deepEqual(app.calls, [["select", ["a"]]]);
});

test("a drag past 3 pt moves the selection", () => {
  const app = fakeApp({ "10,10": { kind: "card", id: "a" } });
  const m = new Mouse(app);
  m.down(at(10, 10), 0);
  m.move({ x: 14, y: 10 });
  m.move({ x: 20, y: 10 });
  m.up({ x: 20, y: 10 });
  assert.deepEqual(names(app), ["select", "drag", "move", "end"]);
});

test("a box starts with the first move, without a threshold", () => {
  const app = fakeApp();
  const m = new Mouse(app);
  m.down(at(10, 10), 0);
  m.move({ x: 11, y: 10 });
  assert.deepEqual(app.calls, [["select", []], ["drag", "marquee", undefined]]);
});

test("⌥ on a card selects its pile", () => {
  const app = fakeApp({ "10,10": { kind: "card", id: "a" } });
  new Mouse(app).down(at(10, 10, { altKey: true }), 0);
  assert.deepEqual(app.calls, [["select", ["a"]]]);
});

test("a second press soon and near is a double-click, which replaces the press", () => {
  const app = fakeApp({ "10,10": { kind: "card", id: "a" }, "12,12": { kind: "card", id: "a" } });
  const m = new Mouse(app);
  m.down(at(10, 10), 0);
  m.up({ x: 10, y: 10 });
  m.down(at(12, 12), DOUBLE_MS - 1);
  assert.deepEqual(names(app), ["select", "select", "double"]);
});

test("presses slow or far apart are two clicks", () => {
  const app = fakeApp({ "10,10": { kind: "card", id: "a" }, "40,10": { kind: "card", id: "a" } });
  const m = new Mouse(app);
  m.down(at(10, 10), 0);
  m.up({ x: 10, y: 10 });
  m.down(at(10, 10), DOUBLE_MS + 1);
  m.up({ x: 10, y: 10 });
  m.down(at(40, 10), DOUBLE_MS + 50);
  assert.ok(!names(app).includes("double"));
});

test("a third quick press is a click again", () => {
  const app = fakeApp();
  const m = new Mouse(app);
  for (const t of [0, 100, 200]) {
    m.down(at(10, 10), t);
    m.up({ x: 10, y: 10 });
  }
  assert.deepEqual(names(app).filter((n) => n === "double").length, 1);
});

test("a press anywhere but the turned card turns it back; on its fold it turns", () => {
  const app = fakeApp({ "10,10": { kind: "card", id: "b" }, "50,50": { kind: "fold", id: "b" } });
  app.state.turned = "a";
  const m = new Mouse(app);
  m.down(at(10, 10), 0);
  assert.deepEqual(app.calls.slice(0, 1), [["turn", null]]);
  m.up({ x: 10, y: 10 });
  m.down(at(50, 50), 1000);
  assert.deepEqual(app.calls.at(-1), ["turn", "b"]);
});

test("the system taking the pointer cancels the drag", () => {
  const app = fakeApp({ "10,10": { kind: "card", id: "a" } });
  const m = new Mouse(app);
  m.down(at(10, 10), 0);
  m.move({ x: 30, y: 10 });
  m.cancel();
  assert.equal(names(app).at(-1), "cancel");
});

test("the hovered card is under the last pointer position", () => {
  const app = fakeApp({ "10,10": { kind: "fold", id: "a" } });
  const m = new Mouse(app);
  m.move({ x: 10, y: 10 });
  assert.equal(m.hoveredCard(), "a");
  m.leave();
  assert.equal(m.hoveredCard(), null);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --test web/test/mouse.test.js`
Expected: FAIL — cannot find `../mouse.js`.

- [ ] **Step 3: Implement**

`web/mouse.js`:

```js
import * as R from "./rules.js";
import { pressAction } from "./policy.js";

export const SLOP = 3;
export const DOUBLE_MS = 500;
const DOUBLE_SLOP = 4;

const isCard = (h) => h.kind === "card" || h.kind === "fold";

/** A mouse or trackpad pointer, with the Mac's rules: a press selects, a drag past 3 pt acts, a double-click edits or creates. Times in ms. */
export class Mouse {
  constructor(app) {
    this.app = app;
    this.press = null;
    this.last = null;
    this.pointer = null;
  }

  down({ x, y, shiftKey, altKey }, t) {
    const app = this.app;
    const s = app.state;
    const p = { x, y };
    const double = !!this.last && t - this.last.t <= DOUBLE_MS && Math.hypot(x - this.last.x, y - this.last.y) <= DOUBLE_SLOP;
    this.last = double ? null : { ...p, t };
    this.pointer = p;
    this.press = null;
    app.input.stopCoast();
    app.ui.closeMenu();
    app.endEditing();
    const h = app.input.hit(p, false);
    if (s.turned && h.id !== s.turned && h.kind !== "fold") app.turn(null);
    if (double) return app.input.doubleClick(p, h);
    const a = pressAction(h, { shift: shiftKey, alt: altKey }, s.selection);
    if (a.select === "only") app.select([h.id]);
    if (a.select === "toggle") app.toggle(h.id);
    if (a.select === "pile") app.select(R.pile(app.model.board, h.id, app.heightOf));
    if (a.select === "none") app.select([]);
    if (a.turn) app.turn(s.turned === h.id ? null : h.id);
    this.press = a.drag && { p0: p, h, action: a.drag, collapse: a.collapse, dragging: false };
  }

  move({ x, y }) {
    const p = { x, y };
    this.pointer = p;
    const d = this.press;
    if (!d) return;
    if (d.dragging) return this.app.input.dragMove(p);
    const slop = d.action === "marquee" ? 0 : SLOP;
    if (Math.hypot(x - d.p0.x, y - d.p0.y) <= slop) return;
    d.dragging = true;
    this.app.input.beginDrag(d.action, d.h, d.p0, p);
  }

  up({ x, y }) {
    const d = this.press;
    this.press = null;
    if (!d) return;
    if (d.dragging) return this.app.input.dragEnd({ x, y }, { x: 0, y: 0 });
    if (d.collapse) this.app.select([d.h.id]);
  }

  cancel() {
    const d = this.press;
    this.press = null;
    if (d?.dragging) this.app.input.dragCancel();
  }

  leave() {
    this.pointer = null;
  }

  /** The card under the pointer, for Space; found afresh, as the board may have scrolled under a still pointer. */
  hoveredCard() {
    if (!this.pointer) return null;
    const h = this.app.input.hit(this.pointer, false);
    return isCard(h) ? h.id : null;
  }
}
```

In `web/input.js`:

```js
  hit(p, touch = true) {
    const { view, state, model } = this.app;
    return hitTest(model.board, view.toWorld(p), { rectOf: (c) => view.rectOf(c), zoom: view.cam.zoom, turned: state.turned, touch });
  }
```

`doubleTap` passes the anchor explicitly: `if (h.kind === "empty") app.newCard(app.view.toWorld(p));` stays (centre is the default). Add after `doubleTap`:

```js
  /** As on the Mac: edit a card, rename a lane; a new card's top-left goes where the pointer is. */
  doubleClick(p, h) {
    const app = this.app;
    if (isCard(h)) return app.beginEdit(h.id);
    if (h.kind === "header") return app.beginRename(h.id);
    if (h.kind === "empty") app.newCard(app.view.toWorld(p), "corner");
  }
```

Replace `dragStart` with a touch half and a shared half:

```js
  dragStart(p0, p, held) {
    const h = held && this.holdHit ? this.holdHit : this.hit(p0);
    this.holdHit = null;
    const action = dragAction(h, this.app.state.selection, held);
    if (action === "marquee") this.app.select([]);
    this.beginDrag(action, h, p0, p);
  }

  /** Starts drag `action` on hit `h`, pressed at screen point `p0` and now at `p`. A box adds to the selection it starts with. */
  beginDrag(action, h, p0, p) {
    const app = this.app;
    const s = app.state;
    const b = app.model.board;
    if (action !== "pan") {
      app.endEditing();
      if (s.turned && h.id !== s.turned) app.turn(null);
    }
    const d = { action, id: h.id, p0, w0: app.view.toWorld(p0), cam0: { ...app.view.cam }, sel0: [...s.selection], last: p };
    // ... the existing body from `this.edgeSince = 0;` on, with the marquee branch changed to:
    //   } else if (action === "marquee") {
    //     d.base = [...s.selection];
    //   }
  }
```

and in `dragMove`'s marquee branch: `app.select([...d.base, ...R.cardsInRect(app.model.board, r, app.heightOf).map((c) => c.id)]);`

In `web/app.js`:

```js
  /** A card at world point `w`: centred on it, or with its top-left there, as a double-click on the Mac puts it. */
  newCard(w, anchor = "centre") {
    // ... as before, with the addCard line:
      id = anchor === "corner" ? R.addCard(b, w.x, w.y) : R.addCard(b, w.x - R.CARD_W / 2, w.y - R.GRID);
  }

  /** A lane centred on world point `p`, by default the middle of the view. */
  newLane(p = this.view.toWorld(this.view.centre())) {
    // ... as before without the `const p` line
  }

  selectAll() {
    this.select(this.model.board.cards.map((c) => c.id));
  }

  /** Zooms about the middle of the view, animated, as the Mac's zoom commands do. */
  zoomTo(z) {
    this.view.zoomAround(this.view.centre(), z, true);
  }

  zoomBy(f) {
    this.zoomTo(this.view.cam.zoom * f);
  }
```

- [ ] **Step 4: Run all tests**

Run: `node --test web/test/*.test.js`
Expected: all pass.

- [ ] **Step 5: Commit** — "Handle a mouse as the Mac app does"

---

### Task 3: Wheel and pinch

**Files:**
- Create: `web/wheel.js`
- Test: `web/test/wheel.test.js`

**Interfaces:**
- Produces: `wheelAction({ deltaX, deltaY, deltaMode, ctrlKey, metaKey }) → { pan: {x, y} } | { zoom: factor }`; `LINE = 16`.

- [ ] **Step 1: Write the failing tests** — `web/test/wheel.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { wheelAction, LINE } from "../wheel.js";

const wheel = (e) => wheelAction({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, ...e });

test("scrolling pans against the delta", () => {
  assert.deepEqual(wheel({ deltaX: 5, deltaY: -10 }), { pan: { x: -5, y: 10 } });
});

test("a wheel counting lines pans 16 pt a line", () => {
  assert.deepEqual(wheel({ deltaY: 3, deltaMode: 1 }), { pan: { x: -0, y: -3 * LINE } });
});

test("a pinch, or ⌘-scroll, zooms: up zooms in", () => {
  assert.ok(Math.abs(wheel({ deltaY: -10, ctrlKey: true }).zoom - Math.exp(0.1)) < 1e-9);
  assert.ok(wheel({ deltaY: 10, metaKey: true }).zoom < 1);
});

test("a mouse wheel's large notch zooms one step, not to a limit", () => {
  assert.ok(Math.abs(wheel({ deltaY: -100, ctrlKey: true }).zoom - Math.exp(0.25)) < 1e-9);
  assert.ok(Math.abs(wheel({ deltaY: 3, deltaMode: 1, ctrlKey: true }).zoom - Math.exp(-0.25)) < 1e-9);
});
```

- [ ] **Step 2: Run to see it fail** — `node --test web/test/wheel.test.js` → cannot find module.

- [ ] **Step 3: Implement** — `web/wheel.js`:

```js
export const LINE = 16;
const PAGE = 800;
// A pinch's deltas are a few points each; a mouse wheel's notch can be 100. One notch zooms about 1.25×, as ⌘+ does.
const ZOOM_PER_PT = 0.01;
const MAX_ZOOM_DELTA = 25;

/** What a wheel event does: a pinch (⌃, as browsers send it) or ⌘-scroll zooms about the pointer; any other scroll pans. */
export function wheelAction({ deltaX, deltaY, deltaMode, ctrlKey, metaKey }) {
  const unit = [1, LINE, PAGE][deltaMode] ?? 1;
  if (ctrlKey || metaKey) {
    const d = Math.max(-MAX_ZOOM_DELTA, Math.min(MAX_ZOOM_DELTA, deltaY * unit));
    return { zoom: Math.exp(-d * ZOOM_PER_PT) };
  }
  return { pan: { x: -deltaX * unit, y: -deltaY * unit } };
}
```

- [ ] **Step 4: Run all tests** — all pass.

- [ ] **Step 5: Commit** — "Pan and zoom with a trackpad or wheel"

---

### Task 4: Keyboard

**Files:**
- Create: `web/keys.js`
- Modify: `web/ui.js` (`openFind(text)`, Escape closes find, ⌘G when closed opens it)
- Test: `web/test/keys.test.js`

**Interfaces:**
- Consumes: `App#selectAll`, `App#zoomTo`, `App#zoomBy`, `App#newLane(p)` (Task 2); `Mouse#hoveredCard`, `Mouse#pointer`.
- Produces: `command(e, { mac, typing }) → string|null` where `typing` is `null|"card"|"lane"|"field"`; `perform(app, cmd, mouse)`.

- [ ] **Step 1: Write the failing tests** — `web/test/keys.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { command } from "../keys.js";

const key = (k, mods = {}, ctx = {}) =>
  command({ key: k, code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }, { mac: true, typing: null, ...ctx });

test("⌘ shortcuts on the Mac, Ctrl elsewhere", () => {
  assert.equal(key("z", { metaKey: true }), "undo");
  assert.equal(key("z", { metaKey: true, shiftKey: true }), "redo");
  assert.equal(key("Z", { metaKey: true, shiftKey: true }), "redo");
  assert.equal(key("z", { ctrlKey: true }), null);
  assert.equal(key("z", { ctrlKey: true }, { mac: false }), "undo");
  assert.equal(key("a", { metaKey: true }), "select-all");
  assert.equal(key("f", { metaKey: true }), "find");
  assert.equal(key("g", { metaKey: true }), "find-next");
  assert.equal(key("g", { metaKey: true, shiftKey: true }), "find-previous");
  assert.equal(key("e", { metaKey: true }), "find-selection");
});

test("zoom keys: ⌘+ or ⌘=, ⌘-, ⌘0 and ⇧0 by position", () => {
  assert.equal(key("=", { metaKey: true }), "zoom-in");
  assert.equal(key("+", { metaKey: true, shiftKey: true }), "zoom-in");
  assert.equal(key("-", { metaKey: true }), "zoom-out");
  assert.equal(key("0", { metaKey: true }), "zoom-reset");
  assert.equal(command({ key: "=", code: "Digit0", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true }, { mac: true, typing: null }), "zoom-reset");
});

test("board keys", () => {
  assert.equal(key(" "), "turn");
  assert.equal(key("Escape"), "escape");
  assert.equal(key("Backspace"), "delete");
  assert.equal(key("Delete"), "delete");
  assert.equal(key("3"), "colour-3");
  assert.equal(key("6"), null);
  assert.equal(key("l"), "new-lane");
  assert.equal(key("L", { shiftKey: true }), "new-lane");
});

test("⇧1 types '!' and colours nothing; ⌥ and ⌘ leave board keys alone", () => {
  assert.equal(key("!", { shiftKey: true, code: "Digit1" }), null);
  assert.equal(key("3", { altKey: true }), null);
  assert.equal(key("l", { metaKey: true }), null);
});

test("typing into a card types, except the keys that end or turn it", () => {
  const card = { typing: "card" };
  for (const k of [" ", "3", "l", "Backspace", "Enter"]) assert.equal(key(k, {}, card), null, k);
  assert.equal(key("a", { metaKey: true }, card), null);
  assert.equal(key("Escape", {}, card), "end-edit");
  assert.equal(key("Enter", { metaKey: true }, card), "end-edit");
  assert.equal(key("Tab", {}, card), "switch-side");
  assert.equal(key("Tab", { shiftKey: true }, card), null);
  assert.equal(key("z", { metaKey: true }, card), "undo");
  assert.equal(key("f", { metaKey: true }, card), "find");
  assert.equal(key("=", { metaKey: true }, card), "zoom-in");
});

test("a lane title ends on Tab; the find field keeps its own keys", () => {
  assert.equal(key("Tab", {}, { typing: "lane" }), "end-edit");
  assert.equal(key(" ", {}, { typing: "lane" }), null);
  const field = { typing: "field" };
  assert.equal(key("z", { metaKey: true }, field), null);
  assert.equal(key("a", { metaKey: true }, field), null);
  assert.equal(key("g", { metaKey: true }, field), "find-next");
  assert.equal(key("Backspace", {}, field), null);
});
```

- [ ] **Step 2: Run to see it fail** — `node --test web/test/keys.test.js` → cannot find module.

- [ ] **Step 3: Implement** — `web/keys.js`:

```js
const ANYWHERE = new Set(["find", "find-next", "find-previous", "zoom-in", "zoom-out", "zoom-reset"]);

/**
 * The command for key event `e`, as the Mac app's keys and menus have them, or null to leave the key alone. `typing` is
 * what has the keyboard: null for the board, "card", "lane" or "field" (the find field).
 */
export function command(e, { mac, typing }) {
  const mod = mac ? e.metaKey : e.ctrlKey;
  const other = mac ? e.ctrlKey : e.metaKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod && !e.altKey && !other) {
    const cmd = modified(k, e.shiftKey);
    if (!cmd) return null;
    if (ANYWHERE.has(cmd)) return cmd;
    if (cmd === "end-edit") return typing === "card" ? cmd : null;
    if (cmd === "undo" || cmd === "redo") return typing === "field" ? null : cmd;
    return typing ? null : cmd;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (typing === "card") return k === "Escape" ? "end-edit" : k === "Tab" && !e.shiftKey ? "switch-side" : null;
  if (typing === "lane") return k === "Tab" ? "end-edit" : null;
  if (typing) return null;
  // by position, as ⇧0 types "=" on some layouts
  if (e.shiftKey && e.code === "Digit0") return "zoom-reset";
  if (k === " ") return "turn";
  if (k === "Escape") return "escape";
  if (k === "Backspace" || k === "Delete") return "delete";
  if (k === "l") return "new-lane";
  if (/^[1-5]$/.test(k)) return `colour-${k}`;
  return null;
}

function modified(k, shift) {
  if (k === "z") return shift ? "redo" : "undo";
  if (k === "g") return shift ? "find-previous" : "find-next";
  if (k === "=" || k === "+") return "zoom-in";
  if (k === "-" && !shift) return "zoom-out";
  if (k === "0" && !shift) return "zoom-reset";
  if (shift) return null;
  return { a: "select-all", f: "find", e: "find-selection", Enter: "end-edit" }[k] ?? null;
}

/** Runs command `cmd`; `mouse` knows the card under the pointer and where the pointer is. */
export function perform(app, cmd, mouse) {
  const s = app.state;
  const ui = app.ui;
  switch (cmd) {
    case "undo": return app.undo();
    case "redo": return app.redo();
    case "select-all": return app.selectAll();
    case "find": app.endEditing(); return ui.openFind();
    case "find-next": app.endEditing(); return ui.findStep(1);
    case "find-previous": app.endEditing(); return ui.findStep(-1);
    case "find-selection": {
      const [c] = app.selectedCards();
      return c && ui.openFind(c.text.split("\n")[0]);
    }
    case "zoom-in": return app.zoomBy(1.25);
    case "zoom-out": return app.zoomBy(1 / 1.25);
    case "zoom-reset": return app.zoomTo(1);
    case "end-edit": return app.endEditing();
    case "switch-side": return app.switchSide();
    case "turn": {
      const sel = app.selectedCards();
      const id = mouse.hoveredCard() ?? (sel.length === 1 && s.selection.size === 1 ? sel[0].id : null);
      return app.turn(id === s.turned ? null : id);
    }
    case "escape": return s.turned ? app.turn(null) : app.select([]);
    case "delete": return s.selection.size && app.removeSelection();
    case "new-lane": return app.newLane(mouse.pointer ? app.view.toWorld(mouse.pointer) : undefined);
    default:
      if (cmd.startsWith("colour-")) return app.colour(Number(cmd.slice(7)));
  }
}
```

In `web/ui.js`:

```js
  /** Opens the find bar, with `text` to find if given. */
  openFind(text) {
    this.closeMenu();
    swap(this.$("#find"), true, { y: -24, opacity: 0, scale: 0.96 });
    const field = this.$("#find input");
    if (text !== undefined) {
      field.value = text;
      this.$("#find .clear").hidden = !text;
    }
    field.focus();
    field.select();
    this.find(field.value);
  }

  /** ⌘G: the next match, opening the bar on the last search when it is closed. */
  findStep(d) {
    if (this.$("#find").hidden) return this.openFind();
    this.step(d);
  }
```

and in the find field's keydown listener, before the Enter check:

```js
      if (e.key === "Escape") {
        e.preventDefault();
        return this.closeFind();
      }
```

- [ ] **Step 4: Run all tests** — all pass.

- [ ] **Step 5: Commit** — "Add the Mac app's keyboard shortcuts"

---

### Task 5: Wire it into the page and try it in browsers

**Files:**
- Modify: `web/main.js`
- Modify: `README.md` (the touch prototype paragraph)

**Interfaces:**
- Consumes: `Mouse` (Task 2), `wheelAction` (Task 3), `command`, `perform` (Task 4).

- [ ] **Step 1: Route pointers, wheel and keys** — in `web/main.js`, replace the `pointerdown`/`pointermove`/`pointerup`/`pointercancel` listeners with:

```js
const board = document.getElementById("board");
const gestures = new Gestures(app.input);
const mouse = new Mouse(app);
const editor = (e) => e.target.closest?.('[contenteditable="plaintext-only"]');
board.addEventListener("pointerdown", (e) => {
  if (editor(e)) return;
  if (e.pointerType === "mouse") {
    if (e.button !== 0) return;
    // a click on the board takes the keyboard from the find field, as clicking the canvas does on the Mac
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    board.setPointerCapture(e.pointerId);
    return mouse.down({ x: e.clientX, y: e.clientY, shiftKey: e.shiftKey, altKey: e.altKey }, e.timeStamp);
  }
  app.input.touchStart();
  gestures.down(e.pointerId, e.clientX, e.clientY, e.timeStamp);
  setTimeout(() => gestures.tick(performance.now()), HOLD_MS + 10);
});
```

keep the `mousedown` and `touchstart` listeners on `board`, then:

```js
addEventListener("pointermove", (e) => {
  if (e.pointerType === "mouse") return mouse.move({ x: e.clientX, y: e.clientY });
  gestures.move(e.pointerId, e.clientX, e.clientY, e.timeStamp);
});
addEventListener("pointerup", (e) => {
  if (e.pointerType === "mouse") return e.button === 0 && mouse.up({ x: e.clientX, y: e.clientY });
  gestures.up(e.pointerId, e.clientX, e.clientY, e.timeStamp);
});
addEventListener("pointercancel", (e) => (e.pointerType === "mouse" ? mouse.cancel() : gestures.cancel(e.pointerId)));
addEventListener("pointerout", (e) => e.pointerType === "mouse" && !e.relatedTarget && mouse.leave());
board.addEventListener("contextmenu", (e) => editor(e) || e.preventDefault());

addEventListener("wheel", (e) => {
  e.preventDefault();
  const a = wheelAction(e);
  const view = app.view;
  if (a.zoom) view.zoomAround({ x: e.clientX, y: e.clientY }, view.cam.zoom * a.zoom);
  else view.setCamera({ ...view.cam, x: view.cam.x + a.pan.x, y: view.cam.y + a.pan.y });
  // what a held drag is over has moved
  if (app.input.drag) app.input.dragMove(app.input.drag.last);
}, { passive: false });

const mac = /Mac|iPhone|iPad/.test(navigator.userAgent);
addEventListener("keydown", (e) => {
  const s = app.state;
  const typing = s.editing ? "card" : s.renaming ? "lane" : e.target.closest?.("input, textarea") ? "field" : null;
  const cmd = command(e, { mac, typing });
  if (!cmd) return;
  e.preventDefault();
  perform(app, cmd, mouse);
});
```

with the imports `import { Mouse } from "./mouse.js";`, `import { wheelAction } from "./wheel.js";`, `import { command, perform } from "./keys.js";`. Rename the remaining `document.getElementById("board")` uses to `board`.

- [ ] **Step 2: Run all tests** — `node --test web/test/*.test.js`: all pass.

- [ ] **Step 3: Try it in Chrome** — serve with `npx --yes live-server@1.2.2 web --port=58565 --no-browser`, open `http://localhost:58565/` in Chrome through the Claude-in-Chrome tools, and check with real clicks and synthetic `WheelEvent`/`KeyboardEvent`s:
  - click selects; ⇧-click toggles; dragging a card moves it and lands it in a lane; dragging empty space draws a box; double-click empty space makes a card whose top-left is at the pointer; double-click a card edits it; Esc ends the edit; Tab turns while editing;
  - `new WheelEvent("wheel", { deltaY: 40 })` pans, `{ deltaY: -100, ctrlKey: true }` zooms one step about the pointer;
  - Space with the pointer on a card turns it; 1–5 colour; ⌫ deletes; L adds a lane at the pointer; ⌘F opens find, Esc closes it; ⌘0 resets the zoom.
  - The touch prototype still works in the iOS simulator: a tap selects, a drag pans, a pinch zooms.

- [ ] **Step 4: README** — after the sentence about installing, add: "In a desktop browser it takes a mouse, trackpad and keyboard as the Mac app does."

- [ ] **Step 5: Commit** — "Run the web prototype with a mouse, trackpad and keyboard"
