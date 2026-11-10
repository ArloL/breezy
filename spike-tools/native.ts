// Replays each fixture case's stroke into Firefox's own scrolling (web/spike/native-scroll.html) while recording the
// screen: build/reference/native/<case>.json holds the page's scroll position each frame and the edge bar on screen.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { post } from "/Users/arlookeeffe/Developer/breezy/scripts/replay.ts";
const SP = "/private/tmp/claude-502/-Users-arlookeeffe-Developer-breezy/ba739fbe-bb88-4851-b94a-070dc4a9607e/scratchpad";
const dead = setTimeout(() => { console.log("deadline"); process.exit(3); }, 30 * 60_000);
const goto = (url: string) => fetch(`http://127.0.0.1:58565/goto?url=${encodeURIComponent(url)}`, { method: "POST", headers: { "X-Breezy-Replay": "1" } }).then((r) => r.json());
mkdirSync("build/reference/native", { recursive: true });
const names: string[] = JSON.parse(readFileSync("web/test/appkit-edge.json", "utf8")).cases.map((c: any) => c.name);
for (const [i, n] of names.entries()) {
  const out = `build/reference/native/${n}.json`;
  if (existsSync(out)) continue;
  const s = JSON.parse(readFileSync(`build/reference/${n}.json`, "utf8")), who = Math.random().toString(36).slice(2, 7);
  const r = await goto(`/spike/native-scroll.html?x=${s.start[0]}&y=${s.start[1]}&who=${who}`);
  if (r.pages !== 1) throw new Error(`${r.pages} pages`);
  await new Promise((ok) => setTimeout(ok, 1500));
  execFileSync("osascript", ["-e", `tell application id "org.mozilla.firefox" to activate`]);
  await new Promise((ok) => setTimeout(ok, 400));
  const [x, y, w, h] = execFileSync(`${SP}/bounds`, ["org.mozilla.firefox"], { encoding: "utf8" }).trim().split(" ").map(Number);
  const top = y + h - s.stage[1], strip = Math.round(top + s.stage[1] / 2), mov = `${SP}/native.mov`;
  rmSync(mov, { force: true });
  const rec = spawn("screencapture", ["-v", "-V", String(Math.ceil((s.events.at(-1)[0] + 2500) / 1000) + 1), "-x", "-R", `${x},${strip},${w},4`, mov]);
  await new Promise((ok) => setTimeout(ok, 700));
  await post(s, "org.mozilla.firefox");
  const done = Date.now();
  await new Promise((ok) => rec.on("exit", ok));
  const f = `build/flight/spike ${who}.json`;
  while (!(existsSync(f) && statSync(f).mtimeMs > done + 2500)) { if (Date.now() - done > 20_000) throw new Error(`no ${f}`); await new Promise((ok) => setTimeout(ok, 300)); }
  const bar = JSON.parse(execFileSync("python3", ["-I", `${SP}/bar.py`, mov], { encoding: "utf8", maxBuffer: 1 << 26 }));
  writeFileSync(out, JSON.stringify({ page: JSON.parse(readFileSync(f, "utf8")), bar, window: [x, y, w, h] }));
  console.log(`${i + 1}/${names.length} ${n}: ${bar.length} video frames, bar past the edge up to ${Math.max(0, ...bar.filter((b: any) => b[1] !== null).map((b: any) => b[1]))} pt`);
}
await goto("/?reference=1194,432");
clearTimeout(dead);
