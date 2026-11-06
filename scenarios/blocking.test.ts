// The harness serves the pages while idb and clang run: on CI's runner, its loop stood still 12.9 s for clang and up to
// 16 s for idb, its timers late by as much, mid-case.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { built, HOME_ICON, homeIcon } from "./ios.ts";

setTimeout(() => process.exit(1), 30_000).unref();

/** Runs body with `tools` on PATH, each a shell script, and how late the loop's timers ran meanwhile, in ms. */
async function withTools(tools: Record<string, string>, body: (dir: string) => Promise<void>): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "breezy-tools-")), path = process.env.PATH;
  for (const [name, script] of Object.entries(tools)) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  process.env.PATH = `${dir}${delimiter}${path}`;
  // from the start: a block before a monitor's first tick is no gap between its ticks
  let last = performance.now(), late = 0;
  const tick = setInterval(() => {
    late = Math.max(late, performance.now() - last - 10);
    last = performance.now();
  }, 10);
  try {
    await body(dir);
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    clearInterval(tick);
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
  return Math.round(late);
}

test("the Home Screen's icon is found without holding up the harness", async () => {
  const json = JSON.stringify([{ type: "Button", AXLabel: HOME_ICON, frame: { x: 10, y: 20, width: 60, height: 60 } }]);
  let icon;
  const late = await withTools({ uvx: `sleep 1; echo '${json}'` }, async () => {
    icon = await homeIcon("U");
  });
  assert.deepEqual(icon, { x: 40, y: 50 });
  assert.ok(late < 300, `the loop stood still ${late} ms`);
});

test("sim-finger is compiled without holding up the harness, and once", async () => {
  let bin = "";
  const late = await withTools({ xcrun: 'sleep 1; while [ "$1" != -o ]; do shift; done; touch "$2"' }, async (dir) => {
    writeFileSync(join(dir, "f.m"), "");
    bin = await built(join(dir, "f.m"), join(dir, "out", "f"));
    assert.ok(existsSync(bin));
    const t = Date.now();
    await built(join(dir, "f.m"), bin);
    assert.ok(Date.now() - t < 500, "compiled again");
  });
  assert.ok(late < 300, `the loop stood still ${late} ms`);
});
