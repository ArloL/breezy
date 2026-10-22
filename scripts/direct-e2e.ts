#!/usr/bin/env node
// Two headless Chromiums in one space on this Mac, against server/dev.sh and the relay under wrangler dev: their direct
// channel opens and carries compact binary bodies, cursors stop reaching the relay, and closing the channel falls back
// to binary relay frames. Prints the sizes it measures. Needs real Chromium (not
// ungoogled-chromium); BREEZY_CHROMIUM names one, else Playwright's is used: node scripts/direct-e2e.ts
import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir, homedir } from "node:os";
import { join, extname } from "node:path";
import { randomBytes } from "node:crypto";
import { inviteLink } from "../web/sync/crypto.ts";
import { buildWeb } from "./build-web.ts";
import { unpack, type Unpacked } from "../web/sync/msgpack.ts";

type Message = {
  id?: number;
  method?: string;
  params?: { response: { opcode: number; payloadData: string } };
  result?: { result?: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } };
  error?: unknown;
};
type Sent = { bin: boolean; n: number; kind: number | null; bytes: number[] | null };
type Relayed = { binary: { to: boolean; n: number }[]; text: number[] };
type Measured = { moves: number; held?: number; relay: Relayed; channel: Sent[] };
type LiveBody = [kind: number, seq: number, at: number, board: Uint8Array | null, caret: Unpacked, items: Map<Unpacked, Unpacked>, group: Unpacked[] | null, cursor: Unpacked];
type Browser = Awaited<ReturnType<typeof browser>>;

const root = new URL("..", import.meta.url).pathname;
// the web app as browsers load it, built afresh
const site = join(root, "build", "web-e2e");
buildWeb(site);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64 = (n: number) => randomBytes(n).toString("base64url");
const children: ChildProcess[] = [], dirs: string[] = [];
const cleanup = () => {
  for (const c of children) try { process.kill(-c.pid!, "SIGKILL"); } catch {}
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
};
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));
process.on("uncaughtException", (e) => { console.error(e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error(e); process.exit(1); });
/** What `name`, a server this starts, says: in build/e2e-NAME.log, its end told when it fails. */
const said = (name: string) => readFileSync(join(root, "build", `e2e-${name}.log`), "utf8").split("\n").slice(-30).join("\n");
const spawnGroup = (name: string, cmd: string, args: string[], opts: SpawnOptions) => {
  mkdirSync(join(root, "build"), { recursive: true });
  const log = openSync(join(root, "build", `e2e-${name}.log`), "w");
  const c = spawn(cmd, args, { ...opts, stdio: ["ignore", log, log], detached: true });
  c.on("exit", (code, signal) => { if (!done) { console.error(`${name} exited early (${code ?? signal}):\n${said(name)}`); process.exit(1); } });
  return c;
};
let done = false;

function chromium() {
  if (process.env.BREEZY_CHROMIUM) return process.env.BREEZY_CHROMIUM;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  if (!existsSync(cache)) throw new Error(`no Playwright cache at ${cache}: set BREEZY_CHROMIUM`);
  const dir = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((x, y) => Number(x.slice(9)) - Number(y.slice(9))).at(-1);
  if (!dir) throw new Error("no chromium-N in the Playwright cache: set BREEZY_CHROMIUM");
  const app = join(cache, dir, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
  if (!existsSync(app)) throw new Error("no Chromium: set BREEZY_CHROMIUM");
  return app;
}

async function waitFor(what: string, test: () => unknown, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await test()) return;
  throw new Error(`timed out: ${what}`);
}

for (const port of [58565, 58566, 58568]) {
  const used = await new Promise<boolean>((r) => createServer().once("error", () => r(true)).listen(port, "127.0.0.1", function (this: Server) { this.close(() => r(false)); }));
  if (used) throw new Error(`port ${port} is already in use`);
}

// the web app, without live-server's reloads
const types: Record<string, string> = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const web = createServer((req, res) => {
  const path = join(site, new URL(req.url!, "http://x").pathname.replace(/\/$/, "/index.html"));
  if (!existsSync(path)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream" }).end(readFileSync(path));
}).listen(58565, "127.0.0.1");
process.on("exit", () => web.close());

const relayState = mkdtempSync(join(tmpdir(), "breezy-e2e-relay-"));
dirs.push(relayState);
children.push(spawnGroup("relay", "npx", ["--prefix", join(root, "relay"), "wrangler", "dev", "--port", "58568", "--persist-to", relayState], { cwd: join(root, "relay") }));
children.push(spawnGroup("server", join(root, "server/dev.sh"), [], {}));
await waitFor("relay", () => fetch("http://127.0.0.1:58568/").then(() => true, () => false), 60_000).catch((e: Error) => Promise.reject(new Error(`${e.message}; it said:\n${said("relay")}`)));
await waitFor("server", () => fetch("http://127.0.0.1:58566/sync.php").then(() => true, () => false)).catch((e: Error) => Promise.reject(new Error(`${e.message}; it said:\n${said("server")}`)));

/** A browser with its own profile, and a DevTools session on its page. */
async function browser(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `breezy-e2e-${name}-`));
  dirs.push(dir);
  children.push(spawnGroup(`chromium-${name}`, chromium(), ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--webrtc-ip-handling-policy=default", "--window-size=1200,800", "about:blank"], {}));
  // a macOS runner checks a browser it has not run before for a while first
  await waitFor(`${name} DevTools`, () => existsSync(join(dir, "DevToolsActivePort")), 60_000);
  const port = readFileSync(join(dir, "DevToolsActivePort"), "utf8").split("\n")[0];
  let page: { type: string; webSocketDebuggerUrl: string } | undefined;
  await waitFor(`${name} page`, async () => (page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((p: { type: string }) => p.type === "page")));
  const ws = new WebSocket(page!.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let next = 0;
  const pending = new Map<number, (m: Message) => void>(), listeners: ((m: Message) => void)[] = [];
  ws.onmessage = (e) => {
    const m: Message = JSON.parse(e.data);
    if (m.id !== undefined) pending.get(m.id)?.(m);
    else for (const l of listeners) l(m);
  };
  const send = (method: string, params: object = {}) => new Promise<Message>((r) => {
    const id = ++next;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const run = async <T = unknown>(expression: string): Promise<T> => {
    const { result, error } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (error || result?.exceptionDetails) throw new Error(`${name}: ${JSON.stringify(error ?? result?.exceptionDetails?.exception?.description ?? result?.exceptionDetails?.text)}`);
    return result?.result?.value as T;
  };
  await send("Page.enable");
  await send("Network.enable");
  // every peer connection the page makes, so that the test can close them
  await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__ch = []; const S = RTCDataChannel.prototype.send; RTCDataChannel.prototype.send = function (d) { if (window.__mute) return; __ch.push({ bin: typeof d !== 'string', n: typeof d === 'string' ? new TextEncoder().encode(d).length : d.byteLength ?? d.size, kind: typeof d === 'string' ? null : new Uint8Array(d)[1], bytes: typeof d === 'string' ? null : Array.from(new Uint8Array(d)) }); return S.call(this, d); }; window.__pcs = []; const P = RTCPeerConnection; window.RTCPeerConnection = function (...a) { const pc = new P(...a); __pcs.push(pc); return pc; }; RTCPeerConnection.prototype = P.prototype;" });
  const go = async (url: string) => {
    const loaded = new Promise<void>((r) => listeners.push(function l(m: Message) { if (m.method === "Page.loadEventFired") { listeners.splice(listeners.indexOf(l), 1); r(); } }));
    await send("Page.navigate", { url });
    await Promise.race([loaded, sleep(15_000).then(() => { throw new Error(`${name}: ${url} did not load`); })]);
  };
  const click = (selector: string) => run(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e?.click(); return !!e; })()`);
  const status = () => run<string>(`document.querySelector(".menu.more .status")?.textContent ?? ""`);
  return { name, send, run, go, click, status, listeners };
}

const space = b64(16), secret = b64(32);
const link = inviteLink({ server: "http://127.0.0.1:58566/sync.php", space, secret, name: "E2E" });
const hash = link.slice(link.indexOf("#join="));

async function joinSpace(b: Browser, name: string) {
  await b.go("http://localhost:58565/");
  await waitFor(`${name} app`, () => b.run(`document.querySelector(".boards-groups")?.children.length > 0`));
  await b.run(`import("/sync/idb.js").then((m) => m.saveState("me", { device: ${JSON.stringify(b64(16))}, name: ${JSON.stringify(name)} }))`);
  await b.go("about:blank");
  await b.go(`http://localhost:58565/${hash}`);
  // not "Breezy is open in another tab", which shows until the page before lets go of the boards
  await waitFor(`${name} join prompt`, () => b.run(`(() => {
    const sheet = document.querySelector("#sheet:not([hidden])");
    if (!sheet?.querySelector(".sheet-title").textContent.startsWith("Join")) return false;
    sheet.querySelector('[data-sheet="ok"]').click();
    return true;
  })()`));
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

/** What a sends while `act` runs: channel messages by kind, and the relay's body frames by kind and size. */
async function sentDuring<R extends object>(act: () => Promise<R>) {
  const relay: Relayed = { binary: [], text: [] };
  const count = (m: Message) => {
    if (m.method !== "Network.webSocketFrameSent") return;
    const { opcode, payloadData } = m.params!.response;
    if (opcode === 2) {
      const f = Buffer.from(payloadData, "base64");
      if (f[0] === 0 || f[0] === 1) relay.binary.push({ to: f[0] === 1, n: f.length });
    } else if (payloadData !== "ping") {
      try { if (typeof JSON.parse(payloadData).body === "string") relay.text.push(payloadData.length); } catch {}
    }
  };
  a.listeners.push(count);
  await a.run("__ch.length = 0");
  const result = await act();
  await sleep(300);
  a.listeners.splice(a.listeners.indexOf(count), 1);
  return { ...result, relay, channel: await a.run<Sent[]>("__ch.slice()") };
}

const sizes = (list: number[]) => (list.length ? `${Math.min(...list)}..${Math.max(...list)} B` : "none");
const bodies = (r: { relay: Relayed }) => r.relay.binary.map((f) => f.n);

/** a's mouse crosses the board from x0 to x1. */
const moving = (x0: number, x1: number) => sentDuring(async () => {
  let x = x0;
  for (let i = 0; i <= 40; i++) {
    x = x0 + ((x1 - x0) * i) / 40;
    await a.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: 400 });
    await sleep(16);
  }
  return { x, moves: 41 };
});

const cursorX = () => b.run<number | null>(`(() => { const m = document.querySelector(".presence .cursor")?.style.transform.match(/translate\\((-?[\\d.]+)px/); return m ? +m[1] : null; })()`);
/** b's cursor for a once it stops moving. */
async function settledCursor(what: string, before: number | null, ms = 10_000) {
  let last: number | null = null, since = 0;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const x = await cursorX();
    if (x !== last) { last = x; since = Date.now(); }
    else if (x !== null && Date.now() - since > 600 && (before === null || Math.abs(x - before) > 20)) return x;
  }
  throw new Error(`timed out: ${what} (cursor x ${last}, was ${before})`);
}

const start = await cursorX();
const d = await moving(300, 690);
const direct = bodies(d).length + d.relay.text.length;
if (direct > 2) throw new Error(`${direct} body frames reached the relay with the channel open`);
if (!d.channel.length) throw new Error("nothing went over the channel while the mouse moved");
if (d.channel.length > d.moves + 4) throw new Error(`${d.channel.length} channel messages for ${d.moves} moves`);
if (d.channel.some((m) => !m.bin)) throw new Error("a channel message was text");
const keyframes = d.channel.filter((m) => m.n > 24);
if (keyframes.length > 3 || keyframes.some((m) => m.n > 40)) throw new Error(`cursor bodies on the channel: ${d.channel.map((m) => m.n)}`);
const first = await settledCursor("a's cursor moving on b over the channel", start);
if (Math.abs(first - d.x) > 60) throw new Error(`b shows a at x ${first} over the channel, a's mouse is at ${d.x}`);
console.log(`direct: ${d.channel.length} channel messages, all binary, cursor ${sizes(d.channel.map((m) => m.n))} (${keyframes.length} keyframes above 24 B); relay body frames while moving: ${direct} | b sees a at x ${first}`);

const mouse = (type: string, x: number, y: number, extra = {}) => a.send("Input.dispatchMouseEvent", { type, x, y, button: "left", ...extra });
const list = (r: { channel: Sent[] }) => r.channel.map((m) => m.n).join(" ");
const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];

/** a types into a new card at height y, then drags it; returns what each sent. */
async function liveSizes(y: number): Promise<{ typed: Measured; dragged: Measured }> {
  const typed = await sentDuring(async () => {
    await mouse("mouseMoved", 300, y);
    for (const clickCount of [1, 2]) {
      await mouse("mousePressed", 300, y, { clickCount });
      await mouse("mouseReleased", 300, y, { clickCount });
    }
    await waitFor("a card in edit", () => a.run(`!!document.querySelector("[contenteditable]")`));
    const keys = "hello world";
    for (const ch of keys) {
      await a.send("Input.dispatchKeyEvent", { type: "char", text: ch });
      await sleep(120);
    }
    return { moves: keys.length };
  });
  const card = await a.run<{ x: number; y: number }>(`(() => { const r = document.activeElement.closest("[contenteditable]")?.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await a.run(`document.activeElement.blur()`);
  const dragged = await sentDuring(async () => {
    await mouse("mousePressed", card.x, card.y, { clickCount: 1 });
    const moves = 20;
    for (let i = 1; i <= moves; i++) { await mouse("mouseMoved", card.x + i * 10, card.y + i * 4, { buttons: 1 }); await sleep(30); }
    const held = await a.run<number>("__ch.length");
    await mouse("mouseReleased", card.x + 200, card.y + 80);
    return { held, moves };
  });
  return { typed, dragged };
}

const over = await liveSizes(200);
for (const [what, sent] of [["typing", over.typed], ["dragging a card", over.dragged]] as const) {
  if (sent.channel.length < 3) throw new Error(`no live bodies went over the channel while ${what}`);
  if (sent.channel.some((m) => !m.bin)) throw new Error(`a channel message was text while ${what}`);
  if (sent.held !== undefined) {
    const moves = sent.channel.slice(0, sent.held), shown = moves.map((m) => `${m.kind}:${m.n}`);
    // a cursor body of its own only as the channel's resend, when a move comes late
    if (moves.length > sent.moves + 2 || moves.filter((m) => m.kind !== 2).length > 2) throw new Error(`not one live body a move while dragging: ${shown}`);
    // past keyframes (with a board) and bodies naming the group's ids, the card goes as its group's offset, never as an item
    const live = moves.filter((m) => m.kind === 2).map((m) => ({ n: m.n, v: unpack(Uint8Array.from(m.bytes!)) as LiveBody }));
    const deltas = live.filter(({ v }) => v[3] === null && v[6]?.length !== 3);
    if (live.some(({ v }) => v[5].size)) throw new Error(`the card went as an item while dragging: ${shown}`);
    if (deltas.filter(({ v }) => v[6]).length < 3) throw new Error(`the card's offset went in few bodies while dragging: ${shown}`);
    // 32 B with a 1-byte seq and a 3-byte at; seq passes 127 and at 6553.5 ms in longer runs
    if (deltas.some(({ n }) => n > 36)) throw new Error(`live bodies above 36 B between keyframes while dragging: ${shown}`);
  }
  console.log(`${what}, channel: ${sent.channel.length} binary messages, median ${median(sent.channel.map((m) => m.n))} B (${list(sent)}); relay body frames: ${bodies(sent).length}`);
}

// b's channel goes silent without closing, as when the network under it goes
await b.run("window.__mute = true");
const muted = Date.now();
await waitFor("the fall back from a silent channel", async () => (await a.status()).includes("Direct with 0 of 1 person"), 6000);
const silentMs = Date.now() - muted;
await b.run("window.__mute = false");
await waitFor("the channel heard again", async () => (await a.status()).includes("Direct with 1 of 1 person"), 6000);
console.log(`silent channel: a falls back in ${(silentMs / 1000).toFixed(1)} s and comes back when it hears b`);

await b.run("__pcs.forEach((pc) => pc.close())");
await waitFor("the fall back", async () => (await a.status()).includes("Direct with 0 of 1 person"));
const r = await moving(d.x, 300);
const relayed = bodies(r);
if (relayed.length < 5) throw new Error(`only ${relayed.length} body frames reached the relay after the channel closed`);
if (r.relay.text.length) throw new Error(`${r.relay.text.length} text body frames reached the relay`);
const second = await settledCursor("a's cursor moving on b over the relay", first);
if (Math.abs(second - r.x) > 60) throw new Error(`b shows a at x ${second} over the relay, a's mouse is at ${r.x}`);
// clear of the bottom edge, where the board would scroll under the drag and send a body a frame
const via = await liveSizes(420);
for (const [what, sent] of [["typing", via.typed], ["dragging a card", via.dragged]] as const) {
  const n = bodies(sent).length;
  if (n < 3) throw new Error(`no live bodies reached the relay while ${what}`);
  // a body a move at most, and the presence and pushed notices
  if (n > sent.moves + 6) throw new Error(`${n} body frames reached the relay for ${sent.moves} moves while ${what}`);
  console.log(`${what}, relay: ${n} binary body frames, median ${median(bodies(sent))} B (${bodies(sent).join(" ")})`);
}
console.log(`fallback: ${relayed.length} binary relay body frames, cursor ${sizes(relayed)} | b sees a at x ${second}`);
console.log("ok");
done = true;
process.exit(0);
