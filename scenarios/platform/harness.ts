// What a native run of a row does on any target: record what the target's own input does to the editor that ?record
// has open, keep the trace, and hand it back for the row's check.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import type { Row, Target } from "./rows.ts";
import type { Trace } from "../../web/record.ts";

const root = new URL("../..", import.meta.url).pathname;

/** adb's arguments for one call of tools/breezy-ime; the device's shell splits what it is given, so each value is quoted. */
export function broadcastArgs(op: string, extras: Record<string, string | number>): string[] {
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const args = ["shell", "am", "broadcast", "-a", "de.k5d.breezy.ime.OP", "--es", "op", quote(op)];
  for (const [k, v] of Object.entries(extras)) args.push(typeof v === "number" ? "--ei" : "--es", k, typeof v === "number" ? String(v) : quote(v));
  return args;
}

/** Records `drive` acting on the editor `page` has open, keeps the trace, and returns it. */
export async function runRow(page: Page, row: Row, target: Target, keyboard: string, drive: () => Promise<void>): Promise<Trace> {
  await page.evaluate(([row, variant, target, keyboard]) => (window as any).breezyRecord.start({ row, variant, target, source: "native", keyboard }), [row.id, row.variant, target, keyboard]);
  await drive();
  const trace: Trace = await page.evaluate(() => (window as any).breezyRecord.stop());
  const name = `${row.id}-${row.variant}`;
  mkdirSync(join(root, "build/platform"), { recursive: true });
  writeFileSync(join(root, "build/platform", `${name}-${target}.json`), JSON.stringify(trace, null, 2));
  if (process.env.RECORD) {
    mkdirSync(join(root, "scenarios/traces", target), { recursive: true });
    writeFileSync(join(root, "scenarios/traces", target, `${name}.json`), JSON.stringify(trace, null, 2) + "\n");
  }
  return trace;
}
