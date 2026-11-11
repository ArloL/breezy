// What a screen capture shows of a gesture, as a frame track: how far grey past the board's edge reaches into the view,
// the board's brightness, and the card's box, for what only pixels show, drawing that lags its geometry and flicker
// (docs/superpowers/specs/2026-11-11-breezy-native-reference-2-design.md).
//
//   node scripts/frames/pixels.ts <video> --from 11.4 --to 20.6 --view x,y,w,h [--board r,g,b --edge r,g,b] > track.json
// --view is the board's view in the video's pixels; the video is read at its own rate through ffmpeg.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { FrameTrack } from "../../web/flight.ts";

type RGB = [number, number, number];

/** What the capture shows and where: the board's colour, the colour drawn past its edge, how far a pixel may be off
 * either, the view's rect in the frame's pixels, and pixels to a point. */
export interface Look {
  board: RGB;
  edge: RGB;
  tol: number;
  view: { x: number; y: number; w: number; h: number };
  scale: number;
}

export const PIXEL_FIELDS = ["t", "grey", "bg", "cardX", "cardY", "cardW", "cardH"];

const near = (rgb: Uint8Array, i: number, c: RGB, tol: number) =>
  Math.abs(rgb[i] - c[0]) <= tol && Math.abs(rgb[i + 1] - c[1]) <= tol && Math.abs(rgb[i + 2] - c[2]) <= tol;
const yellow = (rgb: Uint8Array, i: number) => rgb[i] > 60 && rgb[i] - rgb[i + 2] > 25 && rgb[i + 1] - rgb[i + 2] > 15;

/** One frame of `width` pixels a row: how deep, in pt, grey reaches in from the view's furthest-in edge (a line counts
 * as grey when nine in ten of its pixels are), the board's median brightness, and the card's box in view pt. */
export function readFrame(rgb: Uint8Array, width: number, look: Look) {
  const { x: vx, y: vy, w, h } = look.view;
  const at = (x: number, y: number) => ((vy + y) * width + vx + x) * 3;
  const greyLine = (n: number, step: (k: number) => number) => {
    let g = 0;
    for (let k = 0; k < n; k++) if (near(rgb, step(k), look.edge, look.tol)) g++;
    return g >= n * 0.9;
  };
  const depth = (lines: number, along: number, idx: (line: number, k: number) => number) => {
    let d = 0;
    while (d < lines && greyLine(along, (k) => idx(d, k))) d++;
    return d;
  };
  const top = depth(h, w, (l, k) => at(k, l)), bottom = depth(h, w, (l, k) => at(k, h - 1 - l));
  const left = depth(w, h, (l, k) => at(l, k)), right = depth(w, h, (l, k) => at(w - 1 - l, k));
  const lum: number[] = [];
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = at(x, y);
    if (yellow(rgb, i)) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    if (x % 8 === 0 && y % 8 === 0) lum.push(rgb[i] + rgb[i + 1] + rgb[i + 2]);
  }
  lum.sort((a, b) => a - b);
  const s = look.scale;
  return {
    grey: Math.max(top, bottom, left, right) / s,
    bg: lum[lum.length >> 1] / 3,
    card: x1 < 0 ? null : ([x0 / s, y0 / s, (x1 - x0 + 1) / s, (y1 - y0 + 1) / s] as [number, number, number, number]),
  };
}

/** `video` from `from` to `to` s, each frame read as `readFrame` reads it, `t` in ms of the video's time. */
export async function pixelTrack(video: string, look: Look, from: number, to: number): Promise<FrameTrack> {
  const size = await new Promise<[number, number, number]>((resolve, reject) => {
    const p = spawn("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height,r_frame_rate", "-of", "csv=p=0", video]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => {
      const [w, h, r] = out.trim().split(",");
      const [n, d] = r.split("/").map(Number);
      return code ? reject(new Error(`ffprobe ${code}`)) : resolve([Number(w), Number(h), n / (d || 1)]);
    });
  });
  const [W, H, fps] = size, bytes = W * H * 3;
  const ff = spawn("ffmpeg", ["-loglevel", "error", "-ss", String(from), "-t", String(to - from), "-i", video, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const rows: (number | null)[][] = [];
  let buf = Buffer.alloc(0), n = 0;
  for await (const chunk of ff.stdout) {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= bytes) {
      const r = readFrame(new Uint8Array(buf.subarray(0, bytes)), W, look);
      rows.push([Math.round((from + n / fps) * 10000) / 10, r.grey, r.bg, ...(r.card ?? [null, null, null, null])]);
      buf = buf.subarray(bytes);
      n++;
    }
  }
  return { fields: PIXEL_FIELDS, rows };
}

/** `pixels` with its times moved onto `frames`' clock: the first frame the card moves in either is taken as the same. */
export function align(pixels: FrameTrack, frames: FrameTrack): FrameTrack {
  const moved = (t: FrameTrack, fields: string[]) => {
    const cols = fields.map((f) => t.rows.map((r) => r[t.fields.indexOf(f)]));
    const i = t.rows.findIndex((_, k) => k > 0 && cols.some((c) => c[k] !== c[k - 1]));
    return t.rows[Math.max(0, i)][0] ?? 0;
  };
  const shift = moved(frames, ["zoom", "camX", "camY"]) - moved(pixels, ["cardX", "cardY", "cardW"]);
  return { fields: pixels.fields, rows: pixels.rows.map((r) => [(r[0] ?? 0) + shift, ...r.slice(1)]) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const nums = (s: string | undefined, d: number[]) => (s ? s.split(",").map(Number) : d);
  const [x, y, w, h] = nums(arg("--view"), []);
  const look: Look = { board: nums(arg("--board"), [25, 26, 24]) as RGB, edge: nums(arg("--edge"), [35, 37, 34]) as RGB, tol: 3, view: { x, y, w, h }, scale: Number(arg("--scale") ?? 1) };
  const t = await pixelTrack(process.argv[2], look, Number(arg("--from") ?? 0), Number(arg("--to") ?? 120));
  process.stdout.write(JSON.stringify(t));
}
