#!/usr/bin/env node
// How collaborating feels between two headless Chromiums on this Mac, against server/dev.sh and the relay under wrangler
// dev, each behind a proxy that delays every chunk: how far a cursor and a dragged card trail, how long a recolour takes
// to show on the other screen, and how long both take again after the network drops. Needs what direct-e2e.mjs needs.
//   node scripts/feel.mjs [--direct] [--relay-ms 25] [--server-ms 40] [--runs 10] [--only cursor,drag,colour,outage]
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { createServer as createHttp } from "node:http";
import { createServer, connect } from "node:net";
import { tmpdir, homedir } from "node:os";
import { join, extname } from "node:path";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { inviteLink } from "../web/sync/crypto.js";

const { values: opt } = parseArgs({ options: {
  direct: { type: "boolean", default: false },
  "relay-ms": { type: "string", default: "25" },
  "server-ms": { type: "string", default: "40" },
  "jitter-ms": { type: "string", default: "0" },
  "stall-ms": { type: "string", default: "0" },
  runs: { type: "string", default: "10" },
  only: { type: "string", default: "cursor,drag,colour,type,create,delete,open,resume,outage,silent,passive" },
} });
const JITTER = Number(opt["jitter-ms"]);
// every 2 s nothing gets through for --stall-ms, as when TCP waits to resend a lost packet
let stallUntil = 0;
if (Number(opt["stall-ms"])) setInterval(() => (stallUntil = Date.now() + Number(opt["stall-ms"])), 2000).unref();
const RUNS = Number(opt.runs), only = new Set(opt.only.split(","));
const root = new URL("..", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (n) => randomBytes(n).toString("base64url");
const children = [], dirs = [];
let done = false;
process.on("exit", () => {
  for (const c of children) try { process.kill(-c.pid, "SIGKILL"); } catch {}
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));
process.on("uncaughtException", (e) => { console.error(e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error(e); process.exit(1); });
const spawnGroup = (cmd, args, opts) => {
  const c = spawn(cmd, args, { ...opts, detached: true });
  c.on("exit", (code, signal) => { if (!done) { console.error(`${cmd} exited early (${code ?? signal})`); process.exit(1); } });
  return c;
};

function chromium() {
  if (process.env.BREEZY_CHROMIUM) return process.env.BREEZY_CHROMIUM;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  const dir = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((x, y) => x.slice(9) - y.slice(9)).at(-1);
  return join(cache, dir, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
}

async function waitFor(what, test, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await test()) return;
  throw new Error(`timed out: ${what}`);
}

/** A TCP proxy from `port` to `to` that delays each chunk by `ms` one way, keeping order. `cut()` drops every
 * connection open now without a word, as a network change does: they hear nothing more, and new ones go through. */
function delayProxy(port, to, ms) {
  const conns = new Set();
  const proxy = {};
  const pipe = (from, into, c) => {
    let due = 0;
    const later = (fn) => {
      due = Math.max(due, Date.now() + ms + Math.random() * JITTER, stallUntil + ms);
      setTimeout(() => c.dead || into.destroyed || fn(), due - Date.now());
    };
    from.on("data", (chunk) => c.dead || later(() => into.write(chunk)));
    // a side's end reaches the other after what it sent before
    from.on("end", () => c.dead || later(() => into.end()));
    from.on("error", () => c.dead || later(() => into.destroy()));
  };
  const server = createServer({ allowHalfOpen: true }, (down) => {
    const up = connect({ port: to, host: "127.0.0.1", allowHalfOpen: true });
    const c = { down, up, dead: Date.now() < (proxy.until ?? 0) };
    conns.add(c);
    const gone = () => down.destroyed && up.destroyed && conns.delete(c);
    down.on("close", gone);
    up.on("close", gone);
    pipe(down, up, c);
    pipe(up, down, c);
  }).listen(port, "127.0.0.1");
  return Object.assign(proxy, {
    server,
    /** New connections go nowhere for `ms`. */
    down(ms) {
      const until = Date.now() + ms;
      this.until = until;
    },
    cut() {
      for (const c of conns) c.dead = true;
      conns.clear();
    },
  });
}

for (const port of [58565, 58566, 58567, 58568, 58569, 58570, 58571]) {
  const used = await new Promise((r) => createServer().once("error", () => r(true)).listen(port, "127.0.0.1", function () { this.close(() => r(false)); }));
  if (used) throw new Error(`port ${port} is already in use`);
}

const types = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };
createHttp((req, res) => {
  const path = join(root, "web", new URL(req.url, "http://x").pathname.replace(/\/$/, "/index.html"));
  if (!existsSync(path)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream" }).end(readFileSync(path));
}).listen(58565, "127.0.0.1");

const relayState = mkdtempSync(join(tmpdir(), "breezy-feel-relay-"));
dirs.push(relayState);
children.push(spawnGroup("npx", ["--prefix", join(root, "relay"), "wrangler", "dev", "--port", "58568", "--persist-to", relayState], { cwd: join(root, "relay"), stdio: "ignore" }));
children.push(spawnGroup(join(root, "server/dev.sh"), [], { stdio: "ignore", env: { ...process.env, BREEZY_DEV_RELAY: "ws://127.0.0.1:58569/" } }));
// a's own way to the relay and the server, so that its network can go alone: its page rewrites the relay's port
const proxies = {
  a: { relay: delayProxy(58570, 58568, Number(opt["relay-ms"])), server: delayProxy(58571, 58566, Number(opt["server-ms"])) },
  b: { relay: delayProxy(58569, 58568, Number(opt["relay-ms"])), server: delayProxy(58567, 58566, Number(opt["server-ms"])) },
};
await waitFor("relay", () => fetch("http://127.0.0.1:58568/").then(() => true, () => false), 60_000);
await waitFor("server", () => fetch("http://127.0.0.1:58566/sync.php").then(() => true, () => false));

// both pages share this Mac's clock: performance.timeOrigin + performance.now()
const PROBE = `
window.__now = () => performance.timeOrigin + performance.now();
window.__moves = [];
addEventListener("pointermove", (e) => __moves.push([__now(), e.clientX, e.clientY]), true);
window.__keys = [];
addEventListener("keydown", (e) => __keys.push([__now(), e.key]), true);
window.__frames = [];
(function frame() {
  const c = document.querySelector(".presence .cursor")?.style.transform.match(/translate\\((-?[\\d.]+)px, (-?[\\d.]+)px/);
  const card = document.querySelector(".card")?.getBoundingClientRect();
  const fronts = [...document.querySelectorAll(".card:not([style*='pointer-events: none']) .front")];
  __frames.push([__now(), c ? +c[1] : null, card ? card.x : null, document.querySelectorAll(".sheet.c2").length, document.querySelector(".card .front")?.textContent.length ?? 0, fronts.length]);
  if (__frames.length > 20000) __frames.splice(0, 10000);
  requestAnimationFrame(frame);
})();
`;

async function browser(name) {
  const dir = mkdtempSync(join(tmpdir(), `breezy-feel-${name}-`));
  dirs.push(dir);
  children.push(spawnGroup(chromium(), ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--webrtc-ip-handling-policy=default", "--window-size=1200,800", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "about:blank"], { stdio: "ignore" }));
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
  if (process.env.FEEL_DEBUG) {
    await send("Runtime.enable");
    listeners.push((m) => m.method === "Runtime.consoleAPICalled" && console.log(`  [${name} ${Date.now() % 100000}]`, m.params.args.map((x) => x.value ?? x.description).join(" ")));
  }
  const own = name === "a" ? "const W = WebSocket; window.WebSocket = function (u, p) { return new W(String(u).replace(':58569/', ':58570/'), p); }; WebSocket.prototype = W.prototype; Object.assign(WebSocket, { OPEN: 1, CLOSED: 3, CONNECTING: 0, CLOSING: 2 });" : "";
  await send("Page.addScriptToEvaluateOnNewDocument", { source: (opt.direct ? "" : "delete window.RTCPeerConnection;") + own + PROBE });
  const go = async (url) => {
    const loaded = new Promise((r) => listeners.push(function l(m) { if (m.method === "Page.loadEventFired") { listeners.splice(listeners.indexOf(l), 1); r(); } }));
    await send("Page.navigate", { url });
    await loaded;
  };
  const click = (selector) => run(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e?.click(); return !!e; })()`);
  const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", ...extra });
  const key = (k) => send("Input.dispatchKeyEvent", { type: "keyDown", key: k, text: k, code: /\d/.test(k) ? `Digit${k}` : undefined });
  return { name, send, run, go, click, mouse, key };
}

const space = b64(16), secret = b64(32);
const hashFor = (port) => { const link = inviteLink({ server: `http://127.0.0.1:${port}/sync.php`, space, secret, name: "Feel" }); return link.slice(link.indexOf("#join=")); };
async function joinSpace(b, name) {
  const hash = hashFor(b.name === "a" ? 58571 : 58567);
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
await a.run(`document.querySelector("#sheet input").value = "Feel"`);
await a.click('#sheet [data-sheet="ok"]');
await waitFor("the board on a", () => a.click(".boards-group[data-group^=\"space:\"] li[data-board] .open"));
// one card, made and left on a
await a.mouse("mouseMoved", 300, 300);
for (const clickCount of [1, 2]) { await a.mouse("mousePressed", 300, 300, { clickCount }); await a.mouse("mouseReleased", 300, 300, { clickCount }); }
await waitFor("a card in edit", () => a.run(`!!document.querySelector("[contenteditable]")`));
await a.send("Input.dispatchKeyEvent", { type: "char", text: "x" });
await a.run(`document.activeElement.blur()`);
await a.mouse("mousePressed", 900, 700, { clickCount: 1 }); await a.mouse("mouseReleased", 900, 700, { clickCount: 1 });
await joinSpace(b, "Bo");
await waitFor("the board on b", () => b.click(".boards-group[data-group^=\"space:\"] li[data-board] .open"));
await waitFor("the card on b", () => b.run(`!!document.querySelector(".card")`), 20_000);
await sleep(opt.direct ? 4000 : 1500);

const now = () => a.run("__now()");
const pct = (xs, p) => { const s = [...xs].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p + 0.5))]; };
/** Mean with a 95 % CI over runs (t for small n). */
const T = [12.71, 4.30, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26, 2.23, 2.20, 2.18, 2.16, 2.14, 2.13, 2.12, 2.11, 2.10, 2.09, 2.09];
function ci(xs) {
  const n = xs.length, m = xs.reduce((s, x) => s + x, 0) / n;
  if (n < 2) return `${m.toFixed(0)}`;
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
  return `${m.toFixed(0)} ± ${((T[n - 2] ?? 1.96) * sd / Math.sqrt(n)).toFixed(0)}`;
}
const results = {};
const report = (k, xs, unit = "ms") => {
  results[k] = xs;
  console.log(`${k.padEnd(34)} ${ci(xs).padStart(12)} ${unit}   (n=${xs.length}, min ${Math.min(...xs).toFixed(0)}, max ${Math.max(...xs).toFixed(0)})`);
};

/** How far b's copy of something a moves trails a's: for each frame b drew mid-sweep, b's time less when a's pointer
 * was at that x, put through `map` from b's x to a's. Also the share of frames mid-sweep where b's copy stood still. */
function lag(moves, frames, col, x0, x1, shift) {
  const out = [];
  let still = 0, total = 0, prev = null;
  for (const f of frames) {
    const x = f[col];
    if (x === null) continue;
    const ax = x + shift;
    if (ax > x0 + 40 && ax < x1 - 40) {
      const i = moves.findIndex((m) => m[1] >= ax);
      if (i > 0) {
        const [t0, p0] = moves[i - 1], [t1, p1] = moves[i];
        out.push(f[0] - (t0 + ((t1 - t0) * (ax - p0)) / (p1 - p0 || 1)));
      }
      total++;
      if (prev !== null && x === prev) still++;
    }
    prev = x;
  }
  return { median: pct(out, 0.5), p95: pct(out, 0.95), still: total ? (100 * still) / total : 0 };
}

/** a's pointer sweeps from x0 to x1 at y, at `speed` px/s, an event every 8 ms; pressed with `buttons`. */
async function sweep(x0, x1, y, buttons = 0, speed = 600) {
  const steps = Math.round((Math.abs(x1 - x0) / speed) * 125);
  for (let i = 0; i <= steps; i++) {
    await a.mouse("mouseMoved", x0 + ((x1 - x0) * i) / steps, y, { buttons });
    await sleep(8);
  }
}

if (only.has("cursor")) {
  const med = [], p95 = [], still = [];
  for (let r = 0; r < RUNS; r++) {
    await sweep(300, 300, 450);
    await sleep(600);
    await a.run("__moves.length = 0"); await b.run("__frames.length = 0");
    await sweep(300, 800, 450);
    await sleep(600);
    const moves = await a.run("__moves"), frames = await b.run("__frames");
    // b's cursor where a's pointer stopped gives the offset between the two screens
    const shift = 800 - frames.at(-1)[1];
    const l = lag(moves, frames, 1, 300, 800, shift);
    med.push(l.median); p95.push(l.p95); still.push(l.still);
  }
  report("cursor lag, median", med); report("cursor lag, p95", p95); report("cursor still frames mid-move", still, "%");
}

const cardAt = (br) => br.run(`(() => { const r = document.querySelector(".card").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 20, left: r.x }; })()`);

if (only.has("drag")) {
  const med = [], p95 = [], still = [], settle = [];
  for (let r = 0; r < RUNS; r++) {
    const c = await cardAt(a);
    const dx = r % 2 ? -480 : 480;
    await a.mouse("mousePressed", c.x, c.y, { clickCount: 1 });
    await sweep(c.x, c.x + 10, c.y, 1);
    await sleep(300);
    await a.run("__moves.length = 0"); await b.run("__frames.length = 0");
    await sweep(c.x + 10, c.x + dx, c.y, 1);
    const up = await now();
    await a.mouse("mouseReleased", c.x + dx, c.y);
    await sleep(2500);
    const moves = await a.run("__moves"), frames = await b.run("__frames");
    const final = (await cardAt(a)).left;
    // the card's left edge sits this far from the pointer on a; the two screens share a camera
    const shift = (c.x - c.left);
    const sorted = dx > 0 ? moves : moves.map(([t, x, y]) => [t, -x, y]);
    const fr = dx > 0 ? frames : frames.map((f) => [f[0], f[1], f[2] === null ? null : -f[2], f[3]]);
    const l = lag(sorted, fr, 2, dx > 0 ? c.x + 10 : -(c.x + 10), dx > 0 ? c.x + dx : -(c.x + dx), dx > 0 ? shift : -shift);
    med.push(l.median); p95.push(l.p95); still.push(l.still);
    // when b's card last moved after a let go
    let last = up;
    for (let i = 1; i < frames.length; i++) if (frames[i][2] !== frames[i - 1][2]) last = frames[i][0];
    settle.push(last - up);
    if (Math.abs(frames.at(-1)[2] - final) > 2) console.log(`  drag ${r}: b's card ends at ${frames.at(-1)[2]}, a's at ${final}`);
  }
  report("drag lag, median", med); report("drag lag, p95", p95); report("drag still frames mid-move", still, "%");
  report("drop: b settles after a lets go", settle);
}

if (only.has("colour")) {
  const shown = [], back = [];
  for (let r = 0; r < RUNS; r++) {
    const c = await cardAt(a);
    await a.mouse("mousePressed", c.x, c.y, { clickCount: 1 }); await a.mouse("mouseReleased", c.x, c.y, { clickCount: 1 });
    await sleep(1500);
    const want = r % 2 ? 0 : 1;
    await b.run("__frames.length = 0");
    const t = await now();
    await a.key(r % 2 ? "3" : "2");
    await waitFor("b to show the colour", () => b.run(`__frames.some((f) => f[3] === ${want})`), 15_000);
    await sleep(1500);
    const frames = await b.run("__frames");
    const i = frames.findIndex((f) => f[3] === want);
    shown.push(frames[i][0] - t);
    // frames after it showed that show it as it was, as when a preview goes before the push is in
    back.push(frames.slice(i).filter((f) => f[3] !== want).length);
  }
  report("recolour shows on b", shown);
  report("recolour: frames b flips back after", back, "frames");
}

if (only.has("type")) {
  const lags = [];
  for (let r = 0; r < RUNS; r++) {
    const c = await cardAt(a);
    for (const clickCount of [1, 2]) { await a.mouse("mousePressed", c.x, c.y, { clickCount }); await a.mouse("mouseReleased", c.x, c.y, { clickCount }); }
    await waitFor("a card in edit", () => a.run(`!!document.querySelector("[contenteditable]")`));
    await a.run(`(() => { const e = document.querySelector("[contenteditable]"); const r = document.createRange(); r.selectNodeContents(e); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
    await sleep(800);
    await b.run("__frames.length = 0");
    const keys = [];
    for (let i = 0; i < 8; i++) {
      keys.push([await now()]);
      await a.send("Input.dispatchKeyEvent", { type: "char", text: "k" });
      await sleep(150);
    }
    await sleep(500);
    const frames = await b.run("__frames");
    if (process.env.FEEL_DEBUG) console.log("  type", r, frames[0][4], frames.at(-1)[4], await a.run(`document.querySelector("[contenteditable]")?.textContent`));
    const base = frames[0][4];
    // the frame b first shows each key's text
    for (let i = 0; i < keys.length; i++) {
      const f = frames.find((f) => f[4] >= base + i + 1);
      if (f) lags.push(f[0] - keys[i][0]);
    }
    await a.run(`document.activeElement.blur()`);
    await a.mouse("mousePressed", 900, 700, { clickCount: 1 }); await a.mouse("mouseReleased", 900, 700, { clickCount: 1 });
    await sleep(1500);
  }
  report("a typed key shows on b, per key", lags);
}

if (only.has("create")) {
  const shown = [];
  for (let r = 0; r < RUNS; r++) {
    const x = 450 + (r % 3) * 220, y = 150 + Math.floor(r / 3) * 150;
    await b.run("__frames.length = 0");
    const before = (await b.run("__frames.at(-1) ?? null"))?.[5];
    await sleep(100);
    const n0 = (await b.run("__frames.at(-1)"))[5];
    await a.mouse("mouseMoved", x, y);
    await a.mouse("mousePressed", x, y, { clickCount: 1 }); await a.mouse("mouseReleased", x, y, { clickCount: 1 });
    const t = await now();
    await a.mouse("mousePressed", x, y, { clickCount: 2 }); await a.mouse("mouseReleased", x, y, { clickCount: 2 });
    if (process.env.FEEL_DEBUG) { await sleep(2000); console.log("  create", r, n0, await a.run(`document.querySelectorAll(".card").length`), await b.run(`__frames.at(-1)`), await a.run(`!!document.querySelector("[contenteditable]")`)); }
    await waitFor("b to show the new card", () => b.run(`__frames.some((f) => f[5] > ${n0})`), 15_000);
    shown.push((await b.run(`__frames.find((f) => f[5] > ${n0})[0]`)) - t);
    await a.send("Input.dispatchKeyEvent", { type: "char", text: "n" });
    await a.run(`document.activeElement.blur()`);
    await a.mouse("mousePressed", 900, 700, { clickCount: 1 }); await a.mouse("mouseReleased", 900, 700, { clickCount: 1 });
    await sleep(1500);
  }
  report("a new card shows on b", shown);
}

if (only.has("delete")) {
  const gone = [];
  for (let r = 0; r < RUNS; r++) {
    const x = 450 + (r % 3) * 220, y = 520;
    await a.mouse("mouseMoved", x, y);
    for (const clickCount of [1, 2]) { await a.mouse("mousePressed", x, y, { clickCount }); await a.mouse("mouseReleased", x, y, { clickCount }); }
    await waitFor("a card in edit", () => a.run(`!!document.querySelector("[contenteditable]")`));
    await a.send("Input.dispatchKeyEvent", { type: "char", text: "d" });
    await a.run(`document.activeElement.blur()`);
    await a.mouse("mousePressed", 900, 700, { clickCount: 1 }); await a.mouse("mouseReleased", 900, 700, { clickCount: 1 });
    await sleep(2000);
    const at = await a.run(`(() => { const e = [...document.querySelectorAll(".card")].find((c) => c.querySelector(".front").textContent === "d"); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await a.mouse("mousePressed", at.x, at.y, { clickCount: 1 }); await a.mouse("mouseReleased", at.x, at.y, { clickCount: 1 });
    await waitFor("the card selected", () => a.run(`!!document.querySelector(".card.selected")`));
    await sleep(300);
    const n0 = (await b.run("__frames.at(-1)"))[5];
    await b.run("__frames.length = 0");
    const t = await now();
    await a.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await waitFor("b to drop the card", () => b.run(`__frames.some((f) => f[5] < ${n0})`), 15_000).catch(async (e) => {
      console.log("  frames", n0, JSON.stringify((await b.run("__frames")).map((f) => f[5]).filter((v, i, xs) => v !== xs[i - 1])), await a.run(`document.querySelectorAll(".card").length`));
      throw e;
    });
    gone.push((await b.run(`__frames.find((f) => f[5] < ${n0})[0]`)) - t);
    await sleep(1500);
  }
  report("a deleted card goes on b", gone);
}

if (only.has("open")) {
  const seesA = [], seenByB = [];
  for (let r = 0; r < RUNS; r++) {
    const back = await b.run(`(() => { const r = document.querySelector('[data-act="boards"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await b.mouse("mousePressed", back.x, back.y, { clickCount: 1 }); await b.mouse("mouseReleased", back.x, back.y, { clickCount: 1 });
    await waitFor("b's board list", () => b.run(`document.body.dataset.screen === "boards"`));
    await sleep(1500);
    await a.run(`window.__seen = null; new MutationObserver(() => { if (!__seen && document.querySelector("#top .people")?.children.length) __seen = __now(); }).observe(document.querySelector("#top .people"), { childList: true })`);
    await a.run(`document.querySelector("#top .people").replaceChildren()`).catch(() => {});
    const t = await b.run(`(() => { const t = __now(); document.querySelector('.boards-group[data-group^="space:"] li[data-board] .open').click(); return t; })()`);
    await b.run("__frames.length = 0");
    let cx = null;
    for (const end = Date.now() + 10_000; Date.now() < end && cx === null;) {
      await a.mouse("mouseMoved", 300 + ((Date.now() / 3) % 400), 450);
      await sleep(20);
      const frames = await b.run("__frames.splice(0)");
      const moving = frames.find((f, i) => i && f[1] !== null && frames[i - 1][1] !== null && f[1] !== frames[i - 1][1]);
      if (moving) cx = moving[0] - t;
    }
    seesA.push(cx ?? 10_000);
    const seen = await a.run("__seen");
    seenByB.push(seen ? seen - t : 10_000);
  }
  report("b opens the board: a's cursor moves on b", seesA);
  report("b opens the board: a shows b", seenByB);
}

if (only.has("resume")) {
  const cursorBack = [], colourBack = [];
  const hide = (hidden) => b.run(`Object.defineProperty(document, "hidden", { configurable: true, get: () => ${hidden} }); Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "${hidden ? "hidden" : "visible"}" }); document.dispatchEvent(new Event("visibilitychange"))`);
  for (let r = 0; r < RUNS; r++) {
    const c = await cardAt(a);
    await a.mouse("mousePressed", c.x, c.y, { clickCount: 1 }); await a.mouse("mouseReleased", c.x, c.y, { clickCount: 1 });
    await sleep(1000);
    // b goes to another app for 5 s, as a phone does, while a recolours
    await hide(true);
    await sleep(1000);
    await a.key(r % 2 ? "3" : "2");
    await sleep(4000);
    const want = r % 2 ? 0 : 1;
    await b.run("__frames.length = 0");
    const t = await now();
    await hide(false);
    let cx = null, colour = null;
    for (const end = Date.now() + 20_000; Date.now() < end && (cx === null || colour === null);) {
      await a.mouse("mouseMoved", 300 + ((Date.now() / 3) % 400), 450);
      await sleep(30);
      const frames = await b.run("__frames.splice(0)");
      const moving = frames.find((f, i) => i && f[1] !== null && frames[i - 1][1] !== null && f[1] !== frames[i - 1][1]);
      if (cx === null && moving) cx = moving[0] - t;
      const col = frames.find((f) => f[3] === want);
      if (colour === null && col) colour = col[0] - t;
    }
    cursorBack.push(cx ?? 20_000); colourBack.push(colour ?? 20_000);
    await sleep(1000);
  }
  report("back from the background: cursor on b", cursorBack);
  report("back from the background: recolour on b", colourBack);
}

for (const [silent, who] of [[false, "a"], [true, "a"], [true, "b"]]) {
  if (!only.has(silent ? (who === "a" ? "silent" : "passive") : "outage")) continue;
  const gone = who === "a" ? a : b;
  const cursorBack = [], colourBack = [];
  for (let r = 0; r < Math.min(RUNS, 5); r++) {
    const c = await cardAt(a);
    await a.mouse("mousePressed", c.x, c.y, { clickCount: 1 }); await a.mouse("mouseReleased", c.x, c.y, { clickCount: 1 });
    await sleep(1500);
    // a's network changes: every connection it has goes silent, and new ones work after 2 s
    // silent: no offline and online events, as when a laptop sleeps or a phone changes networks
    await gone.send("Network.enable");
    if (!silent) await gone.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    proxies[who].relay.cut(); proxies[who].server.cut();
    if (process.env.FEEL_DEBUG) console.log(`  outage at ${Date.now() % 100000}`);
    proxies[who].relay.down(2000); proxies[who].server.down(2000);
    await a.key(r % 2 ? "3" : "2");
    await sleep(2000);
    if (!silent) await gone.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const t = await now();
    const want = r % 2 ? 0 : 1;
    await b.run("__frames.length = 0");
    let cx = null, colour = null;
    for (const end = Date.now() + Number(process.env.FEEL_GIVE_UP ?? 60_000); Date.now() < end && (cx === null || colour === null);) {
      const x = 300 + ((Date.now() / 3) % 400);
      await a.mouse("mouseMoved", x, 450);
      await sleep(50);
      const frames = await b.run("__frames.splice(0)");
      const moving = frames.find((f, i) => i && f[1] !== null && frames[i - 1][1] !== null && f[1] !== frames[i - 1][1]);
      if (cx === null && moving) cx = moving[0] - t;
      const col = frames.find((f) => f[3] === want);
      if (colour === null && col) colour = col[0] - t;
    }
    if (process.env.FEEL_DEBUG) console.log("  debug", r, { cx, colour }, await a.run(`[...document.querySelectorAll(".status")].map((e) => e.textContent).join(" | ")`), "| b:", await b.run(`[...document.querySelectorAll(".status")].map((e) => e.textContent).join(" | ")`), await b.run(`document.querySelectorAll(".sheet.c2").length`));
    cursorBack.push(cx ?? 60_000); colourBack.push(colour ?? 60_000);
    await sleep(3000);
  }
  const what = silent ? (who === "a" ? "a's silent outage" : "b's silent outage") : "a's outage";
  report(`after ${what}: cursor moves on b`, cursorBack);
  report(`after ${what}: recolour on b`, colourBack);
}

console.log(JSON.stringify({ opt, results }));
done = true;
process.exit(0);
