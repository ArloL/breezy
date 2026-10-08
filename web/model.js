import { rebase } from "./rebase.js";

export const UNDO_LIMIT = 100;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The board being edited, with undo. A change goes through `perform`, or through a gesture
 * (`begin`, `update`…, `end`) such as a drag or an edit session; either records one step, and
 * only when the board changed. A step undoes field by field, so changes from another device made since stay.
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

  /** Ends the gesture, putting the board back as it began. */
  cancel() {
    if (!this.start) return;
    this.board = this.start;
    this.start = null;
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
    to.push({ from: step.to, to: step.from, name: step.name });
    this.board = rebase(step.from, step.to, this.board);
    this.onChange();
  }

  /** Changes from another device, without a step; ignored during a gesture. */
  applyRemote(board) {
    if (this.inGesture) return;
    this.board = board;
    this.onChange();
  }

  /** Another board in place of this one, with no history. */
  replace(board) {
    this.board = board;
    this.start = null;
    this.undos = [];
    this.redos = [];
    this.onChange();
  }

  record(before, name) {
    this.undos.push({ from: structuredClone(this.board), to: before, name });
    if (this.undos.length > UNDO_LIMIT) this.undos.shift();
    this.redos = [];
  }
}
