import * as R from "./rules.js";
import { Camera, clampZoom } from "./camera.js";
import { animate, motionValue } from "./motion.js";

export { MIN_ZOOM, MAX_ZOOM, clampZoom } from "./camera.js";

const SHEET = '<div class="sheet"><div class="front"></div><div class="back"><div class="heading"></div><div class="notes"></div></div><div class="ear"></div></div>';
const PLACEHOLDER = "Double-tap to write on the back";
// Layout moves settle like UIKit's default spring; a lift pops slightly, as a drag lift on iOS does.
const SETTLE = { type: "spring", visualDuration: 0.35, bounce: 0 };
const LIFT = { type: "spring", visualDuration: 0.25, bounce: 0.35 };
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Draws the board as DOM in a world layer moved by the camera; measures card heights with the same CSS. */
export class View {
  constructor(root, model, state) {
    this.root = root;
    this.model = model;
    this.state = state;
    this.world = root.querySelector(".world");
    this.lanesEl = root.querySelector(".lanes");
    this.cardsEl = root.querySelector(".cards");
    this.marqueeEl = root.querySelector(".marquee");
    const m = document.querySelector(".measure");
    m.innerHTML = `<div class="card">${SHEET}</div><div class="card turned">${SHEET}</div>`;
    [this.mFront, this.mBack] = m.children;
    this.camera = new Camera((c) => this.apply(c));
    this.els = new Map();
    this.sizes = new Map();
    this.frame = 0;
    this.ready = false;
    this.area = () => ({ top: 0, bottom: innerHeight, left: 0, right: innerWidth });
    this.onCamera = () => {};
    this.heightOf = (id) => {
      const c = R.card(this.model.board, id);
      return c ? this.frontHeight(c.text, c.w) : 0;
    };
    addEventListener("resize", () => this.invalidate());
  }

  /** A trailing newline counts as a line, as the editor shows it. */
  frontHeight(text, w) {
    return this.cached(`f|${w}|${text}`, () => {
      this.mFront.style.width = `${w}px`;
      const f = this.mFront.querySelector(".front");
      f.textContent = !text || text.endsWith("\n") ? text + "\u200b" : text;
      return Math.max(1, Math.ceil((f.offsetHeight - R.GRID) / R.GRID)) * R.GRID + R.GRID;
    });
  }

  backHeight(c, w) {
    const title = c.text.split("\n")[0];
    const notes = c.notes || PLACEHOLDER;
    return this.cached(`b|${w}|${title}|${notes}`, () => {
      this.mBack.style.width = `${w}px`;
      const head = this.mBack.querySelector(".heading");
      const body = this.mBack.querySelector(".notes");
      head.textContent = title || "\u200b";
      body.textContent = notes.endsWith("\n") ? notes + "\u200b" : notes;
      return Math.max(R.BACK_MIN_H, Math.ceil((head.offsetHeight + body.offsetHeight) / R.GRID) * R.GRID + 2 * R.GRID);
    });
  }

  cached(key, measure) {
    let h = this.sizes.get(key);
    if (h === undefined) {
      if (this.sizes.size > 10000) this.sizes.clear();
      h = measure();
      this.sizes.set(key, h);
    }
    return h;
  }

  /** A turned card is 480 wide, or the screen less 32 pt if that is narrower, but never narrower than its front. */
  backWidth() {
    return Math.max(R.CARD_W, Math.min(R.BACK_W, (innerWidth - 32) / this.cam.zoom));
  }

  rectOf(c) {
    if (c.id !== this.state.turned) return R.cardRect(c, this.frontHeight(c.text, c.w));
    const w = this.backWidth();
    return { x: c.x, y: c.y, w, h: this.backHeight(c, w) };
  }

  toWorld(p) {
    const { x, y, zoom } = this.cam;
    return { x: (p.x - x) / zoom, y: (p.y - y) / zoom };
  }

  toScreen(p) {
    const { x, y, zoom } = this.cam;
    return { x: p.x * zoom + x, y: p.y * zoom + y };
  }

  get cam() {
    return this.camera.cam;
  }

  /** Moves the camera at once, or with a spring that a touch can catch. Gestures pass zooms past the limits on purpose. */
  setCamera(cam, animate = false) {
    if (animate && !matchMedia("(prefers-reduced-motion: reduce)").matches) this.camera.springTo({ ...cam, zoom: clampZoom(cam.zoom) });
    else this.camera.set(animate ? { ...cam, zoom: clampZoom(cam.zoom) } : cam);
  }

  apply({ x, y, zoom }) {
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    const t = R.GRID * zoom;
    this.root.style.backgroundSize = `${t}px ${t}px`;
    this.root.style.backgroundPosition = `${x}px ${y}px`;
    this.root.classList.toggle("no-dots", zoom < 0.4);
    this.onCamera();
  }

  /** Zooms keeping the world point under screen point `c` in place. */
  zoomAround(c, zoom, animate = false) {
    const z = clampZoom(zoom);
    const w = this.toWorld(c);
    this.setCamera({ x: c.x - w.x * z, y: c.y - w.y * z, zoom: z }, animate);
  }

  centre() {
    const a = this.area();
    return { x: (a.left + a.right) / 2, y: (a.top + a.bottom) / 2 };
  }

  /** Pans the least needed to show world rect `r`; a rect too tall to fit shows its `prefer` edge. */
  reveal(r, prefer = "top") {
    const a = this.area();
    const pad = 16;
    const { zoom } = this.cam;
    let { x, y } = this.cam;
    const s = this.toScreen(r);
    const w = r.w * zoom;
    const h = r.h * zoom;
    if (w + 2 * pad > a.right - a.left || s.x < a.left + pad) x += a.left + pad - s.x;
    else if (s.x + w > a.right - pad) x += a.right - pad - (s.x + w);
    if (h + 2 * pad > a.bottom - a.top) y += prefer === "bottom" ? a.bottom - pad - (s.y + h) : a.top + pad - s.y;
    else if (s.y < a.top + pad) y += a.top + pad - s.y;
    else if (s.y + h > a.bottom - pad) y += a.bottom - pad - (s.y + h);
    if (x !== this.cam.x || y !== this.cam.y) this.setCamera({ x, y, zoom }, true);
  }

  centreOn(r) {
    const c = this.centre();
    const { zoom } = this.cam;
    this.setCamera({ zoom, x: c.x - (r.x + r.w / 2) * zoom, y: c.y - (r.y + r.h / 2) * zoom }, true);
  }

  invalidate() {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.render());
  }

  render() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    const b = this.model.board;
    const live = new Set();
    for (const l of b.lanes) {
      live.add(l.id);
      this.renderLane(l);
    }
    b.cards.forEach((c, i) => {
      live.add(c.id);
      this.renderCard(c, i);
    });
    for (const [id, e] of this.els) {
      if (live.has(id)) continue;
      this.els.delete(id);
      this.vanish(e);
    }
    const m = this.state.marquee;
    this.marqueeEl.hidden = !m;
    if (m) Object.assign(this.marqueeEl.style, { transform: `translate(${m.x}px, ${m.y}px)`, width: `${m.w}px`, height: `${m.h}px` });
    this.ready = true;
  }

  /**
   * Moves element `e` to (x, y): what a finger holds follows it at once, everything else springs there, carrying
   * the speed it had, so a dropped card leaves the finger as it was moving. Things that appear after the first
   * render grow in.
   */
  place(e, x, y, held, scale = 1) {
    const still = reduced();
    if (!e.mx) {
      const grow = this.ready && !still;
      e.mx = motionValue(x);
      e.my = motionValue(y);
      e.ms = motionValue(grow ? 0.9 : scale);
      const draw = () => (e.el.style.transform = `translate(${e.mx.get()}px, ${e.my.get()}px) scale(${e.ms.get()})`);
      for (const v of [e.mx, e.my, e.ms]) v.on("change", draw);
      draw();
      e.to = { x, y, scale: e.ms.get() };
      if (grow) animate(e.el, { opacity: [0, 1] }, { duration: 0.2 });
    }
    for (const [k, v, to] of [["x", e.mx, x], ["y", e.my, y]]) {
      if (held || still) {
        v.stop();
        v.set(to);
      } else if (e.to[k] !== to) animate(v, to, SETTLE);
      e.to[k] = to;
    }
    if (e.to.scale !== scale) {
      if (still) e.ms.jump(scale);
      else animate(e.ms, scale, LIFT);
      e.to.scale = scale;
    }
  }

  /** A deleted card or lane shrinks and fades while the others close up. */
  vanish(e) {
    if (!this.ready || reduced() || !e.ms) return e.el.remove();
    e.el.style.pointerEvents = "none";
    animate(e.el, { opacity: 0 }, { duration: 0.2 });
    animate(e.ms, 0.9, SETTLE).then(() => e.el.remove());
  }

  element(id, parent, html) {
    let e = this.els.get(id);
    if (!e) {
      const el = document.createElement("div");
      el.innerHTML = html;
      parent.append(el);
      e = { el, key: "" };
      this.els.set(id, e);
    }
    return e;
  }

  renderCard(c, i) {
    const s = this.state;
    const editing = s.editing?.id === c.id ? s.editing : null;
    const turned = s.turned === c.id;
    const r = this.rectOf(c);
    const flags = ["card", c.notes && "notes", turned && "turned", s.selection.has(c.id) && "selected", s.held.has(c.id) && "held",
      s.lifted.has(c.id) && "lifted", s.found === c.id && "found", editing && "editing"].filter(Boolean).join(" ");
    const f = s.held.has(c.id) && s.float?.x !== undefined ? s.float : { x: 0, y: 0 };
    const e = this.element(c.id, this.cardsEl, SHEET);
    const key = JSON.stringify([flags, c.x + f.x, c.y + f.y, r.w, r.h, c.color, c.text, c.notes, i]);
    if (e.key === key) return;
    e.key = key;
    const el = e.el;
    el.className = flags;
    this.place(e, c.x + f.x, c.y + f.y, s.held.has(c.id), s.lifted.has(c.id) ? 1.05 : 1);
    el.style.width = `${r.w}px`;
    el.style.height = `${r.h}px`;
    el.style.zIndex = turned || s.lifted.has(c.id) ? 1000000 : i;
    const sheet = el.firstChild;
    sheet.className = `sheet c${c.color}`;
    const [front, back] = sheet.children;
    const [heading, notes] = back.children;
    if (!editing || editing.back) front.textContent = c.text;
    heading.textContent = c.text.split("\n")[0];
    if (!editing || !editing.back) {
      notes.textContent = c.notes || PLACEHOLDER;
      notes.classList.toggle("placeholder", !c.notes);
    }
  }

  renderLane(l) {
    const s = this.state;
    const renaming = s.renaming === l.id;
    const flags = ["lane", s.selection.has(l.id) && "selected", s.held.has(l.id) && "held", s.found === l.id && "found",
      renaming && "renaming"].filter(Boolean).join(" ");
    const f = { x: 0, y: 0, w: 0, h: 0, ...(s.held.has(l.id) && s.float) };
    const e = this.element(l.id, this.lanesEl, '<div class="header"><div class="title"></div></div><div class="grip"></div>');
    const key = JSON.stringify([flags, l.x + f.x, l.y + f.y, l.w + f.w, l.h + f.h, l.title]);
    if (e.key === key) return;
    e.key = key;
    const el = e.el;
    el.className = flags;
    this.place(e, l.x + f.x, l.y + f.y, s.held.has(l.id));
    el.style.width = `${l.w + f.w}px`;
    el.style.height = `${l.h + f.h}px`;
    if (!renaming) el.querySelector(".title").textContent = l.title;
  }

  editorOf(id, back) {
    return this.els.get(id)?.el.querySelector(back ? ".notes" : ".front");
  }

  titleOf(id) {
    return this.els.get(id)?.el.querySelector(".title");
  }

  /** Runs `change` at once and renders; the card flips over in one springy turn, showing the new face past halfway. */
  animateTurn(ids, change) {
    if (reduced()) {
      change();
      return this.render();
    }
    const ghosts = ids.map((id) => this.els.get(id)?.el).filter(Boolean).map((el) => {
      const g = el.cloneNode(true);
      g.classList.add("ghost");
      g.style.zIndex = 1000001;
      this.cardsEl.append(g);
      return g;
    });
    change();
    this.render();
    const fresh = ids.map((id) => this.els.get(id)?.el.firstChild).filter(Boolean);
    const p = "perspective(1000px) ";
    const turn = (a) => {
      for (const g of ghosts) {
        g.style.visibility = a < 90 ? "" : "hidden";
        g.firstChild.style.transform = `${p}rotateY(${a}deg)`;
      }
      for (const s of fresh) {
        s.style.visibility = a < 90 ? "hidden" : "";
        s.style.transform = `${p}rotateY(${a - 180}deg)`;
      }
    };
    const cards = [...ghosts, ...fresh.map((s) => s.parentElement)];
    for (const el of cards) el.classList.add("flipping");
    turn(0);
    animate(0, 180, { type: "spring", visualDuration: 0.45, bounce: 0.2, onUpdate: turn }).then(() => {
      for (const g of ghosts) g.remove();
      for (const s of fresh) s.style.transform = s.style.visibility = "";
      for (const el of cards) el.classList.remove("flipping");
    });
  }
}
