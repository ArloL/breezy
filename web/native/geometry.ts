import type { Cam, Point, Rect } from "../types.ts";

export interface Layout {
  width: number;
  height: number;
  world: string;
  gridSize: number;
  gridOffset: [number, number];
}

const mod = (a: number, n: number) => ((a % n) + n) % n;
/** To a thousandth of a point: a tiny offset printed raw, as 1e-9, is not a length CSS reads. */
export const px = (n: number) => `${+n.toFixed(3)}px`;

export function layoutOf(board: Rect, zoom: number, client: { w: number; h: number }): Layout {
  const gridSize = 25 * zoom, ox = -board.x * zoom, oy = -board.y * zoom;
  return {
    width: Math.max(board.w * zoom, client.w + 1),
    height: Math.max(board.h * zoom, client.h + 1),
    world: `translate(${px(ox)}, ${px(oy)}) scale(${zoom})`,
    gridSize,
    gridOffset: [mod(ox, gridSize) - gridSize / 2, mod(oy, gridSize) - gridSize / 2],
  };
}

export const scrollOf = (cam: Cam, board: Rect): Point => ({ x: -cam.x - board.x * cam.zoom, y: -cam.y - board.y * cam.zoom });

export const camOf = (scroll: Point, board: Rect, zoom: number): Cam => ({ x: -scroll.x - board.x * zoom, y: -scroll.y - board.y * zoom, zoom });

export const isEcho = (at: Point, written: Point) => Math.abs(at.x - written.x) < 1 && Math.abs(at.y - written.y) < 1;

export function pinchTransform(anchor: Point, board: Rect, z0: number, z: number, mid: Point, scroll: Point): string {
  const s = z / z0, qx = (anchor.x - board.x) * z0, qy = (anchor.y - board.y) * z0;
  return `translate(${px(mid.x - qx * s + scroll.x)}, ${px(mid.y - qy * s + scroll.y)}) scale(${s})`;
}

export const pinchCamera = (anchor: Point, z: number, mid: Point): Cam => ({ x: mid.x - anchor.x * z, y: mid.y - anchor.y * z, zoom: z });
