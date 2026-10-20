import { GRID } from "./rules.ts";
import type { Cam } from "./types.ts";

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
  dpr: number;
  width: number;
  height: number;
  cam: Cam;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.strip = document.createElement("canvas");
    this.dot = null;
    this.dpr = 0;
    this.width = canvas.clientWidth;
    this.height = canvas.clientHeight;
    this.cam = { x: 0, y: 0, zoom: 1 };
    new ResizeObserver(([e]) => {
      this.width = e.contentRect.width;
      this.height = e.contentRect.height;
      this.draw(this.cam);
    }).observe(canvas);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      this.dot = null;
      this.draw(this.cam);
    });
  }

  draw(cam: Cam) {
    this.cam = cam;
    const dpr = devicePixelRatio || 1;
    if (dpr !== this.dpr) this.dot = null;
    this.dpr = dpr;
    const w = Math.round(this.width * dpr);
    const h = Math.round(this.height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    } else this.ctx.clearRect(0, 0, w, h);
    const { xs, ys } = dotLines(cam, dpr, this.width, this.height);
    if (!w || !h || !xs.length || !ys.length) return;
    const dot = this.dot ??= this.makeDot(dpr);
    const half = dot.width / 2;
    if (this.strip.width !== w || this.strip.height !== dot.height) {
      this.strip.width = w;
      this.strip.height = dot.height;
    }
    const s = this.strip.getContext("2d")!;
    s.clearRect(0, 0, w, dot.height);
    for (const x of xs) s.drawImage(dot, x - half, 0);
    for (const y of ys) this.ctx.drawImage(this.strip, 0, y - half);
  }

  /** One dot in the theme's colour, centred on a pixel corner. */
  makeDot(dpr: number) {
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
