// Replays the owner's reference strokes into a Breezy.app and keeps both frame tracks as the fixture the rules over
// frames are tested on (docs/superpowers/plans/2026-11-11-breezy-native-reference-2.md, Task 9):
//
//   node scripts/frames-fixture.ts --app <Breezy.app> --build <name> [--strokes <dir>] [--out <dir>] [--board <file>] [--only <prefix>] [--load]
//
// Each stroke the reference app kept in --strokes (scripts/reference-strokes/pinches; the pans in …/pans) is replayed with -BreezyReplay into
// the app on scripts/selftest/frames.breezy; its track goes to scripts/test/fixtures/mac-pinch/<build>/<stroke>.json
// and the owner's own, as recorded, to …/reference/<stroke>.json. Given BreezyReference.app, it replays into the
// reference app's --zoom instead, the replay's own error to compare Breezy's with. --load keeps every core busy.
// Replays move the cursor: leave the Mac alone while they run.
import { execFile, spawn } from "node:child_process";
import { cpus, tmpdir } from "node:os";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FrameTrack } from "../web/flight.ts";

const run = promisify(execFile);
const repo = new URL("..", import.meta.url).pathname;
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const app = arg("--app"), build = arg("--build");
if (!app || !build) throw new Error("usage: frames-fixture.ts --app <Breezy.app> --build <name> [--strokes <dir>] [--only <prefix>] [--load]");
const strokes = arg("--strokes") ?? join(repo, "scripts/reference-strokes/pinches"), only = arg("--only") ?? "";
// --out keeps a set of strokes apart from the pinches': the pans, whose builds are not the pinches' (mac-pans); --board
// replays them on another board, as the pans' as wide as the reference app's (mac-pans/board.breezy)
const out = arg("--out") ? join(repo, arg("--out")!) : join(repo, "scripts/test/fixtures/mac-pinch");

/** Four decimals are a ten-thousandth of a point or of a zoom: finer than any rule reads, and a third of the size. */
const small = (t: FrameTrack): FrameTrack => ({ fields: t.fields, rows: t.rows.map((r) => r.map((v) => (v == null ? v : Math.round(v * 1e4) / 1e4))) });
const keep = (dir: string, name: string, t: FrameTrack) => {
  mkdirSync(join(out, dir), { recursive: true });
  writeFileSync(join(out, dir, name), JSON.stringify(small(t)) + "\n");
};

const busy = process.argv.includes("--load") ? cpus().map(() => spawn("sh", ["-c", "while :; do :; done"], { stdio: "ignore" })) : [];
try {
  for (const f of readdirSync(strokes).filter((f) => /^[a-z-]+-\d+\.json$/.test(f) && f.startsWith(only)).sort()) {
    const dir = mkdtempSync(join(tmpdir(), "frames-fixture-"));
    copyFileSync(join(repo, arg("--board") ?? "scripts/selftest/frames.breezy"), join(dir, "board.breezy"));
    const rec = join(dir, "recording.json");
    try {
      const reference = app.endsWith("BreezyReference.app");
      const { stdout } = reference
        ? await run(join(app, "Contents/MacOS/BreezyReference"), ["--zoom", "--stage", "1512x949", "--name", "replay", "--out", dir, "--replay", join(strokes, f)], { timeout: 150_000 })
        : await run(join(app, "Contents/MacOS/Breezy"), ["-ApplePersistenceIgnoreState", "YES", "-BreezyBoard", join(dir, "board.breezy"),
          "-BreezyReplay", join(strokes, f), "-BreezyReplayOut", rec], { timeout: 150_000 });
      const kept = reference ? stdout.trim().split("\n").filter((l) => l.endsWith(".json")).at(-1)! : rec;
      const frames: FrameTrack | undefined = JSON.parse(readFileSync(kept, "utf8")).frames;
      if (!frames) throw new Error("no frames");
      keep(build, f, frames);
      keep("reference", f, JSON.parse(readFileSync(join(strokes, f), "utf8")).frames);
      console.log(`${f}: ${stdout.split("\n")[0]}, ${frames.rows.length} frames`);
    } catch (e) {
      console.log(`${f}: FAILED ${(e as Error).message.split("\n")[0]}`);
      process.exitCode = 1;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
} finally {
  for (const b of busy) b.kill();
}
