// Replays the owner's reference strokes into a Firefox that Playwright launches, never the owner's, native panning on or
// off, and keeps each page's frames for the rules over frames (docs/superpowers/plans/2026-11-26-breezy-feel-levels.md,
// Task 3), as scripts/frames-fixture.ts does for the Mac app:
//
//   node scripts/web-fixture.ts --build <name> [--pan native|camera] [--strokes <dir>] [--only <prefix>] [--list a,b] [--smoke] [--wide] [--repeats 1]
//
// --list captures just those strokes again, as a calibration that failed names them (web/test/feel-levels.test.ts).
//
// The site is built and served here. Each stroke opens the reference's empty board where the stroke began, in a view of
// the reference's size, as Breezy/Support/Replay.swift places it, and is posted as fresh events by
// scripts/post-stroke.swift, moved from the reference's view onto the page's. The first replay goes to
// scripts/test/fixtures/web-pinch/<build>-<pan>/<stroke>.json, the others to build/web-pinch/<build>-<pan>-<n>/; with
// three or more, each stroke's spread, how far its repeats' zoom parted, goes to …/<build>-<pan>-spread.json. Replays
// move the cursor and take the front window: leave the Mac alone while they run.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FrameTrack, Recording } from "../web/flight.ts";

/** The reference app's board and view, and where Breezy's reference page puts its empty board: Replay.swift's. */
const REFERENCE_BOARD = 40032, REFERENCE_VIEW = { w: 1495, h: 932 }, REFERENCE_STAGE_H = 949, MARGIN = 1194;
/** One stroke of each kind, for a quick pass. */
const SMOKE = ["double-tap-7", "lift-mid-band-17", "pinch-corner-1", "pinch-in-past-max-1", "pinch-out-fast-6", "pinch-out-slow-1", "pinch-pan-12"];
interface Stroke { start: number[]; window?: number[]; context?: { name?: string }; raw?: [string, string][] }

/** The page's camera for `s`'s start, in a view the reference's size: as far from the board's centre as the reference's
 * was from its board's, or from the top left for a pinch at the corner, at its zoom. */
export function startCam(s: Pick<Stroke, "start" | "context">) {
  const [z, x, y] = s.start, corner = s.context?.name === "pinch-corner";
  const refAt = (view: number) => (corner ? 0 : REFERENCE_BOARD / 2 - view / z / 2);
  const dx = x - refAt(REFERENCE_VIEW.w), dy = y - refAt(REFERENCE_VIEW.h);
  const wx = (corner ? -MARGIN : -REFERENCE_VIEW.w / z / 2) + dx, wy = (corner ? -MARGIN : -REFERENCE_VIEW.h / z / 2) + dy;
  return { x: -wx * z, y: -wy * z, zoom: z };
}

/** From the reference window's view, the bottom `REFERENCE_STAGE_H` pt of `window` [x, y, w, h], to the page's content,
 * at `inner` on screen: both top left, in screen points from the top left. */
export function offsetOf([x, y, , h]: number[], inner: { x: number; y: number }) {
  return { dx: inner.x - x, dy: inner.y - (y + h - REFERENCE_STAGE_H) };
}

/** `t` from the frame before `from` on, the page's clock: the stroke and the state it began in, not the page's setup,
 * as a stroke begun at 50 % on the empty board opens with the view past it, which camera mode takes in at its first rest
 * and the rules read as grey and a flicker before the gesture. */
export function strokeOf(t: FrameTrack, from: number): FrameTrack {
  const i = t.rows.findIndex((r) => (r[0] ?? 0) >= from);
  return { fields: t.fields, rows: i <= 0 ? t.rows : t.rows.slice(i - 1) };
}

/** Whether a stroke the poster `said` it posted scrolls or pinches of reached no frame of `t` from `from` on: the page
 * never got them, a failed replay. A two-finger double tap, which no page is handed, is not: that it did nothing is
 * what the capture shows. */
export function missed(t: FrameTrack, from: number, said: string): boolean {
  if (!/scroll=|gesture 8=/.test(said)) return false;
  const i = (k: string) => t.fields.indexOf(k);
  return !t.rows.some((r) => (r[0] ?? 0) >= from && ["wheelDX", "wheelDY", "magnify", "gesture"].some((k) => i(k) >= 0 && (r[i(k)] ?? 0) !== 0));
}

/** A run's spreads over the strokes it replayed, with the others' kept: a run of a few left the rest's tolerance at 0.12. */
export function mergeSpread(old: Record<string, number>, now: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries({ ...old, ...now }).sort(([a], [b]) => a.localeCompare(b)));
}

async function main() {
  const repo = new URL("..", import.meta.url).pathname;
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const build = arg("--build"), pan = arg("--pan") ?? "native";
  if (!build || !["native", "camera"].includes(pan)) throw new Error("usage: web-fixture.ts --build <name> [--pan native|camera] [--strokes <dir>] [--only <prefix>] [--smoke] [--repeats 1]");
  const strokes = arg("--strokes") ?? join(repo, "scripts/reference-strokes/pinches"), only = arg("--only") ?? "", repeats = Number(arg("--repeats") ?? 1);
  const smoke = process.argv.includes("--smoke"), list = arg("--list")?.split(",");
  // --wide: a board as wide as the reference app's, for pans that travel past an empty board's edge (web/sample.ts)
  const wide = process.argv.includes("--wide") ? "&wide" : "";
  setTimeout(() => { console.error("the replays ran past 45 minutes"); process.exit(1); }, 45 * 60_000).unref();

  const { firefox } = await import("playwright-core");
  const { buildSite, serveStatic } = await import("../scenarios/browser.ts");
  const { curve } = await import("./frames/rules.ts");
  const site = mkdtempSync(join(tmpdir(), "web-fixture-"));
  buildSite(site);
  const server = serveStatic(site, 58571);
  const poster = join(repo, "build/post-stroke");
  if (!existsSync(poster)) execFileSync("swiftc", ["-O", join(repo, "scripts/post-stroke.swift"), "-o", poster], { stdio: "inherit", timeout: 300_000 });
  const browser = await firefox.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: REFERENCE_VIEW.w, height: REFERENCE_VIEW.h } });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const frames = () => page.evaluate(() => (globalThis as { breezyFlight?: { recording(): Recording } }).breezyFlight?.recording().frames ?? null);
  // Playwright's Firefox to the front, as the poster posts into whatever is in front: by its process, run from
  // Playwright's own folder, as the owner's Firefox has the same name
  // Playwright's own folder, as the owner's Firefox has the same name; of its processes, the one with a window
  let pid = "";
  // and only once its page has the focus: another Playwright Firefox, a run's leftover, takes being fronted without
  // complaint, and the strokes would go to whatever window is under them
  const front = async () => {
    const pids = pid ? [pid] : execFileSync("pgrep", ["-f", "ms-playwright/firefox"], { encoding: "utf8" }).trim().split("\n");
    for (const p of pids) {
      try {
        execFileSync("osascript", ["-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${p}) to true`], { timeout: 10_000, stdio: "ignore" });
      } catch {
        continue;
      }
      await sleep(300);
      if (await page.evaluate(() => document.hasFocus())) return void (pid = p);
    }
    pid = "";
    throw new Error("could not bring Playwright's Firefox to the front with its page focused: close any other Playwright Firefox");
  };
  const small = (t: FrameTrack): FrameTrack => ({ fields: t.fields, rows: t.rows.map((r) => r.map((v) => (v == null ? v : Math.round(v * 1e4) / 1e4))) });

  const names = readdirSync(strokes).filter((f) => f.endsWith(".json") && f.startsWith(only) && (!smoke || SMOKE.includes(f.replace(".json", ""))) && (!list || list.includes(f.replace(".json", "")))).sort();
  const spread: Record<string, number> = {};
  try {
    for (const name of names) {
      const s: Stroke = JSON.parse(readFileSync(join(strokes, name), "utf8")), kept: FrameTrack[] = [];
      for (let n = 1; n <= repeats; n++) {
        const c = startCam(s);
        await page.goto(`http://localhost:58571/?reference=${c.x},${c.y},${c.zoom}&pan=${pan}${wide}`);
        await page.waitForFunction(() => (globalThis as { breezyFlight?: unknown }).breezyFlight, null, { timeout: 15_000 });
        await front();
        const inner = await page.evaluate(() => ({ x: (window as unknown as { mozInnerScreenX: number }).mozInnerScreenX, y: (window as unknown as { mozInnerScreenY: number }).mozInnerScreenY }));
        const { dx, dy } = offsetOf(s.window ?? [0, 0, 0, REFERENCE_STAGE_H], inner);
        const began = await page.evaluate(() => performance.now());
        const said = execFileSync(poster, [join(strokes, name), String(dx), String(dy)], { encoding: "utf8", timeout: 60_000 }).trim();
        // done once its last frame has stood 1.5 s: the recorder writes none while the view is still
        let t: FrameTrack | null = null, last = NaN, since = Date.now();
        for (const until = Date.now() + 20_000; Date.now() < until; await sleep(250)) {
          t = await frames();
          const at = t?.rows.at(-1)?.[0] ?? NaN;
          if (at !== last) (last = at), (since = Date.now());
          else if (Date.now() - since > 1500) break;
        }
        if (!t) throw new Error(`${name}: the page kept no frames`);
        if (Date.now() - since <= 1500) throw new Error(`${name}: the view never stood still in 20 s`);
        if (missed(t, began, said)) throw new Error(`${name}: ${said}, and no frame after it took any: the page never got the stroke`);
        const dir = n === 1 ? join(repo, "scripts/test/fixtures/web-pinch", `${build}-${pan}`) : join(repo, "build/web-pinch", `${build}-${pan}-${n}`);
        mkdirSync(dir, { recursive: true });
        t = strokeOf(t, began);
        writeFileSync(join(dir, name), JSON.stringify(small(t)) + "\n");
        kept.push(t);
        console.log(`${name} ${n}/${repeats}: ${said}, ${t.rows.length} frames`);
      }
      const up = (say: string) => Number(/up to ([0-9.]+)/.exec(say)?.[1] ?? 0);
      if (kept.length >= 3) spread[name.replace(".json", "")] = Math.round(Math.max(0, ...kept.slice(1).flatMap((k) => curve(k, kept[0], "zoom", 0).map((f) => up(f.say)))) * 1000) / 1000;
    }
    const sp = join(repo, "scripts/test/fixtures/web-pinch", `${build}-${pan}-spread.json`);
    if (Object.keys(spread).length) writeFileSync(sp, JSON.stringify(mergeSpread(existsSync(sp) ? JSON.parse(readFileSync(sp, "utf8")) : {}, spread), null, 1) + "\n");
  } finally {
    await browser.close();
    server.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
