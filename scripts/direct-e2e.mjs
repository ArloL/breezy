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
const spawnGroup = (cmd, args, opts) => {
  const c = spawn(cmd, args, { ...opts, detached: true });
  c.on("exit", (code, signal) => { if (!done) { console.error(`${cmd} exited early (${code ?? signal})`); process.exit(1); } });
  return c;
};
let done = false;

function chromium() {
  if (process.env.BREEZY_CHROMIUM) return process.env.BREEZY_CHROMIUM;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  if (!existsSync(cache)) throw new Error(`no Playwright cache at ${cache}: set BREEZY_CHROMIUM`);
  const dir = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((x, y) => x.slice(9) - y.slice(9)).at(-1);
  if (!dir) throw new Error("no chromium-N in the Playwright cache: set BREEZY_CHROMIUM");
  const app = join(cache, dir, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
  if (!existsSync(app)) throw new Error("no Chromium: set BREEZY_CHROMIUM");
  return app;
}

async function waitFor(what, test, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await test()) return;
  throw new Error(`timed out: ${what}`);
}

for (const port of [58565, 58566, 58568]) {
  const used = await new Promise((r) => createServer().once("error", () => r(true)).listen(port, "127.0.0.1", function () { this.close(() => r(false)); }));
  if (used) throw new Error(`port ${port} is already in use`);
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
  let page;
  await waitFor(`${name} page`, async () => (page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((p) => p.type === "page")));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
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
  const run = async (expression) => {
    const { result, error } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (error || result?.exceptionDetails) throw new Error(`${name}: ${JSON.stringify(error ?? result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)}`);
    return result?.result?.value;
  };
  await send("Page.enable");
  await send("Network.enable");
  // every peer connection the page makes, so that the test can close them
  await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__pcs = []; const P = RTCPeerConnection; window.RTCPeerConnection = function (...a) { const pc = new P(...a); __pcs.push(pc); return pc; }; RTCPeerConnection.prototype = P.prototype;" });
  const go = async (url) => {
    const loaded = new Promise((r) => listeners.push(function l(m) { if (m.method === "Page.loadEventFired") { listeners.splice(listeners.indexOf(l), 1); r(); } }));
    await send("Page.navigate", { url });
    await Promise.race([loaded, sleep(15_000).then(() => { throw new Error(`${name}: ${url} did not load`); })]);
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
  await waitFor(`${name} app`, () => b.run(`document.querySelector(".boards-groups")?.children.length > 0`));
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

/** Broadcast body frames (no `to`) that a sends to the relay while its mouse crosses the board from x0 to x1. */
async function framesWhileMoving(x0, x1) {
  let frames = 0, x = x0;
  const count = (m) => {
    if (m.method !== "Network.webSocketFrameSent") return;
    try {
      const f = JSON.parse(m.params.response.payloadData);
      if (typeof f.body === "string" && f.to === undefined) frames++;
    } catch {}
  };
  a.listeners.push(count);
  for (let i = 0; i <= 40; i++) {
    x = x0 + ((x1 - x0) * i) / 40;
    await a.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: 400 });
    await sleep(16);
  }
  await sleep(300);
  a.listeners.splice(a.listeners.indexOf(count), 1);
  return { frames, x };
}

const cursorX = () => b.run(`(() => { const m = document.querySelector(".presence .cursor")?.style.transform.match(/translate\\((-?[\\d.]+)px/); return m ? +m[1] : null; })()`);
/** b's cursor for a once it stops moving. */
async function settledCursor(what, before, ms = 10_000) {
  let last = null, since = 0;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const x = await cursorX();
    if (x !== last) { last = x; since = Date.now(); }
    else if (x !== null && Date.now() - since > 600 && (before === null || Math.abs(x - before) > 20)) return x;
  }
  throw new Error(`timed out: ${what} (cursor x ${last}, was ${before})`);
}

const start = await cursorX();
const { frames: direct, x: aDirect } = await framesWhileMoving(300, 690);
if (direct > 2) throw new Error(`${direct} body frames reached the relay with the channel open`);
const first = await settledCursor("a's cursor moving on b over the channel", start);
if (Math.abs(first - aDirect) > 60) throw new Error(`b shows a at x ${first} over the channel, a's mouse is at ${aDirect}`);
console.log("direct: relay body frames while moving:", direct, "| b sees a at x", first);

await b.run("__pcs.forEach((pc) => pc.close())");
await waitFor("the fall back", async () => (await a.status()).includes("Direct with 0 of 1 person"));
const { frames: relayed, x: aRelayed } = await framesWhileMoving(aDirect, 300);
if (relayed < 5) throw new Error(`only ${relayed} body frames reached the relay after the channel closed`);
const second = await settledCursor("a's cursor moving on b over the relay", first);
if (Math.abs(second - aRelayed) > 60) throw new Error(`b shows a at x ${second} over the relay, a's mouse is at ${aRelayed}`);
console.log("fallback: relay body frames while moving:", relayed, "| b sees a at x", second);
console.log("ok");
done = true;
process.exit(0);
