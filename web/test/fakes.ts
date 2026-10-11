// The app's ports without a DOM, for running the app's core in Node: what the board shows is its scene.
import { Camera, clampZoom } from "../camera.ts";
import * as R from "../rules.ts";
import { sceneOf } from "../scene.ts";
import type { App } from "../app.ts";
import type { Area, Shown } from "../view.ts";
import type { Field, FieldEvents, Ports, PresencePort, UIPort, ViewPort } from "../ports.ts";
import type { Board, Cam, Card, Point, Rect } from "../types.ts";

/** Card heights as both device kinds measure them in tests: 24 + 24 per line, as the Mac and browsers draw text too
 * short to wrap. */
export const fakeHeight = (text: string | undefined) => 24 + 24 * Math.max(1, String(text ?? "").split("\n").length);

export const AREA: Area = { top: 0, bottom: 800, left: 0, right: 1200 };

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
    if (this.view.focused === this) this.view.focused = null;
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
  area = () => AREA;
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
    this.camera.set(animate ? { ...cam, zoom: clampZoom(cam.zoom) } : cam);
  }

  zoomAround(c: Point, zoom: number, animate = false) {
    const z = clampZoom(zoom);
    const w = this.toWorld(c);
    this.setCamera({ x: c.x - w.x * z, y: c.y - w.y * z, zoom: z }, animate);
  }

  centre(): Point {
    return { x: (AREA.left + AREA.right) / 2, y: (AREA.top + AREA.bottom) / 2 };
  }

  centreOn(r: Rect) {
    const c = this.centre();
    const { zoom } = this.cam;
    this.setCamera({ zoom, x: c.x - (r.x + r.w / 2) * zoom, y: c.y - (r.y + r.h / 2) * zoom });
  }

  reveal() {}

  caretRect() {
    return null;
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

  /** Gives `f` the keyboard; the one that had it loses it, as a blur in a browser. */
  focus(f: FakeField) {
    const was = this.focused;
    this.focused = f;
    if (was && was !== f) was.on?.done();
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
  menus = { attach() {} };
  haptics = 0;
  haptic() {
    this.haptics++;
  }
  update() {}
  updateSync() {}
  updateZoom() {}
  area() {
    return AREA;
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
  ui: () => new FakeUI(),
};
