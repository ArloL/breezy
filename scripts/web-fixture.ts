// Replays the owner's reference strokes into Firefox on the dev server, native panning on, and keeps each page's frames
// as the fixture the rules over frames judge the web app by (docs/superpowers/plans/2026-11-26-breezy-native-reference-2-web.md,
// Task 7), as scripts/frames-fixture.ts does for the Mac app:
//
//   node scripts/web-fixture.ts --build <name> [--strokes <dir>] [--only <prefix>] [--repeats 3]
//
// The dev server must be up (npm run dev) with one Firefox page on it, never breezy.k5d.de. Each stroke opens the
// reference's empty board where the stroke began, as Breezy/Support/Replay.swift places it, and is posted as fresh
// events by scripts/post-stroke.swift, moved from the reference's window onto Firefox's. The first replay goes to
// scripts/test/fixtures/web-pinch/<build>/<stroke>.json, the others to build/web-pinch/<build>-<n>/, for the spread of
// Firefox's own repeats. Replays move the cursor and take the front window: leave the Mac alone while they run.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FrameTrack, Recording } from "../web/flight.ts";

const repo = new URL("..", import.meta.url).pathname;
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const build = arg("--build");
if (!build) throw new Error("usage: web-fixture.ts --build <name> [--strokes <dir>] [--only <prefix>] [--repeats 3]");
const strokes = arg("--strokes") ?? join(repo, "build/reference-strokes/take-5"), only = arg("--only") ?? "", repeats = Number(arg("--repeats") ?? 3);
const DEV = "http://127.0.0.1:58565", WHO = "fixture", flight = join(repo, `build/flight/firefox ${WHO}.json`);
setTimeout(() => { console.error("the replays ran past 60 minutes"); process.exit(1); }, 60 * 60_000).unref();

/** The reference app's board and view, and where Breezy's reference page puts its empty board: Replay.swift's. */
const REFERENCE_BOARD = 40032, REFERENCE_VIEW = { w: 1495, h: 932 }, REFERENCE_STAGE_H = 949, MARGIN = 1194;
interface Stroke { start: [number, number, number]; window: [number, number, number, number]; context?: { name?: string }; raw: [string, string][] }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const read = (): Recording | null => { try { return JSON.parse(readFileSync(flight, "utf8")); } catch { return null; } };
const osa = (...lines: string[]) => execFileSync("osascript", lines.flatMap((l) => ["-e", l]), { encoding: "utf8", timeout: 10_000 }).trim();

/** The page's camera for `s`'s start, a stage `w` × `h` pt: as far from the board's centre as the reference's was from
 * its board's, or from the top left for a pinch at the corner, at its zoom. */
export function startCam(s: Pick<Stroke, "start" | "context">, w: number, h: number) {
  const [z, x, y] = s.start, corner = s.context?.name === "pinch-corner";
  const refAt = (view: number) => (corner ? 0 : REFERENCE_BOARD / 2 - view / z / 2);
  const dx = x - refAt(REFERENCE_VIEW.w), dy = y - refAt(REFERENCE_VIEW.h);
  const wx = corner ? -MARGIN + dx : -w / z / 2 + dx, wy = corner ? -MARGIN + dy : -h / z / 2 + dy;
  return { x: -wx * z, y: -wy * z, zoom: z };
}

/** Opens `url` in the dev server's one page and waits for that page's first recording. */
async function open(url: string): Promise<Recording> {
  const was = read()?.origin;
  const r = await fetch(`${DEV}/goto?url=${encodeURIComponent(url)}`, { method: "POST", headers: { "X-Breezy-Replay": "1" }, signal: AbortSignal.timeout(3000) })
    .then((r) => r.json() as Promise<{ pages: number }>).catch(() => { throw new Error("start the dev server: npm run dev"); });
  if (r.pages !== 1) throw new Error(`${r.pages} pages on the dev server: open one Firefox tab on it`);
  for (const until = Date.now() + 15_000; Date.now() < until; await sleep(300)) {
    const now = read();
    if (now && now.origin !== was && now.frames?.rows.length) return now;
  }
  throw new Error("the page posted no recording of its own in 15 s");
}

/** Firefox's front window, in screen points from the top left. */
function firefoxWindow() {
  osa('tell application "Firefox" to activate');
  const [x, y, w, h] = osa('tell application "System Events" to tell process "Firefox" to get {position, size} of front window').split(/,\s*/).map(Number);
  return { x, y, w, h };
}

const poster = join(repo, "build/post-stroke");
if (!existsSync(poster)) execFileSync("swiftc", ["-O", join(repo, "scripts/post-stroke.swift"), "-o", poster], { stdio: "inherit", timeout: 300_000 });
const small = (t: FrameTrack): FrameTrack => ({ fields: t.fields, rows: t.rows.map((r) => r.map((v) => (v == null ? v : Math.round(v * 1e4) / 1e4))) });

const first = await open(`/?reference=0,0&pan=native&who=${WHO}`);
const f0 = first.frames!, row = f0.rows.at(-1)!, stage = { w: row[f0.fields.indexOf("viewW")]!, h: row[f0.fields.indexOf("viewH")]! };
console.log(`Firefox's view ${stage.w} × ${stage.h} pt`);
for (const name of readdirSync(strokes).filter((f) => f.endsWith(".json") && f.startsWith(only)).sort()) {
  const s: Stroke = JSON.parse(readFileSync(join(strokes, name), "utf8"));
  for (let n = 1; n <= repeats; n++) {
    const c = startCam(s, stage.w, stage.h);
    await open(`/?reference=${c.x},${c.y},${c.zoom}&pan=native&who=${WHO}`);
    const ff = firefoxWindow(), [rx, ry, , rh] = s.window;
    // from the reference's view onto Firefox's: their windows' content areas, top left to top left
    const dx = ff.x - rx, dy = ff.y + ff.h - stage.h - (ry + rh - REFERENCE_STAGE_H);
    await sleep(500);
    const said = execFileSync(poster, [join(strokes, name), String(dx), String(dy)], { encoding: "utf8", timeout: 60_000 }).trim();
    const posted = Date.now();
    // a stroke rests a second after its last event, and the page posts every few seconds
    let r: Recording | null = null;
    for (const until = posted + 15_000; Date.now() < until; await sleep(300)) {
      if (statSync(flight).mtimeMs > posted + 1500 && (r = read())?.frames) break;
    }
    if (!r?.frames) throw new Error(`${name}: no frames posted after the stroke`);
    const dir = n === 1 ? join(repo, "scripts/test/fixtures/web-pinch", build) : join(repo, "build/web-pinch", `${build}-${n}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), JSON.stringify(small(r.frames)) + "\n");
    console.log(`${name} ${n}/${repeats}: ${said}, ${r.frames.rows.length} frames`);
  }
}
process.exit(0);
