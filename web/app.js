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
