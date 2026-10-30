import { CARD_W } from "./rules.ts";
import type { Flight } from "./flight.ts";
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

/** What `Taps` needs of the app. */
export interface Copier {
  copied: Clip | null;
  copySelection(): Clip | null;
  paste(c: Clip): void;
  flight: Pick<Flight, "note">;
}

/** A phone's Copy and Paste by buttons, through the system's clipboard; what this page last copied when that fails. */
export class Taps {
  private readonly app: Copier;
  private readonly clipboard: () => Pick<Clipboard, "read" | "write">;
  /** Whether the last Copy's write was refused: the clipboard then holds older cards than this page copied, if any. */
  private refused = false;

  constructor(app: Copier, clipboard: () => Pick<Clipboard, "read" | "write">) {
    this.app = app;
    this.clipboard = clipboard;
  }

  /** The selected cards to the clipboard, written within the tap, as Safari and Chrome on a phone want; the clip, if any. */
  copy(): Clip | null {
    const clip = this.app.copySelection();
    if (!clip) return null;
    const blob = (type: string, text: string) => new Blob([text], { type });
    const refused = (e: Error) => {
      this.refused = true;
      this.app.flight.note("decision", "copy refused", { why: e.name });
    };
    try {
      this.clipboard().write([new ClipboardItem({ "text/html": blob("text/html", clipHTML(clip)), "text/plain": blob("text/plain", clipText(clip)) })])
        .then(() => (this.refused = false), refused);
    } catch (e) {
      refused(e as Error);
    }
    return clip;
  }

  /** The clipboard's cards, read from the tap, which iOS asks to Paste; else what this page last copied, if anything. */
  async paste() {
    const app = this.app;
    let clip: Clip | null = null, why = "no cards";
    if (this.refused && app.copied) {
      app.flight.note("decision", "paste source", { from: "page", why: "copy refused", copied: true });
      return app.paste(app.copied);
    }
    try {
      for (const item of await this.clipboard().read()) {
        if (item.types.includes("text/html") && (clip = readClip(await (await item.getType("text/html")).text()))) break;
      }
    } catch (e) {
      why = (e as Error).name;
    }
    app.flight.note("decision", "paste source", clip ? { from: "clipboard" } : { from: "page", why, copied: !!app.copied });
    clip ??= app.copied;
    if (clip) app.paste(clip);
  }
}
