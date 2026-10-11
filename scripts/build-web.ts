// Builds web/ into a directory a browser can load: each module compiled to JS beside the files served as they are.
//
//   node scripts/build-web.ts OUT
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const tsc = `${root}node_modules/.bin/tsc`;

/** Whether `path`, relative to web/, is served as it is. */
export const isStatic = (path: string) =>
  !path.endsWith(".ts") && !path.startsWith("tsconfig") && path !== "test" && !path.startsWith("test/");

export function copyStatics(out: string) {
  cpSync(`${root}web`, out, { recursive: true, filter: (src) => isStatic(src.slice(`${root}web/`.length)) });
}

export function buildWeb(out: string) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  copyStatics(out);
  for (const project of ["web/tsconfig.json", "web/tsconfig.sw.json"]) {
    execFileSync(tsc, ["--project", `${root}${project}`, "--noEmit", "false", "--outDir", out], { stdio: "inherit" });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: build-web.ts OUT");
    process.exit(1);
  }
  buildWeb(out);
}
