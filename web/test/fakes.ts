// The app's ports without a DOM, for running the app's core in Node: what the board shows is its scene.
import { Camera, clampZoom, revealing } from "../camera.ts";
import * as R from "../rules.ts";
import { sceneOf } from "../scene.ts";
import type { App } from "../app.ts";
import type { Area, Shown } from "../view.ts";
import type { Field, FieldEvents, Ports, PresencePort, UIPort, ViewPort } from "../ports.ts";
import type { Board, Cam, Card, Point, Rect } from "../types.ts";

/** Card heights as both device kinds measure them in tests: 24 + 24 per line, as the Mac and browsers draw text too
 * short to wrap. */
export const fakeHeight = (text: string | undefined) => 24 + 24 * Math.max(1, String(text ?? "").split("\n").length);

/** A device's screen in points: the board shows between `top` and `bottom` at rest, and a phone's keyboard, `keyboard`
 * tall, comes `keyboardMs` after an editor takes focus and goes as long after it lets go. */
export interface Screen {
  w: number;
  h: number;
  top: number;
  bottom: number;
  keyboard: number;
  keyboardMs: number;
}

export const DESKTOP: Screen = { w: 1200, h: 800, top: 0, bottom: 800, keyboard: 0, keyboardMs: 0 };
/** The iPhone 17's, from its simulator: the board between the top bar and the bottom bar, and the keyboard with its
 * suggestions. To be measured against the real one by a contract suite. */
export const PHONE: Screen = { w: 402, h: 874, top: 120, bottom: 774, keyboard: 336, keyboardMs: 300 };
/** The keys bar a phone shows on its keyboard while editing, as ui.ts's. */
const KEYS_H = 44;

/** What the board shows of the screen, the edited card and its caret, in screen points: for a scenario to check the card
 * is in sight. */
export interface Sight {
  focus: Rect | null;
  caret: Rect | null;
  visible: Rect;
}

/** A field as a string with the caret at its end; typing goes to the one the view says has the keyboard. */
export class FakeField implements Field {
  view: FakeView;
  value = "";
  on: FieldEvents | null = null;
  /** Whether all of it is selected, so that typing replaces it. */
  selected = false;

  constructor(view: FakeView) {
    this.view = view;
  }

  open(text: string, on: FieldEvents) {
    this.value = text;
    this.selected = false;
    this.on = on;
    this.view.focus(this);
  }

  text() {
    return this.value;
  }

  caret() {
    return this.view.focused === this ? this.value.length : null;
  }

  detach() {
    this.on = null;
  }

  close() {
    this.detach();
    if (this.view.focused === this) this.view.focus(null);
  }

  /** Keys typed at the caret, over the text when it is all selected; Return ends a field that Return ends. */
  type(keys: string) {
    for (const k of keys) {
      if (k === "\n" && this.on?.enter) {
        this.on.enter();
        continue;
      }
      this.value = (this.selected ? "" : this.value) + k;
      this.selected = false;
      this.on?.input();
    }
  }

  /** A key the field takes before the board, as a browser gives the focused element its keys first; false if not. */
  key(key: string, meta: boolean) {
    if (meta && key === "a") return (this.selected = true);
    if (!meta && key === "Enter" && this.on?.enter) {
      this.type("\n");
      return true;
    }
    return false;
  }
}

export class FakeView implements ViewPort {
  app: App;
  camera: Camera;
  els = new Map<string, Shown>();
  ready = false;
  screen: Screen = DESKTOP;
  /** Whether a phone's keyboard is up. */
  keyboard = false;
  private keyboardTimer: ReturnType<typeof setTimeout> | undefined;
  area = () => this.screenArea();
  onCamera = () => {};
  onRender = () => {};
  shown: () => Board;
  heightOf = (id: string) => fakeHeight(R.card(this.shown(), id)?.text);

  constructor(app: App) {
    this.app = app;
    this.shown = () => app.model.board;
    // a camera's frames on the device's clock, which the hub may make virtual
    this.camera = new Camera(() => this.onCamera(), {
      now: () => performance.now(),
      raf: (f) => setTimeout(() => f(performance.now()), 16) as unknown as number,
      caf: (id) => clearTimeout(id),
    });
  }

  get cam(): Cam {
    return this.camera.cam;
  }

  frontHeight(text: string) {
    return fakeHeight(text);
  }

  rectOf(c: Card): Rect {
    return R.cardRect(c, this.heightOf(c.id));
  }

  toWorld(p: Point): Point {
    const { x, y, zoom } = this.cam;
    return { x: (p.x - x) / zoom, y: (p.y - y) / zoom };
  }

  toScreen(p: Point): Point {
    const { x, y, zoom } = this.cam;
    return { x: p.x * zoom + x, y: p.y * zoom + y };
  }

  setCamera(cam: Cam, animate = false) {
    if (animate) this.camera.springTo({ ...cam, zoom: clampZoom(cam.zoom) });
    else this.camera.set(cam);
  }

  /** What the board shows through: between the bars, and above a phone's keyboard and its keys bar while it is up. */
  screenArea(): Area {
    const s = this.screen;
    return { top: s.top, bottom: this.keyboard ? s.h - s.keyboard - KEYS_H : s.bottom, left: 0, right: s.w };
  }

  /** Whether the camera has stopped and no keyboard is on its way. */
  still() {
    return !this.camera.moving && this.keyboardTimer === undefined;
  }

  zoomAround(c: Point, zoom: number, animate = false) {
    const z = clampZoom(zoom);
    const w = this.toWorld(c);
    this.setCamera({ x: c.x - w.x * z, y: c.y - w.y * z, zoom: z }, animate);
  }

  centre(): Point {
    const a = this.area();
    return { x: (a.left + a.right) / 2, y: (a.top + a.bottom) / 2 };
  }

  centreOn(r: Rect) {
    const c = this.centre();
    const { zoom } = this.cam;
    this.setCamera({ zoom, x: c.x - (r.x + r.w / 2) * zoom, y: c.y - (r.y + r.h / 2) * zoom });
  }

  reveal(r: Rect, prefer: "top" | "bottom" = "top") {
    const to = revealing(this.camera.goal(), r, this.area(), prefer);
    if (to) this.setCamera(to, true);
  }

  /** Where offset `at` of card `id`'s side falls on screen: its line, 24 pt each below a 12 pt margin. */
  caretRect(id: string, back: boolean, at: number) {
    const c = R.card(this.shown(), id);
    if (!c) return null;
    const lines = String((back ? c.notes : c.text) ?? "").slice(0, at).split("\n").length;
    const { zoom } = this.cam, s = this.toScreen({ x: c.x, y: c.y });
    return { x: s.x + 12 * zoom, y: s.y + (12 + 24 * (lines - 1)) * zoom, h: 24 * zoom };
  }

  invalidate() {}

  render() {
    this.ready = true;
    this.onRender();
  }

  animateTurn(_ids: string[], change: () => void) {
    change();
  }

  fields = new Map<string, FakeField>();
  /** The field with the keyboard. */
  focused: FakeField | null = null;

  /** Gives `f` the keyboard, or takes it away; the one that had it loses it, as a blur in a browser. On a phone touched,
   * the keyboard comes or goes a moment later, and the app keeps what it edits in sight of it, as on a resize of the
   * visual viewport. */
  focus(f: FakeField | null) {
    const was = this.focused;
    this.focused = f;
    if (was && was !== f) was.on?.done();
    const up = f !== null && this.app.touching && this.screen.keyboard > 0;
    clearTimeout(this.keyboardTimer);
    this.keyboardTimer = undefined;
    if (up === this.keyboard) return;
    this.keyboardTimer = setTimeout(() => {
      this.keyboardTimer = undefined;
      this.keyboard = up;
      this.app.revealEditing();
    }, this.screen.keyboardMs);
  }

  /** The card being edited and its caret's line, and what of the screen the board shows. */
  sight(): Sight {
    const e = this.app.state.editing;
    const c = e && R.card(this.shown(), e.id);
    const visible = this.area(), v = { x: visible.left, y: visible.top, w: visible.right - visible.left, h: visible.bottom - visible.top };
    if (!e || !c) return { focus: null, caret: null, visible: v };
    const r = this.rectOf(c), { zoom } = this.cam, s = this.toScreen(r);
    const caret = this.caretRect(e.id, e.back, this.editorOf(e.id, e.back)?.caret() ?? 0);
    return { focus: { x: s.x, y: s.y, w: r.w * zoom, h: r.h * zoom }, caret: caret && { x: caret.x, y: caret.y, w: 0, h: caret.h }, visible: v };
  }

  private field(key: string) {
    let f = this.fields.get(key);
    if (!f) this.fields.set(key, (f = new FakeField(this)));
    return f;
  }

  editorOf(id: string, back: boolean) {
    return R.card(this.shown(), id) ? this.field(`${id} ${back}`) : null;
  }

  titleOf(id: string) {
    return R.lane(this.shown(), id) ? this.field(`${id} title`) : null;
  }

  scene() {
    return sceneOf(this.shown(), this.app.state, (c) => this.rectOf(c), this.cam);
  }
}

export class FakeUI implements UIPort {
  app: App;
  menus = { attach() {} };
  haptics = 0;
  haptic() {
    this.haptics++;
  }
  update() {}
  updateSync() {}
  updateZoom() {}
  constructor(app: App) {
    this.app = app;
  }

  area() {
    return (this.app.view as FakeView).screenArea();
  }
  closeMenu() {}
  openFind() {}
  findStep() {}
  closeFind() {}
  find() {}
  act() {}
}

export class FakePresence implements PresencePort {
  place() {}
  show() {}
}

export const fakePorts: Ports = {
  view: (app) => new FakeView(app),
  presence: () => new FakePresence(),
  ui: (app) => new FakeUI(app),
};
