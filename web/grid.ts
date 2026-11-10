import { GRID } from "./rules.ts";
import type { Cam, Rect } from "./types.ts";

const ALL = { x: -1e9, y: -1e9, w: 2e9, h: 2e9 };

// The CSS dot this replaces: solid to 0.9 pt, gone by 1.1.
const RADIUS = 1;

/**
 * Where the dots' columns and rows fall, in device pixels: one at each cell's centre, rounded to a whole pixel so every
 * dot draws alike, and one past each edge so a dot half on screen shows. Below a zoom of 0.4, as on the Mac, none.
 */
export function dotLines({ x, y, zoom }: Cam, dpr: number, width: number, height: number) {
  if (zoom < 0.4) return { xs: [] as number[], ys: [] as number[] };
  const line = (o: number, size: number) => {
    const out: number[] = [];
    for (let k = Math.floor((-o / zoom - GRID / 2) / GRID); ; k++) {
      const v = Math.round((o + (GRID / 2 + k * GRID) * zoom) * dpr);
      if (v > (size + GRID * zoom) * dpr) return out;
      out.push(v);
    }
  };
  return { xs: line(x, width), ys: line(y, height) };
}

/** What of a `width` × `height` screen lies past `board`, on screen: strips above, below, left and right of it. */
export function outside(board: Rect, width: number, height: number): Rect[] {
  const top = Math.min(height, Math.max(0, board.y)), bottom = Math.max(top, Math.min(height, board.y + board.h));
  const left = Math.min(width, Math.max(0, board.x)), right = Math.max(left, Math.min(width, board.x + board.w));
  return [
    { x: 0, y: 0, w: width, h: top },
    { x: 0, y: bottom, w: width, h: height - bottom },
    { x: 0, y: top, w: left, h: bottom - top },
    { x: right, y: top, w: width - right, h: bottom - top },
  ].filter((r) => r.w > 0 && r.h > 0);
}

/**
 * The dot grid in screen space, on a canvas redrawn with the camera: one dot, stamped across a strip that is stamped
 * down the screen, all at whole device pixels. A background sized to the zoom had Safari repaint the whole board on every
 * frame of a pinch, which on iOS flickered.
 */
export class Grid {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  strip: HTMLCanvasElement;
  dot: HTMLCanvasElement | null;
  /** The colour past the board's edge. */
  past: string;
  dpr: number;
  width: number;
  height: number;
  cam: Cam;
  board: Rect;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.strip = document.createElement("canvas");
    this.dot = null;
    this.past = "";
    this.dpr = 0;
    this.width = canvas.clientWidth;
    this.height = canvas.clientHeight;
    this.cam = { x: 0, y: 0, zoom: 1 };
    this.board = ALL;
    new ResizeObserver(([e]) => {
      this.width = e.contentRect.width;
      this.height = e.contentRect.height;
      this.draw(this.cam, this.board);
    }).observe(canvas);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      this.dot = null;
      this.draw(this.cam, this.board);
    });
  }

  /** Dots on `board`, a screen rect; past its edge, only the outside's colour. */
  draw(cam: Cam, board: Rect = ALL) {
    this.cam = cam;
    this.board = board;
    const dpr = devicePixelRatio || 1;
    if (dpr !== this.dpr) this.dot = null;
    this.dpr = dpr;
    const w = Math.round(this.width * dpr);
    const h = Math.round(this.height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    } else this.ctx.clearRect(0, 0, w, h);
    const past = outside(board, this.width, this.height);
    if (past.length) {
      this.dot ??= this.makeDot(dpr);
      this.ctx.fillStyle = this.past;
      for (const r of past) this.ctx.fillRect(r.x * dpr, r.y * dpr, r.w * dpr, r.h * dpr);
    }
    const { xs, ys } = dotLines(cam, dpr, this.width, this.height);
    if (!w || !h || !xs.length || !ys.length) return;
    const dot = this.dot ??= this.makeDot(dpr);
    if (past.length) {
      this.ctx.save();
      this.ctx.beginPath();
      this.ctx.rect(board.x * dpr, board.y * dpr, board.w * dpr, board.h * dpr);
      this.ctx.clip();
    }
    const half = dot.width / 2;
    if (this.strip.width !== w || this.strip.height !== dot.height) {
      this.strip.width = w;
      this.strip.height = dot.height;
    }
    const s = this.strip.getContext("2d")!;
    s.clearRect(0, 0, w, dot.height);
    for (const x of xs) s.drawImage(dot, x - half, 0);
    for (const y of ys) this.ctx.drawImage(this.strip, 0, y - half);
    if (past.length) this.ctx.restore();
  }

  /** One dot in the theme's colour, centred on a pixel corner; and the theme's colour past the board's edge. */
  makeDot(dpr: number) {
    this.past = getComputedStyle(this.canvas).getPropertyValue("--outside");
    const r = RADIUS * dpr;
    const c = document.createElement("canvas");
    c.width = c.height = 2 * Math.ceil(r) + 2;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = getComputedStyle(this.canvas).color;
    ctx.arc(c.width / 2, c.height / 2, r, 0, 2 * Math.PI);
    ctx.fill();
    return c;
  }
}
