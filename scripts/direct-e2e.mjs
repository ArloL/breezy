#!/usr/bin/env node
// Two headless Chromiums in one space on this Mac, against server/dev.sh and the relay under wrangler dev: their direct
// channel opens, cursors stop reaching the relay, and closing the channel falls back to it. Needs real Chromium (not
// ungoogled-chromium); BREEZY_CHROMIUM names one, else Playwright's is used: node scripts/direct-e2e.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir, homedir } from "node:os";
import { join, extname } from "node:path";
import { randomBytes } from "node:crypto";
import { inviteLink } from "../web/sync/crypto.js";

const root = new URL("..", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (n) => randomBytes(n).toString("base64url");
const children = [], dirs = [];
const cleanup = () => {
  for (const c of children) try { process.kill(-c.pid, "SIGKILL"); } catch {}
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
};
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));
process.on("uncaughtException", (e) => { console.error(e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error(e); process.exit(1); });
const spawnGroup = (cmd, args, opts) => spawn(cmd, args, { ...opts, detached: true });

function chromium() {
  if (process.env.BREEZY_CHROMIUM) return process.env.BREEZY_CHROMIUM;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  const dir = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().at(-1);
  const app = join(cache, dir, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
  if (!existsSync(app)) throw new Error("no Chromium: set BREEZY_CHROMIUM");
  return app;
}

async function waitFor(what, test, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await test()) return;
  throw new Error(`timed out: ${what}`);
}

// the web app, without live-server's reloads
const types = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const web = createServer((req, res) => {
  const path = join(root, "web", new URL(req.url, "http://x").pathname.replace(/\/$/, "/index.html"));
  if (!existsSync(path)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream" }).end(readFileSync(path));
}).listen(58565, "127.0.0.1");
process.on("exit", () => web.close());

const relayState = mkdtempSync(join(tmpdir(), "breezy-e2e-relay-"));
dirs.push(relayState);
children.push(spawnGroup("npx", ["--prefix", join(root, "relay"), "wrangler", "dev", "--port", "58568", "--persist-to", relayState], { cwd: join(root, "relay"), stdio: "ignore" }));
children.push(spawnGroup(join(root, "server/dev.sh"), [], { stdio: "ignore" }));
await waitFor("relay", () => fetch("http://127.0.0.1:58568/").then(() => true, () => false), 60_000);
await waitFor("server", () => fetch("http://127.0.0.1:58566/sync.php").then(() => true, () => false));

/** A browser with its own profile, and a DevTools session on its page. */
async function browser(name) {
  const dir = mkdtempSync(join(tmpdir(), `breezy-e2e-${name}-`));
  dirs.push(dir);
  children.push(spawnGroup(chromium(), ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--webrtc-ip-handling-policy=default", "--window-size=1200,800", "about:blank"], { stdio: "ignore" }));
  await waitFor(`${name} DevTools`, () => existsSync(join(dir, "DevToolsActivePort")));
  const port = readFileSync(join(dir, "DevToolsActivePort"), "utf8").split("\n")[0];
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(pages.find((p) => p.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let next = 0;
  const pending = new Map(), listeners = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id !== undefined) pending.get(m.id)?.(m);
    else for (const l of listeners) l(m);
  };
  const send = (method, params = {}) => new Promise((r) => {
    const id = ++next;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const run = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await send("Page.enable");
  await send("Network.enable");
  // every peer connection the page makes, so that the test can close them
  await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__pcs = []; const P = RTCPeerConnection; window.RTCPeerConnection = function (...a) { const pc = new P(...a); __pcs.push(pc); return pc; }; RTCPeerConnection.prototype = P.prototype;" });
  const go = async (url) => {
    await send("Page.navigate", { url });
    await sleep(500);
  };
  const click = (selector) => run(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e?.click(); return !!e; })()`);
  const status = () => run(`document.querySelector(".menu.more .status")?.textContent ?? ""`);
  return { name, send, run, go, click, status, listeners };
}

const space = b64(16), secret = b64(32);
const link = inviteLink({ server: "http://127.0.0.1:58566/sync.php", space, secret, name: "E2E" });
const hash = link.slice(link.indexOf("#join="));

async function joinSpace(b, name) {
  await b.go("http://localhost:58565/");
  await b.run(`import("/sync/idb.js").then((m) => m.saveState("me", { device: ${JSON.stringify(b64(16))}, name: ${JSON.stringify(name)} }))`);
  await b.go("about:blank");
  await b.go(`http://localhost:58565/${hash}`);
  await waitFor(`${name} join prompt`, () => b.click('#sheet:not([hidden]) [data-sheet="ok"]'));
}

const a = await browser("a"), b = await browser("b");
await joinSpace(a, "Ana");
await waitFor("New Board", () => a.click("section.boards-group:has(header .edit) button.new"));
await waitFor("the board name prompt", () => a.run(`!document.querySelector("#sheet").hidden`));
await a.run(`document.querySelector("#sheet input").value = "E2E"`);
await a.click('#sheet [data-sheet="ok"]');
await waitFor("the board on a", () => a.click(".boards-group[data-group^=\"space:\"] li[data-board] .open"));
await joinSpace(b, "Bo");
await waitFor("the board on b", () => b.click(".boards-group[data-group^=\"space:\"] li[data-board] .open"));
await waitFor("a channel", async () => (await a.status()).includes("Direct with 1 of 1 person"), 20_000);
console.log("open:", await a.status());

/** Body frames a sends to the relay while its mouse crosses the board. */
async function framesWhileMoving() {
  let frames = 0;
  const count = (m) => m.method === "Network.webSocketFrameSent" && m.params.response.payloadData.includes('"body"') && frames++;
  a.listeners.push(count);
  for (let i = 0; i < 40; i++) {
    await a.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 300 + i * 10, y: 400 });
    await sleep(16);
  }
  await sleep(300);
  a.listeners.splice(a.listeners.indexOf(count), 1);
  return frames;
}

const direct = await framesWhileMoving();
if (direct > 2) throw new Error(`${direct} body frames reached the relay with the channel open`);
await waitFor("a's cursor on b", () => b.run(`!!document.querySelector(".presence .cursor")`));
console.log("direct: relay body frames while moving:", direct);

await b.run("__pcs.forEach((pc) => pc.close())");
await waitFor("the fall back", async () => (await a.status()).includes("Direct with 0 of 1 person"));
const relayed = await framesWhileMoving();
if (relayed < 5) throw new Error(`only ${relayed} body frames reached the relay after the channel closed`);
console.log("fallback: relay body frames while moving:", relayed);
console.log("ok");
process.exit(0);
