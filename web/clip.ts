import { CARD_W } from "./rules.ts";
import type { Clip, ClipCard } from "./types.ts";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ESCAPES[c]);

/** The fronts in the clip's order, a blank line between. */
export const clipText = (c: Clip) => c.cards.map((k) => k.text).join("\n\n");

/** The text as HTML with the clip as JSON in a `data-breezy` attribute, which Safari keeps where it drops comments and metas. */
export function clipHTML(c: Clip) {
  const json = JSON.stringify(c).replace(/[<>&\u00a0]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
  return `<div data-breezy="${escape(json)}">${escape(clipText(c)).replaceAll("\n", "<br>")}</div>`;
}

function decodeEntities(s: string) {
  return s.replace(/&(quot|amp|lt|gt|apos|nbsp|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => {
    const named: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", nbsp: "\u00a0" };
    if (e.toLowerCase() in named) return named[e.toLowerCase()];
    const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function readCard(v: unknown): ClipCard | null {
  if (typeof v !== "object" || v === null) return null;
  const k = v as Record<string, unknown>;
  if (typeof k.id !== "string" || typeof k.text !== "string" || !isNum(k.x) || !isNum(k.y)) return null;
  return {
    id: k.id,
    x: k.x,
    y: k.y,
    w: CARD_W,
    h: isNum(k.h) && k.h > 0 ? k.h : 48,
    text: k.text,
    color: isNum(k.color) ? Math.min(5, Math.max(1, Math.round(k.color))) : 1,
    ...(typeof k.notes === "string" && k.notes ? { notes: k.notes } : {}),
  };
}

/**
 * The clip in the first `data-breezy` attribute of `html`, wherever the browser put it. Scanned
 * rather than parsed, as the Mac does and as Node, which tests this, has no DOMParser.
 */
export function readClip(html: string): Clip | null {
  const m = /<[^>]*?\sdata-breezy="([^"]*)"/.exec(html);
  if (!m) return null;
  let j: any;
  try {
    j = JSON.parse(decodeEntities(m[1]));
  } catch {
    return null;
  }
  if (!j || j.v !== 1 || typeof j.board !== "string" || !Array.isArray(j.cards)) return null;
  const cards = j.cards.map(readCard);
  return cards.includes(null) ? null : { v: 1, board: j.board, cards };
}
