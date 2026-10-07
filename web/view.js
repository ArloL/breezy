import * as R from "./rules.js";

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;
export const clampZoom = (z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

const SHEET = '<div class="sheet"><div class="front"></div><div class="back"><div class="heading"></div><div class="notes"></div></div><div class="ear"></div></div>';
const PLACEHOLDER = "Double-tap to write on the back";

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
    this.cam = { x: 0, y: 0, zoom: 1 };
    this.els = new Map();
    this.sizes = new Map();
    this.frame = 0;
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

  setCamera(cam, animate = false) {
    const zoom = clampZoom(cam.zoom);
    this.cam = { x: cam.x, y: cam.y, zoom };
    this.world.classList.toggle("glide", animate);
    this.root.classList.toggle("glide", animate);
    this.world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${zoom})`;
    const t = R.GRID * zoom;
    this.root.style.backgroundSize = `${t}px ${t}px`;
    this.root.style.backgroundPosition = `${cam.x}px ${cam.y}px`;
    this.root.classList.toggle("no-dots", zoom < 0.4);
    this.onCamera();
  }

  stopGlide() {
    this.world.classList.remove("glide");
    this.root.classList.remove("glide");
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
      e.el.remove();
      this.els.delete(id);
    }
    const m = this.state.marquee;
    this.marqueeEl.hidden = !m;
    if (m) Object.assign(this.marqueeEl.style, { transform: `translate(${m.x}px, ${m.y}px)`, width: `${m.w}px`, height: `${m.h}px` });
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
    const e = this.element(c.id, this.cardsEl, SHEET);
    const key = JSON.stringify([flags, c.x, c.y, r.w, r.h, c.color, c.text, c.notes, i]);
    if (e.key === key) return;
    e.key = key;
    const el = e.el;
    el.className = flags;
    el.style.transform = `translate(${c.x}px, ${c.y}px)`;
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
    const e = this.element(l.id, this.lanesEl, '<div class="header"><div class="title"></div></div><div class="grip"></div>');
    const key = JSON.stringify([flags, l.x, l.y, l.w, l.h, l.title]);
    if (e.key === key) return;
    e.key = key;
    const el = e.el;
    el.className = flags;
    el.style.transform = `translate(${l.x}px, ${l.y}px)`;
    el.style.width = `${l.w}px`;
    el.style.height = `${l.h}px`;
    if (!renaming) el.querySelector(".title").textContent = l.title;
  }

  editorOf(id, back) {
    return this.els.get(id)?.el.querySelector(back ? ".notes" : ".front");
  }

  titleOf(id) {
    return this.els.get(id)?.el.querySelector(".title");
  }

  /** Runs `change` at once and renders; copies of the old faces swing away while the new ones swing in. */
  animateTurn(ids, change) {
    const animate = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ghosts = animate
      ? ids.map((id) => this.els.get(id)?.el).filter(Boolean).map((el) => {
          const g = el.cloneNode(true);
          g.classList.add("ghost");
          g.style.zIndex = 1000001;
          this.cardsEl.append(g);
          return g;
        })
      : [];
    change();
    this.render();
    if (!animate) return;
    const p = "perspective(1000px) ";
    for (const g of ghosts) {
      g.firstChild
        .animate([{ transform: `${p}rotateY(0deg)` }, { transform: `${p}rotateY(90deg)` }], { duration: 130, easing: "ease-in", fill: "forwards" })
        .finished.then(() => g.remove());
    }
    for (const id of ids) {
      this.els.get(id)?.el.firstChild.animate([{ transform: `${p}rotateY(-90deg)` }, { transform: `${p}rotateY(0deg)` }],
        { duration: 130, delay: 130, easing: "ease-out", fill: "backwards" });
    }
  }
}
