/** The buttons that send away what a browser on the emulator shows over the page unasked: Firefox's survey. */
const AWAY = ["No Thanks", "No thanks", "Not now"];
/** The buttons that let a page read the clipboard: Chrome's permission prompt, and Firefox's Paste over the page. */
const ALLOW = ["Allow", "Allow while visiting the site", "Allow this time", "Paste"];

/** The first of the buttons reading `texts` a `uiautomator dump` shows, and its middle in screen pixels; null when none shows. */
function button(ui: string, texts: string[]): { text: string; x: number; y: number } | null {
  const m = new RegExp(`text="(${texts.join("|")})"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`).exec(ui);
  if (!m) return null;
  const [x0, y0, x1, y1] = m.slice(2).map(Number) as [number, number, number, number];
  return { text: m[1]!, x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2) };
}

/** The button that sends away what shows over the page unasked. */
export const dismissal = (ui: string) => button(ui, AWAY);

/** The button that lets the page read the clipboard, as the browser asks. */
export const allowance = (ui: string) => button(ui, ALLOW);
