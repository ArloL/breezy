// The app's ports without a DOM, for running the app's core in Node: what the board shows is its scene.
import { Camera, clampZoom } from "../camera.ts";
import * as R from "../rules.ts";
import { sceneOf } from "../scene.ts";
import type { App } from "../app.ts";
import type { Area, Shown } from "../view.ts";
import type { Ports, PresencePort, UIPort, ViewPort } from "../ports.ts";
import type { Board, Cam, Card, Point, Rect } from "../types.ts";

/** Card heights as both device kinds measure them in tests: 24 + 24 per line, as the Mac and browsers draw text too
 * short to wrap. */
export const fakeHeight = (text: string | undefined) => 24 + 24 * Math.max(1, String(text ?? "").split("\n").length);

export const AREA: Area = { top: 0, bottom: 800, left: 0, right: 1200 };

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

  editorOf(): HTMLElement {
    throw new Error("editing needs an editor port, which the fakes do not have yet");
  }

  titleOf(): HTMLElement {
    throw new Error("renaming needs an editor port, which the fakes do not have yet");
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
