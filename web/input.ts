import * as R from "./rules.js";
import { hitTest, dragAction } from "./policy.js";
import { MIN_ZOOM, MAX_ZOOM } from "./view.js";
import { EDGE_ZONE, edgeSpeed } from "./physics.js";
import { haptic } from "./haptics.js";

// a one-finger zoom doubles or halves for every this many points the finger moves
const ZOOM_DRAG = 150;

const isCard = (h) => h?.kind === "card" || h?.kind === "fold";

/** Turns gestures into camera moves and board changes. */
export class Input {
  constructor(app) {
    this.app = app;
    this.drag = null;
    this.pinchBase = null;
    this.holdHit = null;
    this.scroll = 0;
    this.stoppedCoast = false;
  }

  hit(p, touch = true) {
    const { view, state, model } = this.app;
    return hitTest(model.board, view.toWorld(p), { rectOf: (c) => view.rectOf(c), zoom: view.cam.zoom, turned: state.turned, touch });
  }

  /** A touch that stops the camera moving does only that: the tap that follows from it is ignored. */
  touchStart() {
    this.stoppedCoast = this.app.view.camera.moving;
    this.stopCoast();
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

  /** As on the Mac: edit a card, rename a lane; a new card's top-left goes where the pointer is. */
  doubleClick(p, h) {
    const app = this.app;
    if (isCard(h)) return app.beginEdit(h.id);
    if (h.kind === "header") return app.beginRename(h.id);
    if (h.kind === "empty") app.newCard(app.view.toWorld(p), "corner");
  }

  hold(p) {
    this.holdHit = this.hit(p);
    if (!isCard(this.holdHit)) return;
    const s = this.app.state;
    this.app.endEditing();
    if (s.turned && this.holdHit.id !== s.turned) this.app.turn(null);
    s.lifted = new Set([this.holdHit.id]);
    haptic();
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
    const h = held && this.holdHit ? this.holdHit : this.hit(p0);
    this.holdHit = null;
    // a touch box starts afresh
    this.beginDrag(dragAction(h, this.app.state.selection, held), h, p0, p, []);
  }

  /** Starts drag `action` on hit `h`, pressed at screen point `p0` and now at `p`. A box adds to selection `base`. */
  beginDrag(action, h, p0, p, base = [...this.app.state.selection]) {
    const app = this.app;
    const s = app.state;
    const b = app.model.board;
    // what someone else holds stays where it is
    if (["move", "lane", "resize"].includes(action) && s.taken.has(h.id)) return;
    if (action !== "pan") {
      app.endEditing();
      if (s.turned && h.id !== s.turned) app.turn(null);
    }
    const d = { action, id: h.id, p0, w0: app.view.toWorld(p0), cam0: { ...app.view.cam }, sel0: [...s.selection], last: p };
    this.edgeSince = 0;
    this.drag = d;
    if (action === "move") {
      if (!s.selection.has(h.id)) app.select([h.id]);
      const ids = new Set(app.selectedCards().map((c) => c.id));
      d.origins = app.selectedCards().map((c) => ({ id: c.id, x: c.x, y: c.y }));
      d.room = { base: R.layout(b, ids), heightOf: app.heightOf };
      s.held = new Set(ids);
      s.lifted = new Set(ids);
      app.model.begin();
      app.hold(ids);
    } else if (action === "lane") {
      app.select([h.id]);
      const l = R.lane(b, h.id);
      d.laneOrigin = { id: l.id, x: l.x, y: l.y };
      d.origins = R.cardsInLane(b, h.id, app.heightOf).map((c) => ({ id: c.id, x: c.x, y: c.y }));
      s.held = new Set([h.id, ...d.origins.map((o) => o.id)]);
      if ([...s.held].some((id) => s.taken.has(id))) {
        s.held = new Set();
        this.drag = null;
        return;
      }
      app.model.begin();
      app.hold(s.held);
    } else if (action === "resize") {
      app.select([h.id]);
      const l = R.lane(b, h.id);
      d.size = { w: l.w, h: l.h };
      s.held = new Set([h.id]);
      app.model.begin();
      app.hold([h.id]);
    } else if (action === "marquee") {
      d.base = base;
      app.select(base);
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
    if (d.action === "move") {
      app.model.update((b) => R.moveCards(b, d.origins, dx, dy, d.room));
      this.float(d.origins[0], R.card(app.model.board, d.origins[0].id), dx, dy);
    }
    if (d.action === "lane") {
      app.model.update((b) => R.moveLane(b, d.laneOrigin, d.origins, dx, dy));
      this.float(d.laneOrigin, R.lane(app.model.board, d.id), dx, dy);
    }
    if (d.action === "resize") {
      app.model.update((b) => R.resizeLane(b, d.id, d.size.w + dx, d.size.h + dy));
      const l = R.lane(app.model.board, d.id);
      app.state.float = { w: Math.max(R.LANE_MIN, d.size.w + dx) - l.w, h: Math.max(R.LANE_MIN, d.size.h + dy) - l.h };
    }
    // others see what floats where it floats, which the model's change came too early to say
    if (["move", "lane", "resize"].includes(d.action)) app.library?.session?.edited();
    if (d.action === "marquee") {
      const r = { x: Math.min(d.w0.x, w.x), y: Math.min(d.w0.y, w.y), w: Math.abs(dx), h: Math.abs(dy) };
      app.state.marquee = r;
      app.select([...d.base, ...R.cardsInRect(app.model.board, r, app.heightOf).map((c) => c.id)]);
    }
    this.edgeScroll(p);
  }

  /** What a finger holds follows it exactly; the board keeps it on the grid, where it lands on release. */
  float(origin, now, dx, dy) {
    this.app.state.float = now ? { x: origin.x + dx - now.x, y: origin.y + dy - now.y } : null;
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
    s.float = null;
    if (d.action === "pan") this.coastFrom(v);
    if (d.action === "move") {
      app.model.update((b) => R.land(b, new Set(d.origins.map((o) => o.id)), d.room));
      app.model.end("Move");
      haptic();
    }
    if (d.action === "lane") app.model.end("Move Lane");
    if (d.action === "resize") app.model.end("Resize Lane");
    if (d.action === "marquee") s.marquee = null;
    app.view.invalidate();
  }

  /** Puts the camera, the board and the selection back as they were when the drag began. */
  dragCancel() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    cancelAnimationFrame(this.scroll);
    const app = this.app;
    const s = app.state;
    s.held = new Set();
    s.lifted = new Set();
    s.float = null;
    s.marquee = null;
    // a pan may happen during an edit session, which must survive it
    if (d.action !== "pan" && d.action !== "marquee") app.model.cancel();
    if (d.action !== "pan") app.select(d.sel0);
    app.view.setCamera(d.cam0);
    app.view.invalidate();
  }

  pinchStart(c) {
    this.stopCoast();
    this.pinchBase = { cam: { ...this.app.view.cam }, c, last: c };
  }

  /** Zooms and pans together: the world point first under the fingers stays under them; past a limit, it stretches. */
  pinch(c, scale) {
    const { cam, c: c0 } = this.pinchBase;
    const raw = cam.zoom * scale;
    const zoom = this.app.view.camera.stretchZoom(raw);
    const past = raw > MAX_ZOOM || raw < MIN_ZOOM;
    if (past && !this.pinchBase.past) haptic();
    this.pinchBase.past = past;
    const wx = (c0.x - cam.x) / cam.zoom;
    const wy = (c0.y - cam.y) / cam.zoom;
    this.pinchBase.last = c;
    this.app.view.setCamera({ zoom, x: c.x - wx * zoom, y: c.y - wy * zoom });
  }

  /** A zoom past a limit springs back around the fingers; otherwise the pan coasts on. */
  pinchEnd(v) {
    const c = this.pinchBase?.last;
    this.pinchBase = null;
    if (c) this.app.view.camera.settle(c, v);
  }

  pinchCancel() {
    this.app.view.setCamera(this.pinchBase.cam);
    this.pinchBase = null;
  }

  zoomDragStart(p) {
    this.stopCoast();
    this.pinchBase = { cam: { ...this.app.view.cam }, c: p };
  }

  /** Down zooms in, up zooms out, as in Maps; the point first touched stays put. */
  zoomDrag(dy) {
    this.pinch(this.pinchBase.c, 2 ** (dy / ZOOM_DRAG));
  }

  zoomDragEnd() {
    const c = this.pinchBase?.c;
    this.pinchBase = null;
    if (c) this.app.view.camera.settle(c);
  }

  zoomDragCancel() {
    this.pinchCancel();
  }

  /** At the very edge of the visible area a drag scrolls the board, slowly at first and faster the longer it stays, as in Freeform. */
  edgeScroll(p) {
    cancelAnimationFrame(this.scroll);
    const a = this.app.ui.area();
    const dir = (v, lo, hi) => (v - lo <= EDGE_ZONE ? 1 : hi - v <= EDGE_ZONE ? -1 : 0);
    const dx = dir(p.x, a.left, a.right);
    const dy = dir(p.y, a.top, a.bottom);
    if (!dx && !dy) {
      this.edgeSince = 0;
      return;
    }
    const now = performance.now();
    if (!this.edgeSince) this.edgeSince = this.edgeLast = now;
    this.scroll = requestAnimationFrame((t) => {
      if (!this.drag) return;
      const dt = Math.min(64, Math.max(0, t - this.edgeLast));
      this.edgeLast = t;
      const d = edgeSpeed(0, t - this.edgeSince) * dt;
      const c = this.app.view.cam;
      this.app.view.setCamera({ ...c, x: c.x + dx * d, y: c.y + dy * d });
      this.dragMove(this.drag.last);
    });
  }

  coastFrom(v) {
    this.app.view.camera.coast(v);
  }

  stopCoast() {
    this.app.view.camera.stop();
  }
}
