/** The buttons that send away what a browser on the emulator shows over the page unasked: Firefox's survey. */
const AWAY = ["No Thanks", "No thanks", "Not now"];

/** The first such button a `uiautomator dump` shows, and its middle in screen pixels; null when none shows. */
export function dismissal(ui: string): { text: string; x: number; y: number } | null {
  const m = new RegExp(`text="(${AWAY.join("|")})"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`).exec(ui);
  if (!m) return null;
  const [x0, y0, x1, y1] = m.slice(2).map(Number) as [number, number, number, number];
  return { text: m[1]!, x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2) };
}
