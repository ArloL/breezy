import * as R from "./rules.js";
import { hitTest, dragAction } from "./policy.js";
import { clampZoom } from "./view.js";

const EDGE = 48;
const EDGE_SPEED = 12;
// a flick coasts about 0.6 s and stops without a crawl
const FRICTION = 0.92;
const STOP = 0.05;

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
    this.stoppedCoast = false;
  }

  hit(p) {
    const { view, state, model } = this.app;
    return hitTest(model.board, view.toWorld(p), { rectOf: (c) => view.rectOf(c), zoom: view.cam.zoom, turned: state.turned });
  }

  /** A touch that stops a coast does only that: the tap that follows from it is ignored. */
  touchStart() {
    this.stoppedCoast = this.coast !== 0;
    this.stopCoast();
    this.app.view.stopGlide();
    this.app.ui.closeMenu();
  }

  tap(p) {
    if (this.stoppedCoast) return;
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
    const s = this.app.state;
    this.app.endEditing();
    if (s.turned && this.holdHit.id !== s.turned) this.app.turn(null);
    s.lifted = new Set([this.holdHit.id]);
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
      if (Math.hypot(vx, vy) < STOP) return (this.coast = 0);
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
