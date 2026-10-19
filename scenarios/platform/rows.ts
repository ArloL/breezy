// What people assume each platform's input does, one row of docs/platform-expectations.md each: how a target's own
// input does it (layer 1), and what must come of it, which replays of its traces check too (layer 2).
import type { EditorState } from "../../web/record.ts";

export type Target = "mac" | "firefox-mac" | "android";

/** A target's own input, for a row's native steps. */
export interface Native {
  /** The process under test, frontmost. */
  pid: number;
  /** tools/oskeys, refusing unless `pid` is frontmost. */
  oskeys(args: string[]): string;
  wait(ms: number): Promise<void>;
}

export interface Row {
  id: string;
  variant: string;
  title: string;
  /** The input source the row types with. The harness selects it before the edit opens: an app that is frontmost as
   * the source changes takes it only once it comes to the front again, and that would be a focus change in the row. */
  source?: string;
  native: Partial<Record<Target, (n: Native) => Promise<void>>>;
  /** Targets where the row fails until its fix lands: their tests are todo. */
  open: Target[];
  /** Why `after` breaks the row, or null. */
  expect(before: EditorState, after: EditorState): string | null;
}

const show = (s: EditorState) => `${JSON.stringify(s.text)} with the caret at ${s.at}${s.editing ? "" : ", no longer edited"}`;

/** Why `after` is not `before` with text matching `s` typed at its caret, the caret after it, still editing; or null. */
export function inserted(before: EditorState, after: EditorState, s: string | RegExp): string | null {
  const head = before.text.slice(0, before.at), tail = before.text.slice(before.at);
  const added = after.text.startsWith(head) && after.text.endsWith(tail) ? after.text.slice(head.length, after.text.length - tail.length) : null;
  const ok = added !== null && (typeof s === "string" ? added === s : s.test(added)) && after.at === before.at + added.length;
  if (after.editing && ok) return null;
  const want = typeof s === "string" ? JSON.stringify(head + s + tail) : `${s} inserted into ${JSON.stringify(before.text)} at ${before.at}`;
  return `wanted ${want} with the caret after it, still edited; got ${show(after)}`;
}

const KOTOERI = "com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese";

/** Types romaji `keys` with Japanese input, then presses `end`. */
const japanese = (keys: string, end: string) => async (n: Native) => {
  n.oskeys(["type", keys]);
  await n.wait(300);
  n.oskeys(["key", end]);
  await n.wait(300);
};

export const rows: Row[] = [
  {
    id: "A1", variant: "picker", title: "The emoji picker inserts at the caret",
    native: {
      "firefox-mac": async (n) => {
        n.oskeys(["emoji", "grinning"]);
        await n.wait(800);
      },
    },
    open: ["firefox-mac"],
    expect: (b, a) => inserted(b, a, /^\p{Extended_Pictographic}$/u),
  },
  {
    // live conversion may give 日本 as well as にほん
    id: "A2", variant: "enter", title: "Enter confirms an input method's text and the edit goes on",
    source: KOTOERI,
    native: { "firefox-mac": japanese("nihonn", "return") },
    open: ["firefox-mac"],
    expect: (b, a) => inserted(b, a, /^[\p{Script=Hiragana}\p{Script=Han}]+$/u),
  },
  {
    id: "A2", variant: "escape", title: "Esc cancels an input method's text and the edit goes on",
    source: KOTOERI,
    native: { "firefox-mac": japanese("nihonn", "escape") },
    open: ["firefox-mac"],
    expect: (b, a) => inserted(b, a, ""),
  },
  {
    id: "F1", variant: "away", title: "The edit survives another app taking focus for a moment",
    native: {
      "firefox-mac": async (n) => {
        n.oskeys(["away", String(n.pid)]);
        await n.wait(300);
        n.oskeys(["type", "x"]);
        await n.wait(300);
      },
    },
    open: ["firefox-mac"],
    expect: (b, a) => inserted(b, a, "x"),
  },
];

export function rowOf(id: string, variant: string): Row {
  const r = rows.find((r) => r.id === id && r.variant === variant);
  if (!r) throw new Error(`no row ${id}-${variant}`);
  return r;
}
