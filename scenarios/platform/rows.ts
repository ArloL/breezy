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

/** Types romaji `keys` with Japanese input, then presses each of `ends`. */
const japanese = (keys: string, ...ends: string[]) => async (n: Native) => {
  n.oskeys(["type", keys]);
  await n.wait(300);
  for (const end of ends) {
    n.oskeys(["key", end]);
    await n.wait(300);
  }
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
    open: [],
    expect: (b, a) => inserted(b, a, /^\p{Extended_Pictographic}$/u),
  },
  {
    // live conversion may give 日本 as well as にほん
    id: "A2", variant: "enter", title: "Enter confirms an input method's text and the edit goes on",
    source: KOTOERI,
    native: { "firefox-mac": japanese("nihonn", "return") },
    open: [],
    expect: (b, a) => inserted(b, a, /^[\p{Script=Hiragana}\p{Script=Han}]+$/u),
  },
  {
    // the first Esc takes live conversion's 日本 back to にほん, the second cancels it
    id: "A2", variant: "escape", title: "Esc cancels an input method's text and the edit goes on",
    source: KOTOERI,
    native: { "firefox-mac": japanese("nihonn", "escape", "escape") },
    open: [],
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
    open: [],
    expect: (b, a) => inserted(b, a, "x"),
  },
  {
    // a hidden page may stay hidden for hours, holding the card from other devices and their changes from the board
    id: "F1", variant: "tab", title: "Another tab ends the edit, keeping its text",
    native: {
      "firefox-mac": async (n) => {
        n.oskeys(["key", "t", "cmd"]);
        await n.wait(800);
        n.oskeys(["key", "w", "cmd"]);
        await n.wait(500);
      },
    },
    open: [],
    expect: ended,
  },
];

/** Why `after` is not `before` with its edit ended and its text kept, or null. */
export function ended(before: EditorState, after: EditorState): string | null {
  if (!after.editing && after.text === before.text) return null;
  return `wanted ${JSON.stringify(before.text)}, no longer edited; got ${JSON.stringify(after.text)}${after.editing ? ", still edited" : ""}`;
}

export function rowOf(id: string, variant: string): Row {
  const r = rows.find((r) => r.id === id && r.variant === variant);
  if (!r) throw new Error(`no row ${id}-${variant}`);
  return r;
}
