/** What Playwright presses in a desktop browser for `key` with ⌘ (`meta`) or ⇧. On the Mac, ⌘. Off it, the caret's moves,
 * a field's select-all, and copy, cut and paste, as the OS fires no copy event for Meta+C, go as the OS edits, whatever
 * the page says: Ctrl, with Ctrl+Home and Ctrl+End for ⌘↑ and ⌘↓, and Home and End for ⌘← and ⌘→; and the board's
 * commands as the page takes them, by whether it says it is on a Mac (`pageMac`), as Playwright's WebKit does on every OS. */
export function chord(key: string, mods: { meta?: boolean; shift?: boolean }, { macOS, pageMac }: { macOS: boolean; pageMac: boolean }) {
  const shift = mods.shift ? "Shift+" : "";
  if (!mods.meta) return `${shift}${key}`;
  const ends: Record<string, string> = { ArrowUp: "Control+Home", ArrowDown: "Control+End", ArrowLeft: "Home", ArrowRight: "End" };
  if (!macOS && (key in ends || ["a", "c", "x", "v"].includes(key))) return `${shift}${ends[key] ?? `Control+${key}`}`;
  return `${macOS || pageMac ? "Meta" : "Control"}+${shift}${key}`;
}
