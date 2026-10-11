// Serves web/ on port 58565 to this Mac and the local network, rebuilt on every save, reloading the page after each build.
//
//   npm run dev
import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { readFileSync, watch } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWeb, copyStatics, isStatic } from "./build-web.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = `${root}build/web-dev`;
const PORT = 58565;
const RELOAD = `<script>new EventSource("/reload").onmessage = () => location.reload();</script>`;
const types: Record<string, string> = {
  ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json",
};

try {
  buildWeb(out);
} catch {
  // type errors: tsc emits regardless, and the watchers below print them
}

const pages = new Set<ServerResponse>();
let pending: NodeJS.Timeout | undefined;
const reload = () => {
  clearTimeout(pending);
  pending = setTimeout(() => { for (const p of pages) p.write("data: reload\n\n"); }, 100);
};

for (const project of ["web/tsconfig.json", "web/tsconfig.sw.json"]) {
  spawn(`${root}node_modules/.bin/tsc`, ["--project", `${root}${project}`, "--noEmit", "false", "--outDir", out, "--watch", "--preserveWatchOutput"], { stdio: "inherit" });
}
watch(`${root}web`, { recursive: true }, (_, file) => {
  if (file && isStatic(file)) copyStatics(out);
});
watch(out, { recursive: true }, reload);

createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (path === "/reload") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    pages.add(res);
    req.on("close", () => pages.delete(res));
    return;
  }
  const file = join(out, path.endsWith("/") ? `${path}index.html` : path);
  try {
    let body: Buffer | string = readFileSync(file);
    if (file.endsWith("index.html")) body = body.toString().replace("</head>", `${RELOAD}</head>`);
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}/`));
