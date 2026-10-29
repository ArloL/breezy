import { planted } from "./sync/plant.ts";
import * as R from "./rules.ts";
import { CAMERA_SPRING, Camera, clampZoom, revealing } from "./camera.ts";
import { animate, motionValue } from "./motion.ts";
import { DomField, fillFront, frontPoint } from "./field.ts";
import { Grid } from "./grid.ts";
import { FOLD } from "./policy.ts";
import type { Field } from "./ports.ts";
import type { MotionValue } from "./motion.ts";
import type { Model } from "./model.ts";
import type { State } from "./app.ts";
import type { Board, Cam, Card, HeightOf, Lane, Point, Rect } from "./types.ts";

export { MIN_ZOOM, MAX_ZOOM, clampZoom } from "./camera.ts";

const SHEET = '<div class="sheet"><div class="front"></div><div class="back"><div class="heading"></div><div class="notes"></div></div><div class="ear"></div></div>';
const PLACEHOLDER = "Double-tap to write on the back";
// Layout moves settle like UIKit's default spring; a lift pops slightly, as a drag lift on iOS does.
const SETTLE = { type: "spring", visualDuration: 0.35, bounce: 0 };
const LIFT = { type: "spring", visualDuration: 0.25, bounce: 0.35 };
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The part of the screen the board shows through, in screen points. */
export interface Area {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** A card or lane as drawn, and where it is going. */
export interface Shown {
  el: HTMLElement;
  key: string;
  mx?: MotionValue;
  my?: MotionValue;
  ms?: MotionValue;
  to?: { x: number; y: number; scale: number };
}

/** Draws the board as DOM in a world layer moved by the camera; measures card heights with the same CSS. */
/** Where the character at offset `at` of `side`'s text is drawn: on an empty line, the newline ending it, where a caret
 * draws nothing to measure. */
function charRect(side: HTMLElement, at: number) {
  const walk = document.createTreeWalker(side, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
    if (at < n.length) {
      const r = document.createRange();
      r.setStart(n, at);
      r.setEnd(n, at + 1);
      return r.getClientRects()[0] ?? null;
    }
    at -= n.length;
  }
  return null;
}

/** Where the caret of an empty `side` is drawn: at the start of its content, a line high, at the board's zoom. */
function startRect(side: HTMLElement) {
  const b = side.getBoundingClientRect(), cs = getComputedStyle(side), z = side.offsetHeight ? b.height / side.offsetHeight : 1;
  const line = Number.parseFloat(cs.lineHeight) || Number.parseFloat(cs.fontSize) * 1.2;
  return { left: b.left + Number.parseFloat(cs.paddingLeft) * z, top: b.top + Number.parseFloat(cs.paddingTop) * z, height: line * z };
}

export class View {
  root: HTMLElement;
  model: Model;
  state: State;
  world: HTMLElement;
  lanesEl: HTMLElement;
  cardsEl: HTMLElement;
  marqueeEl: HTMLElement;
  mFront: HTMLElement;
  mBack: HTMLElement;
  camera: Camera;
  grid: Grid;
  els: Map<string, Shown>;
  /** Each card turning: how far it is from its front, 0, to its back, 1; with reduced motion only its faces fade. */
  turns: Map<string, { p: MotionValue<number>; fade: boolean }>;
  sizes: Map<string, number>;
  frame: number;
  ready: boolean;
  area: () => Area;
  onCamera: () => void;
  onRender: () => void;
  shown: () => Board;
  heightOf: HeightOf;

  constructor(root: HTMLElement, model: Model, state: State) {
    this.root = root;
    this.model = model;
    this.state = state;
    this.world = root.querySelector<HTMLElement>(".world")!;
    this.lanesEl = root.querySelector<HTMLElement>(".lanes")!;
    this.cardsEl = root.querySelector<HTMLElement>(".cards")!;
    this.marqueeEl = root.querySelector<HTMLElement>(".marquee")!;
    const m = document.querySelector<HTMLElement>(".measure")!;
    m.innerHTML = `<div class="card">${SHEET}</div><div class="card turned">${SHEET}</div>`;
    [this.mFront, this.mBack] = m.children as HTMLCollectionOf<HTMLElement>;
    this.grid = new Grid(root.querySelector<HTMLCanvasElement>(".grid")!);
    this.camera = new Camera((c) => this.apply(c));
    this.els = new Map();
    this.turns = new Map();
    this.sizes = new Map();
    this.frame = 0;
    this.ready = false;
    this.area = () => ({ top: 0, bottom: innerHeight, left: 0, right: innerWidth });
    this.onCamera = () => {};
    this.onRender = () => {};
    /** The board as drawn: the model's, with others' live edits over it. */
    this.shown = () => this.model.board;
    this.heightOf = (id) => {
      const c = R.card(this.model.board, id);
      return c ? this.frontHeight(c.text, c.w) : 0;
    };
    addEventListener("resize", () => this.invalidate());
  }

  /** A trailing newline counts as a line, as the editor shows it. */
  frontHeight(text: string, w: number) {
    return this.cached(`f|${w}|${text}`, () => {
      this.mFront.style.width = `${w}px`;
      const f = this.mFront.querySelector<HTMLElement>(".front")!;
      fillFront(f, !text || text.endsWith("\n") ? text + "\u200b" : text);
      return Math.max(1, Math.ceil((f.offsetHeight - R.GRID) / R.GRID)) * R.GRID + R.GRID;
    });
  }

  backHeight(c: Card, w: number) {
    const title = c.text.split("\n")[0];
    const notes = c.notes || PLACEHOLDER;
    return this.cached(`b|${w}|${title}|${notes}`, () => {
      this.mBack.style.width = `${w}px`;
      const head = this.mBack.querySelector<HTMLElement>(".heading")!;
      const body = this.mBack.querySelector<HTMLElement>(".notes")!;
      head.textContent = title || "\u200b";
      body.textContent = notes.endsWith("\n") ? notes + "\u200b" : notes;
      return Math.max(R.BACK_MIN_H, Math.ceil((head.offsetHeight + body.offsetHeight) / R.GRID) * R.GRID + 2 * R.GRID);
    });
  }

  cached(key: string, measure: () => number) {
    let h = planted("uncached-heights") ? undefined : this.sizes.get(key);
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

  rectOf(c: Card): Rect {
    if (c.id !== this.state.turned) return R.cardRect(c, this.frontHeight(c.text, c.w));
    const w = this.backWidth();
    return { x: c.x, y: c.y, w, h: this.backHeight(c, w) };
  }

  /** Card `c` drawn `p` of the way from its front, 0, to its back, 1, from its top left. */
  turningRect(c: Card, p: number): Rect {
    const w = this.backWidth(), h = this.frontHeight(c.text, c.w);
    return { x: c.x, y: c.y, w: c.w + (w - c.w) * p, h: h + (this.backHeight(c, w) - h) * p };
  }

  toWorld(p: Point): Point {
    const { x, y, zoom } = this.cam;
    return { x: (p.x - x) / zoom, y: (p.y - y) / zoom };
  }

  toScreen(p: Point): Point {
    const { x, y, zoom } = this.cam;
    return { x: p.x * zoom + x, y: p.y * zoom + y };
  }

  get cam(): Cam {
    return this.camera.cam;
  }

  /** Moves the camera at once, or with a spring that a touch can catch. Gestures pass zooms past the limits on purpose. */
  setCamera(cam: Cam, animate = false) {
    if (animate && !matchMedia("(prefers-reduced-motion: reduce)").matches) this.camera.springTo({ ...cam, zoom: clampZoom(cam.zoom) });
    else this.camera.set(animate ? { ...cam, zoom: clampZoom(cam.zoom) } : cam);
  }

  apply({ x, y, zoom }: Cam) {
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    this.grid.draw({ x, y, zoom });
    this.onCamera();
  }

  /** Zooms keeping the world point under screen point `c` in place. */
  zoomAround(c: Point, zoom: number, animate = false) {
    const z = clampZoom(zoom);
    const w = this.toWorld(c);
    this.setCamera({ x: c.x - w.x * z, y: c.y - w.y * z, zoom: z }, animate);
  }

  centre(): Point {
    const a = this.area();
    return { x: (a.left + a.right) / 2, y: (a.top + a.bottom) / 2 };
  }

  /** Pans the least needed to show world rect `r` once the camera gets where it is going, `pad` in from the edges; a
   * rect too tall to fit shows its `prefer` edge. The pan in screen points, or null when none. */
  reveal(r: Rect, prefer: "top" | "bottom" = "top", pad = 16) {
    const from = this.camera.goal(), to = revealing(from, r, this.area(), prefer, pad);
    if (to) this.setCamera(to, true);
    return to && { x: to.x - from.x, y: to.y - from.y };
  }

  centreOn(r: Rect) {
    const c = this.centre();
    const { zoom } = this.cam;
    this.setCamera({ zoom, x: c.x - (r.x + r.w / 2) * zoom, y: c.y - (r.y + r.h / 2) * zoom }, true);
  }

  /** Where offset `at` of card `id`'s front or notes falls on screen, as { x, y, h }; null when that side isn't shown. */
  caretRect(id: string, back: boolean, at: number) {
    const e = this.els.get(id);
    if (!e || back !== (this.state.turned === id)) return null;
    const side = e.el.querySelector<HTMLElement>(back ? ".notes" : ".front")!;
    // an empty side has no text to measure, as the back of a card just turned: its caret is where its text would start,
    // and the board kept the card's bottom in sight instead, the caret under the top bar
    if (!side.textContent) {
      const r = startRect(side);
      return { x: r.left, y: r.top, h: r.height };
    }
    const [node, offset] = back ? [side.firstChild, at] : frontPoint(side, at);
    if (!node || back && !(node instanceof Text)) return null;
    const r = document.createRange();
    r.setStart(node, node instanceof Text ? Math.min(offset, node.length) : 0);
    r.collapse(true);
    let rect: DOMRect | null = r.getClientRects()[0] ?? r.getBoundingClientRect();
    if (!rect.height) rect = charRect(side, at);
    if (!rect?.height) return null;
    return { x: rect.left, y: rect.top, h: rect.height };
  }

  /** Where card `id`'s top is drawn, as caretRect counts, or null when it is not. */
  topOf(id: string): number | null {
    return this.els.get(id)?.el.getBoundingClientRect().top ?? null;
  }

  invalidate() {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.render());
  }

  render() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    const b = this.shown();
    const live = new Set<string>();
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
    this.onRender();
  }

  /**
   * Moves element `e` to (x, y): what a finger holds follows it at once, everything else springs there, carrying
   * the speed it had, so a dropped card leaves the finger as it was moving. Things that appear after the first
   * render grow in.
   */
  place(e: Shown, x: number, y: number, held: boolean, scale = 1) {
    const still = reduced();
    if (!e.mx) {
      const grow = this.ready && !still;
      e.mx = motionValue(x);
      e.my = motionValue(y);
      e.ms = motionValue(grow ? 0.9 : scale);
      const draw = () => (e.el.style.transform = `translate(${e.mx!.get()}px, ${e.my!.get()}px) scale(${e.ms!.get()})`);
      for (const v of [e.mx, e.my, e.ms]) v.on("change", draw);
      draw();
      e.to = { x, y, scale: e.ms.get() };
      if (grow) animate(e.el, { opacity: [0, 1] }, { duration: 0.2 });
    }
    for (const [k, v, to] of [["x", e.mx, x], ["y", e.my!, y]] as const) {
      if (held || still) {
        v.stop();
        v.set(to);
      } else if (e.to![k] !== to) animate(v, to, SETTLE);
      e.to![k] = to;
    }
    if (e.to!.scale !== scale) {
      if (still) e.ms!.jump(scale);
      else animate(e.ms!, scale, LIFT);
      e.to!.scale = scale;
    }
  }

  /** A deleted card or lane shrinks and fades while the others close up. */
  vanish(e: Shown) {
    if (!this.ready || reduced() || !e.ms) return e.el.remove();
    e.el.style.pointerEvents = "none";
    animate(e.el, { opacity: 0 }, { duration: 0.2 });
    animate(e.ms, 0.9, SETTLE).then(() => e.el.remove());
  }

  element(id: string, parent: HTMLElement, html: string): Shown {
    let e = this.els.get(id);
    if (!e) {
      const el = document.createElement("div");
      el.dataset.id = id;
      el.innerHTML = html;
      parent.append(el);
      e = { el, key: "" };
      this.els.set(id, e);
    }
    return e;
  }

  renderCard(c: Card, i: number) {
    const s = this.state;
    const editing = s.editing?.id === c.id ? s.editing : null;
    const turned = s.turned === c.id;
    const t = this.turns.get(c.id), p = t?.p.get() ?? 0;
    const r = t && !t.fade ? this.turningRect(c, p) : this.rectOf(c);
    const who = s.taken.get(c.id);
    const mark = who?.colour ?? s.seen.get(c.id) ?? "";
    const flags = ["card", c.notes && "notes", turned && "turned", t && "turning", s.selection.has(c.id) && "selected", s.held.has(c.id) && "held",
      s.lifted.has(c.id) && "lifted", s.found === c.id && "found", editing && "editing", who && "taken", !who && mark && "seen"].filter(Boolean).join(" ");
    const f = s.held.has(c.id) && s.float?.x !== undefined ? s.float : { x: 0, y: 0 };
    const e = this.element(c.id, this.cardsEl, SHEET);
    const key = JSON.stringify([flags, c.x + f.x, c.y + f.y, r.w, r.h, c.color, c.text, c.notes, i, mark, who?.name, p]);
    if (e.key === key) return;
    e.key = key;
    const el = e.el;
    el.className = flags;
    el.style.setProperty("--who", mark);
    el.dataset.who = who?.name ?? "";
    this.place(e, c.x + f.x, c.y + f.y, s.held.has(c.id) || s.taken.has(c.id), s.lifted.has(c.id) ? 1.05 : 1);
    el.style.width = `${r.w}px`;
    el.style.height = `${r.h}px`;
    el.style.zIndex = String(turned || t || s.lifted.has(c.id) ? 1000000 : i);
    const sheet = el.firstChild as Element;
    sheet.className = `sheet c${c.color}`;
    const [front, back, ear] = sheet.children as HTMLCollectionOf<HTMLElement>;
    // each face at its own size while the sheet grows or shrinks between them, cross-fading
    if (t) {
      const w = this.backWidth();
      el.style.setProperty("--front-w", `${c.w}px`);
      el.style.setProperty("--back-w", `${w}px`);
      el.style.setProperty("--back-h", `${this.backHeight(c, w)}px`);
      el.style.setProperty("--ear", `${c.notes ? FOLD * (1 - p) : 0}px`);
    }
    // the fold flattens and the crease fades as the front turns away
    ear.style.opacity = t && !c.notes ? String(1 - p) : "";
    front.style.opacity = t ? String(1 - p) : "";
    back.style.opacity = t ? String(p) : "";
    // the front's title and the back's heading as one, moving from the front's padding to the back's
    front.style.transform = t ? `translate(${8 * p}px, ${12 * p}px)` : "";
    back.style.transform = t ? `translate(${-8 * (1 - p)}px, ${-12 * (1 - p)}px)` : "";
    const [heading, notes] = back.children;
    if (!editing || editing.back) fillFront(front as HTMLElement, c.text);
    heading.textContent = c.text.split("\n")[0];
    if (!editing || !editing.back) {
      notes.textContent = c.notes || PLACEHOLDER;
      notes.classList.toggle("placeholder", !c.notes);
    }
  }

  renderLane(l: Lane) {
    const s = this.state;
    const renaming = s.renaming === l.id;
    const who = s.taken.get(l.id);
    const mark = who?.colour ?? s.seen.get(l.id) ?? "";
    const flags = ["lane", s.selection.has(l.id) && "selected", s.held.has(l.id) && "held", s.found === l.id && "found",
      renaming && "renaming", who && "taken", !who && mark && "seen"].filter(Boolean).join(" ");
    const f = { x: 0, y: 0, w: 0, h: 0, ...(s.held.has(l.id) && s.float) };
    const e = this.element(l.id, this.lanesEl, '<div class="header"><div class="title"></div></div><div class="grip"></div>');
    const key = JSON.stringify([flags, l.x + f.x, l.y + f.y, l.w + f.w, l.h + f.h, l.title, mark, who?.name]);
    if (e.key === key) return;
    e.key = key;
    const el = e.el;
    el.className = flags;
    el.style.setProperty("--who", mark);
    el.dataset.who = who?.name ?? "";
    this.place(e, l.x + f.x, l.y + f.y, s.held.has(l.id) || s.taken.has(l.id));
    el.style.width = `${l.w + f.w}px`;
    el.style.height = `${l.h + f.h}px`;
    if (!renaming) el.querySelector(".title")!.textContent = l.title;
  }

  editorOf(id: string, back: boolean): Field | null {
    const el = this.els.get(id)?.el.querySelector<HTMLElement>(back ? ".notes" : ".front");
    return el ? new DomField(el, back ? "notes" : "front") : null;
  }

  titleOf(id: string): Field | null {
    const el = this.els.get(id)?.el.querySelector<HTMLElement>(".title");
    return el ? new DomField(el, "title") : null;
  }

  /**
   * Runs `change` at once and renders; each card of `ids` then grows out of its front into its back, or back into its
   * front, on the camera's spring, so that it moves as one with a pan to show it, as iOS's zoom transitions grow out of
   * where they start. Turned again on the way, it goes back from where it is, as fast as it was going. With reduced
   * motion, its faces cross-fade at its new size.
   */
  animateTurn(ids: string[], change: () => void) {
    change();
    const fade = reduced();
    for (const id of ids) {
      const to = this.state.turned === id ? 1 : 0;
      let t = this.turns.get(id);
      if (!t) {
        const p = motionValue(1 - to);
        // drawn as it changes, not a frame later, to move with the camera
        p.on("change", () => {
          const c = R.card(this.shown(), id);
          if (c) this.renderCard(c, 0);
        });
        t = { p, fade };
        this.turns.set(id, t);
      }
      t.fade = fade;
      const turn = t;
      animate(turn.p, to, fade ? { duration: 0.2, ease: "linear" } : CAMERA_SPRING).then(() => {
        if (turn.p.isAnimating() || this.turns.get(id) !== turn) return;
        this.turns.delete(id);
        turn.p.destroy();
        this.invalidate();
      });
    }
    this.render();
  }
}
