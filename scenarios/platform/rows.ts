// What people assume each platform's input does, one row of docs/platform-expectations.md each: how a target's own
// input does it (layer 1), and what must come of it, which replays of its traces check too (layer 2).
import type { EditorState } from "../../web/record.ts";

export type Target = "mac" | "firefox-mac" | "android";

/** A Mac target's own input, for a row's native steps. */
export interface MacNative {
  /** The process under test, frontmost. */
  pid: number;
  /** tools/oskeys, refusing unless `pid` is frontmost. */
  oskeys(args: string[]): string;
  wait(ms: number): Promise<void>;
}

/** Android's own input: tools/breezy-ime's calls into the editor that a real touch opened, and adb. */
export interface AndroidNative {
  ime(op: string, extras?: Record<string, string | number>): void;
  adb(...args: string[]): string;
  /** The editor's text as the page has it, for offsets a keyboard counts in it. */
  text(): Promise<string>;
  wait(ms: number): Promise<void>;
}

export interface Natives {
  mac: MacNative;
  "firefox-mac": MacNative;
  android: AndroidNative;
}

export interface Row {
  id: string;
  variant: string;
  title: string;
  /** The input source the row types with. The harness selects it before the edit opens: an app that is frontmost as
   * the source changes takes it only once it comes to the front again, and that would be a focus change in the row. */
  source?: string;
  native: { [T in Target]?: (n: Natives[T]) => Promise<void> };
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
const japanese = (keys: string, ...ends: string[]) => async (n: MacNative) => {
  n.oskeys(["type", keys]);
  await n.wait(300);
  for (const end of ends) {
    n.oskeys(["key", end]);
    await n.wait(300);
  }
};

/** Composes each of `steps` in turn, as a keyboard does key by key. */
const composing = async (n: AndroidNative, ...steps: string[]) => {
  for (const text of steps) {
    n.ime("compose", { text });
    await n.wait(300);
  }
};

const call = async (n: AndroidNative, op: string, extras: Record<string, string | number> = {}) => {
  n.ime(op, extras);
  await n.wait(300);
};

/** Why `after` is not `before` with its last word replaced by `word`, the caret after it, still editing; or null. */
function replacedLastWord(before: EditorState, after: EditorState, word: string): string | null {
  const want = before.text.replace(/\S+$/, word);
  if (after.editing && after.text === want && after.at === want.length) return null;
  return `wanted ${JSON.stringify(want)} with the caret at its end, still edited; got ${show(after)}`;
}

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
  {
    id: "A1", variant: "commit", title: "A keyboard's emoji goes in at the caret",
    native: { android: (n) => call(n, "commit", { text: "😀" }) },
    open: [],
    expect: (b, a) => inserted(b, a, "😀"),
  },
  {
    id: "A2", variant: "compose", title: "Text a keyboard composes goes in once committed, and the edit goes on",
    native: {
      android: async (n) => {
        await composing(n, "に", "にほ", "にほん", "日本");
        await call(n, "commit", { text: "日本" });
      },
    },
    open: [],
    expect: (b, a) => inserted(b, a, "日本"),
  },
  {
    // a Korean keyboard composes each syllable from its letters and finishes it as the next one starts
    id: "A3", variant: "korean", title: "Korean syllables go in as composed",
    native: {
      android: async (n) => {
        await composing(n, "ㅎ", "하", "한");
        await call(n, "finish");
        await composing(n, "ㄱ", "그", "글");
        await call(n, "finish");
      },
    },
    open: [],
    expect: (b, a) => inserted(b, a, "한글"),
  },
  {
    // as Gboard corrects a word: the composed word committed as corrected, then the space
    id: "A7", variant: "autocorrect", title: "An autocorrected word replaces what was typed",
    native: {
      android: async (n) => {
        await call(n, "commit", { text: " " });
        await composing(n, "t", "te", "teh");
        await call(n, "commit", { text: "the" });
        await call(n, "commit", { text: " " });
      },
    },
    open: [],
    expect: (b, a) => inserted(b, a, " the "),
  },
  {
    // a swiped word is composed whole, and the keyboard puts a space before the next
    id: "A10", variant: "swipe", title: "Swiped words go in with the keyboard's spaces",
    native: {
      android: async (n) => {
        await call(n, "commit", { text: " " });
        await composing(n, "hello");
        await call(n, "finish");
        await call(n, "commit", { text: " " });
        await composing(n, "world");
        await call(n, "finish");
      },
    },
    open: [],
    expect: (b, a) => inserted(b, a, " hello world"),
  },
  {
    // the keyboard marks the word it suggests for, then commits the suggestion over it
    id: "A12", variant: "suggestion", title: "A suggestion picked replaces the word",
    native: {
      android: async (n) => {
        const text = await n.text();
        await call(n, "region", { start: text.search(/\S+$/), end: text.length });
        await call(n, "commit", { text: "budgets" });
      },
    },
    open: [],
    expect: (b, a) => replacedLastWord(b, a, "budgets"),
  },
  {
    // a thumbs-up with a skin tone is four UTF-16 units and one character
    id: "C1", variant: "delete", title: "Backspace deletes a whole emoji",
    native: {
      android: async (n) => {
        await call(n, "commit", { text: "👍🏽" });
        await call(n, "key", { code: 67 });
      },
    },
    open: [],
    expect: (b, a) => inserted(b, a, ""),
  },
  {
    // as dragging on Gboard's space bar moves the caret
    id: "D7", variant: "select", title: "The keyboard moves the caret, and typing goes there",
    native: {
      android: async (n) => {
        const at = (await n.text()).length - 3;
        await call(n, "select", { start: at, end: at });
        await call(n, "commit", { text: "X" });
      },
    },
    open: [],
    expect: (b, a) => inserted({ ...b, at: b.at - 3 }, a, "X"),
  },
  {
    id: "F2", variant: "rotate", title: "Turning the phone keeps the edit, and typing goes on",
    native: {
      android: async (n) => {
        n.adb("shell", "settings", "put", "system", "accelerometer_rotation", "0");
        n.adb("shell", "settings", "put", "system", "user_rotation", "1");
        try {
          await n.wait(2000);
          await call(n, "commit", { text: "x" });
        } finally {
          n.adb("shell", "settings", "put", "system", "user_rotation", "0");
          await n.wait(2000);
        }
      },
    },
    open: [],
    expect: (b, a) => inserted(b, a, "x"),
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
