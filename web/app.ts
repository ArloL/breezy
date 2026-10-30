import * as R from "./rules.ts";
import { Model } from "./model.ts";
import { Input } from "./input.ts";
import type { Ports, PresencePort, SpacePort, UIPort, ViewPort } from "./ports.ts";
import type { Person } from "./presence.ts";
import type { Library } from "./library.ts";
import type { Board, Clip, Lane, Point, Rect } from "./types.ts";
import { box, Flight, type Value } from "./flight.ts";

/** The card being edited, which side of it, and the undo step the edit records. */
export interface Editing {
  id: string;
  back: boolean;
  name: string;
}

/** How far what a finger holds is from where the board keeps it: a moved card or lane, or a resized lane. */
export type Float = { x: number; y: number; w?: undefined; h?: undefined } | { w: number; h: number; x?: undefined; y?: undefined };

export interface State {
  selection: Set<string>;
  turned: string | null;
  editing: Editing | null;
  renaming: string | null;
  held: Set<string>;
  lifted: Set<string>;
  float: Float | null;
  marquee: Rect | null;
  found: string | null;
  /** Who else holds each item they hold. */
  taken: Map<string, Person>;
  /** The colour of whoever else has each item selected. */
  seen: Map<string, string>;
}

/** A search match. */
export interface Match {
  id: string;
  side?: string;
}

/** The board, what is selected, turned and being edited, and every action on them. */
export class App {
  touching: boolean;
  state: State;
  model: Model;
  view: ViewPort;
  presence: PresencePort;
  onSelect: () => void;
  ui: UIPort;
  input: Input;
  library: Library | undefined;
  space: SpacePort | undefined;
  /** What it saw and decided, for whoever debugs it. */
  readonly flight = new Flight();
  /** The last reveal noted, to note the next only when it decides otherwise. */
  private revealed = "";

  constructor(board: Board, ports: Ports) {
    this.touching = true;
    this.state = { selection: new Set(), turned: null, editing: null, renaming: null, held: new Set(), lifted: new Set(), float: null, marquee: null, found: null, taken: new Map(), seen: new Map() };
    this.model = new Model(board);
    this.view = ports.view(this);
    this.presence = ports.presence(this.view);
    this.view.onRender = () => this.presence.place();
    /** After the selection changes, for others to see. */
    this.onSelect = () => {};
    R.gravity(this.model.board, this.view.heightOf);
    this.ui = ports.ui(this);
    this.input = new Input(this);
    this.view.area = () => this.ui.area();
    this.view.onCamera = () => {
      this.ui.updateZoom();
      this.presence.place();
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
  load(board: Board) {
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

  /** Selects `ids`, leaving out what someone else holds. */
  select(ids: Iterable<string>) {
    this.state.selection = new Set([...ids].filter((id) => !this.state.taken.has(id)));
    this.view.invalidate();
    this.ui.update();
    this.onSelect();
  }

  toggle(id: string) {
    const s = new Set(this.state.selection);
    if (!s.delete(id)) s.add(id);
    this.select(s);
  }

  /** Turns card `id` over, putting back the one turned before; null just puts it back. */
  turn(id: string | null) {
    const s = this.state;
    const next = id && R.card(this.model.board, id) ? id : null;
    if (next === s.turned) return;
    this.flight.note("transition", "turn", { from: s.turned, to: next });
    this.view.animateTurn([s.turned, next].filter((x): x is string => Boolean(x)), () => (s.turned = next));
    // with room around it, as a back is turned to be read
    const r = next && this.view.rectOf(R.card(this.model.board, next)!), a = this.view.area();
    const pan = r && this.view.reveal(r, "top", 48);
    if (r && pan) {
      const why = r.w * this.view.cam.zoom + 32 > a.right - a.left || r.h * this.view.cam.zoom + 32 > a.bottom - a.top ? "too big" : "fits";
      this.flight.note("decision", "reveal", { path: "back", why, pan: [Math.round(pan.x), Math.round(pan.y)] });
    }
    this.ui.update();
  }

  /** A card at world point `w`: centred on it, or with its top-left there, as a double-click on the Mac puts it. */
  newCard(w: Point, anchor: "centre" | "corner" = "centre") {
    this.endEditing();
    this.turn(null);
    this.model.begin();
    let id!: string;
    this.model.update((b) => {
      id = anchor === "corner" ? R.addCard(b, w.x, w.y) : R.addCard(b, w.x - R.CARD_W / 2, w.y - R.GRID);
      R.gravity(b, this.heightOf);
    });
    this.select([id]);
    this.beginEdit(id, "New Card");
  }

  /** A lane centred on world point `p`, by default the middle of the view. */
  newLane(p: Point = this.view.toWorld(this.view.centre())) {
    this.endEditing();
    let id!: string;
    this.model.perform("New Lane", (b) => {
      const s = R.openSpot(b, R.LANE_W, R.LANE_H, p.x - R.LANE_W / 2, p.y - R.LANE_H / 2, this.heightOf);
      id = R.addLane(b, s.x, s.y);
      R.gravity(b, this.heightOf);
    });
    this.select([id]);
  }

  selectAll() {
    this.select(this.model.board.cards.map((c) => c.id));
  }

  /** Zooms about the middle of the view, animated, as the Mac's zoom commands do. */
  zoomTo(z: number) {
    this.view.zoomAround(this.view.centre(), z, true);
  }

  zoomBy(f: number) {
    this.zoomTo(this.view.cam.zoom * f);
  }

  /** Asks the open board's space to hold `ids` for the gesture starting. */
  hold(ids: Iterable<string>) {
    this.space?.hold(ids);
  }

  /** Someone else got there first with `ids`: the drag, edit or rename under way on any of them goes back as it began. */
  refused(ids: ReadonlySet<string>) {
    const s = this.state;
    this.flight.note("transition", "refused", { ids: ids.size });
    if (["move", "lane", "resize"].includes(this.input.drag?.action ?? "")) {
      if ([...s.held].some((id) => ids.has(id))) this.input.dragCancel();
      return;
    }
    const id = s.editing?.id ?? s.renaming;
    if (id && ids.has(id)) this.cancelEditing();
  }

  /** Ends the card edit or lane rename in progress, putting the board back as it began. */
  cancelEditing() {
    const s = this.state;
    const id = s.editing?.id ?? s.renaming;
    if (!id) return;
    this.flight.note("transition", s.editing ? "edit cancel" : "rename cancel", { id });
    const f = s.editing ? this.view.editorOf(s.editing.id, s.editing.back) : this.view.titleOf(s.renaming!);
    s.editing = s.renaming = null;
    f?.close();
    // the editor's text is the typed one; drawing afresh puts the board's back
    const e = this.view.els.get(id);
    if (e) e.key = "";
    this.model.cancel();
    this.ui.update();
  }

  /** Where the caret is in the card being edited, for others to draw. */
  caret() {
    const e = this.state.editing;
    const at = e && this.view.editorOf(e.id, e.back)?.caret();
    return e && at != null ? { id: e.id, back: e.back, at } : null;
  }

  /** Edits the side of card `id` facing up; focus stays synchronous so iOS shows the keyboard. */
  beginEdit(id: string, name = "Edit Card") {
    const c = R.card(this.model.board, id);
    if (!c) return;
    if (this.state.taken.has(id)) return;
    this.endEditing();
    this.model.begin();
    this.hold([id]);
    const back = this.state.turned === id;
    this.state.editing = { id, back, name };
    this.flight.note("transition", "edit", { id, back });
    this.view.render();
    this.view.editorOf(id, back)!.open(back ? (c.notes ?? "") : c.text, { input: () => this.edited(), done: () => this.endEditing() });
    // fingers need the text larger to edit it; a pointer edits at any zoom, as on the Mac
    if (this.touching && this.view.cam.zoom < 1) this.view.zoomAround(this.view.toScreen({ x: c.x + c.w / 2, y: c.y }), 1, true);
    this.ui.update();
    this.revealEditing();
  }

  edited() {
    const e = this.state.editing;
    if (!e) return;
    const text = this.view.editorOf(e.id, e.back)!.text();
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
      this.flight.note("transition", "rename end", { id });
      const f = this.view.titleOf(id);
      const title = f?.text().trim() || "Lane";
      f?.close();
      this.model.update((b) => R.setLaneTitle(b, id, title));
      this.model.end("Rename Lane");
    }
    const e = s.editing;
    if (e) {
      s.editing = null;
      this.flight.note("transition", "edit end", { id: e.id, back: e.back });
      this.view.editorOf(e.id, e.back)?.close();
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
    const old = this.view.editorOf(e.id, e.back)!;
    old.detach();
    this.state.editing = null;
    this.turn(e.back ? null : e.id);
    this.beginEdit(e.id, e.name);
    old.close();
  }

  beginRename(id: string) {
    const l = R.lane(this.model.board, id);
    if (!l) return;
    if (this.state.taken.has(id)) return;
    this.endEditing();
    this.model.begin();
    this.hold([id]);
    this.state.renaming = id;
    this.flight.note("transition", "rename", { id });
    this.view.render();
    const f = this.view.titleOf(id)!;
    f.open(l.title, {
      input: () => this.model.update((b) => R.setLaneTitle(b, id, f.text())),
      done: () => this.endEditing(),
      enter: () => this.endEditing(),
    });
    this.ui.update();
  }

  /** Shows the card being edited, or of one taller than what shows, the caret's line. */
  revealEditing() {
    const e = this.state.editing;
    const c = e && R.card(this.model.board, e.id);
    if (!c) return;
    // too tall at the zoom the camera is going to; the caret is drawn at the zoom it is at
    const r = this.view.rectOf(c), a = this.view.area(), { zoom } = this.view.cam;
    const tall = r.h * this.view.camera.goal().zoom + 32 > a.bottom - a.top;
    const at = tall ? this.view.editorOf(e.id, e.back)?.caret() : null;
    const caret = at == null ? null : this.view.caretRect(e.id, e.back, at);
    const top = caret && this.view.topOf(e.id);
    const why = !tall ? "fits" : !caret ? "no caret" : top == null ? "no top" : "too tall";
    const path = why === "too tall" ? "caret" : "card";
    // once per decision and board, not per key: the geometry is measured only when noted
    const decided = `${path} ${why} ${e.id} ${e.back} ${a.top} ${a.bottom}`;
    if (decided !== this.revealed) {
      this.revealed = decided;
      this.flight.note("decision", "reveal", { path, why, ...this.geometry() });
    }
    if (!caret || top == null) return this.view.reveal(r, "bottom");
    this.view.reveal({ x: r.x, y: r.y + (caret.y - top) / zoom, w: r.w, h: caret.h / zoom });
  }

  /** What shows the board, where the camera is, and the card being edited on screen: its side, rect, caret and top;
   * or that it could not be read, as measuring must never break the app it measures. */
  geometry(): { [k: string]: Value } {
    try {
      const a = this.view.area(), { x, y, zoom } = this.view.cam, e = this.state.editing;
      const c = e && R.card(this.model.board, e.id);
      let editing: Value = null;
      if (e && c) {
        const r = this.view.rectOf(c), s = this.view.toScreen(r), at = this.view.editorOf(e.id, e.back)?.caret();
        const caret = at == null ? null : this.view.caretRect(e.id, e.back, at);
        const top = this.view.topOf(e.id);
        editing = { id: e.id, back: e.back, card: box({ ...s, w: r.w * zoom, h: r.h * zoom }), caret: box(caret && { ...caret, w: 0 }), top: top == null ? null : Math.round(top * 10) / 10 };
      }
      return { area: [a.top, a.bottom], cam: [x, y, zoom].map((n) => Math.round(n * 100) / 100), editing };
    } catch {
      return { unreadable: true };
    }
  }

  colour(n: number) {
    this.model.perform("Colour", (b) => R.setColor(b, this.state.selection, n));
  }

  removeSelection() {
    const ids = new Set(this.state.selection);
    if (this.state.turned && ids.has(this.state.turned)) {
      this.flight.note("transition", "turn", { from: this.state.turned, to: null });
      this.state.turned = null;
    }
    this.model.perform("Delete", (b) => {
      R.remove(b, ids);
      R.gravity(b, this.heightOf);
    });
    this.select([]);
  }

  /** The selected cards as a clip, null when none is a card. */
  copySelection(): Clip | null {
    const c = R.clip(this.model.board, this.library?.id ?? "", this.state.selection, this.heightOf);
    if (c) this.flight.note("transition", "copy", { ids: c.cards.length });
    return c;
  }

  /** Copies the selected cards and removes them, lanes staying. */
  cutSelection(): Clip | null {
    const c = this.copySelection();
    if (!c) return null;
    const ids = new Set(c.cards.map((k) => k.id));
    this.endEditing();
    if (this.state.turned && ids.has(this.state.turned)) this.turn(null);
    this.model.perform("Cut", (b) => {
      R.remove(b, ids);
      R.gravity(b, this.heightOf);
    });
    this.select([]);
    this.flight.note("transition", "cut", { ids: ids.size });
    return c;
  }

  /** Puts `clip` on the board near `centre`, by default the middle of the view, and selects the copies. */
  paste(clip: Clip, centre: Point = this.view.toWorld(this.view.centre())) {
    if (this.model.inGesture) return;
    this.endEditing();
    this.turn(null);
    let ids: string[] = [];
    this.model.perform("Paste", (b) => {
      ids = R.paste(b, clip, { board: this.library?.id ?? "", centre }, this.heightOf);
    });
    if (!ids.length) return;
    this.flight.note("transition", "paste", { ids: ids.length });
    this.select(ids);
    const rs = ids.map((id) => R.card(this.model.board, id)).filter((c) => c).map((c) => this.view.rectOf(c!));
    const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
    this.view.reveal({ x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y }, "top", 48);
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
  reveal(m: Match) {
    const s = this.state;
    const b = this.model.board;
    s.found = m.id;
    const c = R.card(b, m.id);
    this.turn(m.side === "back" ? m.id : null);
    const l = !c && R.lane(b, m.id);
    if (c || l) this.view.centreOn(c ? this.view.rectOf(c) : R.laneRect(l as Lane));
    this.view.invalidate();
  }
}
