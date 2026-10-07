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

  /** One change, one step; during a gesture it joins the gesture's step instead. */
  perform(name, change) {
    if (this.inGesture) return this.update(change);
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
