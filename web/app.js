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

/**
 * Firefox draws an empty last line with a <br> after the newline, and the caret before that <br> at the end of the
 * line above. A second newline, as Chrome uses, draws the line; the caret goes at the start of its own text node, as
 * at the end of a text node it is drawn at the end of the title's ::first-line.
 */
function newlineForBreak(el) {
  const br = el.lastChild;
  if (br?.nodeName !== "BR") return;
  const sel = getSelection();
  const atEnd = sel.anchorNode === el && sel.anchorOffset >= el.childNodes.length - 1;
  const nl = document.createTextNode("\n");
  br.replaceWith(nl);
  if (atEnd) sel.collapse(nl, 0);
}

/** The board, what is selected, turned and being edited, and every action on them. */
export class App {
  constructor(board) {
    this.touching = true;
    this.state = { selection: new Set(), turned: null, editing: null, renaming: null, held: new Set(), lifted: new Set(), float: null, marquee: null, found: null };
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

  get heightOf() {
    return this.view.heightOf;
  }

  /** Shows `board` in place of the one shown, with no undo history. */
  load(board) {
    this.endEditing();
    this.turn(null);
    this.ui.closeFind();
    this.state.selection = new Set();
    this.view.ready = false;
    this.model.replace(board);
    this.view.setCamera({ x: 16, y: this.ui.area().top + 16, zoom: 0.75 });
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

  /** A card at world point `w`: centred on it, or with its top-left there, as a double-click on the Mac puts it. */
  newCard(w, anchor = "centre") {
    this.endEditing();
    this.turn(null);
    this.model.begin();
    let id;
    this.model.update((b) => {
      id = anchor === "corner" ? R.addCard(b, w.x, w.y) : R.addCard(b, w.x - R.CARD_W / 2, w.y - R.GRID);
      R.gravity(b, this.heightOf);
    });
    this.select([id]);
    this.beginEdit(id, "New Card");
  }

  /** A lane centred on world point `p`, by default the middle of the view. */
  newLane(p = this.view.toWorld(this.view.centre())) {
    this.endEditing();
    let id;
    this.model.perform("New Lane", (b) => {
      id = R.addLane(b, p.x - R.LANE_W / 2, p.y - R.LANE_H / 2);
      R.gravity(b, this.heightOf);
    });
    this.select([id]);
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
    el.onblur = () => this.endEditing();
    el.focus({ preventScroll: true });
    caretToEnd(el);
    // fingers need the text larger to edit it; a pointer edits at any zoom, as on the Mac
    if (this.touching && this.view.cam.zoom < 1) this.view.zoomAround(this.view.toScreen({ x: c.x + c.w / 2, y: c.y }), 1, true);
    this.ui.update();
    this.revealEditing();
  }

  edited() {
    const e = this.state.editing;
    if (!e) return;
    const el = this.view.editorOf(e.id, e.back);
    newlineForBreak(el);
    // An empty last line is drawn from two newlines; the last one is not part of the text.
    const raw = el.innerText.replace(/\u200b/g, "");
    const text = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
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
    const old = this.view.editorOf(e.id, e.back);
    old.oninput = old.onblur = null;
    this.state.editing = null;
    this.turn(e.back ? null : e.id);
    this.beginEdit(e.id, e.name);
    old.contentEditable = "false";
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

  /** Ends any edit first; when that recorded nothing, the undo is spent on the edit, not on an earlier step. */
  undo() {
    const s = this.state;
    const top = this.model.undos.at(-1);
    const editing = s.editing || s.renaming;
    this.endEditing();
    if (editing && this.model.undos.at(-1) === top) return;
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
    this.turn(m.side === "back" ? m.id : null);
    const l = !c && R.lane(b, m.id);
    if (c || l) this.view.centreOn(c ? this.view.rectOf(c) : R.laneRect(l));
    this.view.invalidate();
  }
}
