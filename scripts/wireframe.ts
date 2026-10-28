#!/usr/bin/env node
// A device's recording drawn as what its screen showed, a frame for each entry that says where things were: the bar
// above the board, the board, the keyboard, the edited card and its caret. No words, as the recording has none:
// node scripts/wireframe.ts "build/scenarios/<run>/d0 chromium flight.json" [out.html]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Recording, Value } from "../web/flight.ts";

type Box = [x: number, y: number, w: number, h: number];

export interface Frame {
  t: number;
  label: string;
  /** The layout viewport's size. */
  inner: [w: number, h: number];
  /** The visual viewport's top, height and width, which a keyboard shortens. */
  visual: [top: number, h: number, w: number] | null;
  /** What of the screen shows the board, from its top to its bottom. */
  area: [top: number, bottom: number] | null;
  card: Box | null;
  caret: Box | null;
  back: boolean;
}

const isBox = (v: Value | undefined): v is Box => Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === "number");

/** A frame for each geometry entry and reveal, what an entry does not say carried from the one before. */
export function frames(r: Recording): Frame[] {
  const screen = r.context?.screen;
  let last: Frame = {
    t: 0, label: "", inner: Array.isArray(screen) ? [Number(screen[0]), Number(screen[1])] : [400, 800],
    visual: null, area: null, card: null, caret: null, back: false,
  };
  const out: Frame[] = [];
  for (const [t, kind, what, data] of r.entries) {
    if (!data || !("area" in data || "editing" in data || "inner" in data)) continue;
    const e = data.editing as { [k: string]: Value } | null | undefined;
    last = {
      t,
      label: `${kind} ${what}${data.path ? `: ${data.path}, ${data.why}` : ""}`,
      inner: Array.isArray(data.inner) ? [Number(data.inner[0]), Number(data.inner[1])] : last.inner,
      visual: Array.isArray(data.visual) ? data.visual as Frame["visual"] : last.visual,
      area: Array.isArray(data.area) ? data.area as Frame["area"] : last.area,
      card: e === undefined ? last.card : isBox(e?.card) ? e.card : null,
      caret: e === undefined ? last.caret : isBox(e?.caret) ? e.caret : null,
      back: e === undefined ? last.back : e?.back === true,
    };
    out.push(last);
  }
  return out;
}

const rect = (part: string, [x, y, w, h]: Box, style: string) =>
  `<rect data-part="${part}" x="${x}" y="${y}" width="${w}" height="${h}" ${style}/>`;

/** One frame as SVG in the page's own points. */
export function svg(f: Frame): string {
  const [w, h] = f.inner;
  const parts = [rect("screen", [0, 0, w, h], `fill="#f4f4f2" stroke="#999"`)];
  if (f.area) {
    parts.push(rect("bar", [0, 0, w, f.area[0]], `fill="#c9c9c4"`));
    parts.push(rect("board", [0, f.area[0], w, f.area[1] - f.area[0]], `fill="none" stroke="#3a7" stroke-dasharray="6 4"`));
  }
  if (f.visual && f.visual[0] + f.visual[1] < h - 1) {
    const top = f.visual[0] + f.visual[1];
    parts.push(rect("keyboard", [0, top, w, h - top], `fill="#555" fill-opacity="0.6"`));
  } else if (!f.visual && f.area && f.area[1] < h - 1) {
    // a fake records no viewport: what is below the board, its keyboard or its bar, covers it all the same
    parts.push(rect("below", [0, f.area[1], w, h - f.area[1]], `fill="#555" fill-opacity="0.35"`));
  }
  if (f.card) parts.push(rect("card", f.card, `fill="${f.back ? "#fde9b8" : "#fff"}" stroke="#333"`));
  if (f.caret) parts.push(rect("caret", [f.caret[0] - 1, f.caret[1], 2, f.caret[3]], `fill="#e60"`));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${parts.join("")}</svg>`;
}

/** Every frame on one page, stepped through with a slider or the arrow keys. */
export function page(name: string, r: Recording): string {
  const fs = frames(r);
  const shown = fs.map((f, i) => `<figure ${i ? "hidden" : ""}><figcaption>+${Math.round(f.t)} ms, ${f.label}</figcaption>${svg(f)}</figure>`).join("\n");
  return `<!doctype html><meta charset="utf-8"><title>${name.replace(/[<&]/g, "")}</title>
<style>body{font:14px system-ui;margin:16px}svg{max-height:85vh;width:auto;height:auto}input{width:100%}</style>
<p>${fs.length} frames; ← → to step</p><input type="range" min="0" max="${Math.max(0, fs.length - 1)}" value="0">
${shown}
<script>
const figs = [...document.querySelectorAll("figure")], range = document.querySelector("input");
const show = (i) => { figs.forEach((f, j) => f.hidden = j !== i); range.value = i; };
range.oninput = () => show(Number(range.value));
addEventListener("keydown", (e) => { const i = Number(range.value) + (e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0); if (figs[i]) show(i); });
</script>`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input) {
    console.error("usage: node scripts/wireframe.ts FLIGHT_JSON [OUT_HTML]");
    process.exit(2);
  }
  const out = output ?? input.replace(/\.json$/, "") + ".html";
  writeFileSync(out, page(input, JSON.parse(readFileSync(input, "utf8")) as Recording));
  console.log(out);
}
