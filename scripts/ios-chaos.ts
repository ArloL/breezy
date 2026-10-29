#!/usr/bin/env node
// Chaos for the web app in Safari on the booted iOS Simulator, without WebDriver: node scripts/ios-chaos.ts [--minutes 10]
// [--seed N] [--site DIR]. It serves the built site on 58565 with a script in every page that makes, renames and
// deletes boards and writes cards at random moments, then leaves the page at a random moment: a fresh navigation (the
// page goes into the back-forward cache), back to it, a reload, a new URL, Safari sent to the background or killed.
// On each start the page reports what it shows, and a ledger of acknowledged edits finds those lost or come back
// (LOST, UNEXPECTED), a start that never finished (STUCK), a page gone silent (SILENT) and errors (ERROR).
// The log is build/ios-chaos/SEED.jsonl; --summarize LOG prints a log's findings by what ended the page after the edit.
// It found the IndexedDB stall of #107 within minutes, and the losses of edits Safari's page lifecycle takes.
// Not covered: a second tab (window.open is blocked, and simctl cannot tap), the network and sync, memory pressure.
import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createServer, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values: args } = parseArgs({ options: { minutes: { type: "string" }, seed: { type: "string" }, site: { type: "string" }, summarize: { type: "string" } } });
// as the scenarios serve it
const PORT = 58565;

interface Line { t: number; [k: string]: any }

/** Each lost or returned edit, by what ended its page first after the edit was acknowledged, and how soon after. */
function summarize(lines: Line[]) {
  const acks: { item: string; t: number }[] = [];
  for (const o of lines) {
    if (!o.ack) continue;
    const a = o.ack;
    acks.push({ item: a.card ?? (a.edit === "rename" ? a.to : a.edit === "delete" ? `-${a.title}` : a.title), t: o.t });
    // a renamed board's old title back counts as UNEXPECTED
    if (a.edit === "rename") acks.push({ item: `-${a.title}`, t: o.t });
  }
  const ends: { t: number; how: string }[] = [];
  let restored = -Infinity;
  for (const [i, o] of lines.entries()) {
    if (o.event?.event === "pageshow persisted") restored = o.t;
    if (["kill", "background"].includes(o.leaving?.leave)) ends.push({ t: o.t, how: o.leaving.leave });
    if (!o.event?.event?.startsWith("pagehide")) continue;
    // the page's beacon that it leaves comes some 25 ms before its pagehide
    const planned = lines.slice(Math.max(0, i - 8), i).reverse().find((p) => p.leaving && o.t - p.t < 150);
    const how = planned ? planned.leaving.leave : o.t - restored < 3000 ? "the app's own reload after a restore" : "the app's own reload";
    ends.push({ t: o.t, how: `${how}${o.event.event.includes("persisted") ? " into the back-forward cache" : ""}` });
  }
  const by: Record<string, number[]> = {};
  for (const o of lines) {
    if (!o.FINDING) continue;
    if (!["LOST", "LOST CARD", "UNEXPECTED"].includes(o.FINDING)) {
      (by[o.FINDING] ??= []).push(NaN);
      continue;
    }
    const item = o.FINDING === "UNEXPECTED" ? `-${o.title}` : o.card ?? o.title;
    const at = acks.findLast((a) => a.item === item && a.t <= o.t)?.t;
    const end = at === undefined ? undefined : ends.find((e) => e.t >= at);
    (by[`${o.FINDING} after ${end?.how ?? "?"}`] ??= []).push(end ? end.t - at! : NaN);
  }
  for (const [k, ms] of Object.entries(by).sort((a, b) => b[1].length - a[1].length)) {
    const s = ms.filter((m) => !Number.isNaN(m)).sort((a, b) => a - b);
    console.log(`${String(ms.length).padStart(4)} ${k}${s.length ? `: the edit ${s[s.length >> 1]} ms before it (median), at most ${s.at(-1)} ms` : ""}`);
  }
  const leaves: Record<string, number> = {};
  for (const o of lines) if (o.leaving) leaves[o.leaving.leave] = (leaves[o.leaving.leave] ?? 0) + 1;
  console.log(`${acks.length} edits acknowledged; pages left by ${JSON.stringify(leaves)}`);
}

if (args.summarize) {
  summarize(readFileSync(args.summarize, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  process.exit(0);
}

let seed = Number(args.seed ?? Date.now() % 1e9);
const END = Date.now() + Number(args.minutes ?? 10) * 60_000;
const dir = args.site ?? join(root, "build", "ios-chaos", "site");
if (!args.site) execFileSync(join(root, "scripts/build-site.sh"), [dir, "chaos"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
mkdirSync(join(root, "build", "ios-chaos"), { recursive: true });
const out = join(root, "build", "ios-chaos", `${seed}.jsonl`);
writeFileSync(out, "");

const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
const simctl = (...args: string[]) => new Promise<void>((r) => execFile("xcrun", ["simctl", ...args], { timeout: 30_000 }, () => r()));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const types: Record<string, string> = {
  ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json",
};

const t0 = Date.now();
const lines: Line[] = [];
const record = (o: object) => {
  const line = { t: Date.now() - t0, ...o };
  lines.push(line);
  appendFileSync(out, `${JSON.stringify(line)}\n`);
  if ("FINDING" in o) console.log(JSON.stringify(line).slice(0, 300));
};
const findings: Record<string, number> = {};
const finding = (kind: string, o: object) => {
  findings[kind] = (findings[kind] ?? 0) + 1;
  record({ FINDING: kind, ...o });
};

/** What the local group must show: a title → when its edit was acknowledged, 0 for what was there before. */
const expected = new Map<string, number>();
/** What the board named cards must show: a card's text → when it was acknowledged. */
const cards = new Map<string, number>();
const ackLog: { op: string; title: string; at: number }[] = [];
let known = false, lastKill = -Infinity, lastHeard = Date.now(), counter = 0, steps = 0, busyHost = false;
// a kill may take what was not written yet
const nearKill = (at: number) => at > lastKill - 2000 && at <= lastKill;

function check(titles: string[], how: string) {
  if (!known) {
    for (const t of titles) expected.set(t, 0);
    known = true;
    return;
  }
  const shown = new Set(titles);
  for (const [t, at] of expected) {
    if (shown.has(t)) continue;
    if (nearKill(at)) record({ lostNearKill: t });
    else finding("LOST", { title: t, ackedAgo: Date.now() - at, how });
    expected.delete(t);
  }
  for (const t of shown) {
    if (expected.has(t)) continue;
    const gone = ackLog.findLast((a) => (a.op === "delete" || a.op === "rename") && a.title === t);
    if (gone && nearKill(gone.at)) record({ revertedNearKill: t });
    else finding("UNEXPECTED", { title: t, how });
    expected.set(t, 0);
  }
}

function checkCards(shown: string[] | null, how: string) {
  if (!shown) return;
  const set = new Set(shown);
  for (const [c, at] of cards) {
    if (set.has(c)) continue;
    if (nearKill(at)) record({ lostNearKill: c });
    else finding("LOST CARD", { card: c, ackedAgo: Date.now() - at, how });
    cards.delete(c);
  }
  for (const c of set) {
    if (cards.has(c)) continue;
    finding("UNEXPECTED CARD", { card: c, how });
    cards.set(c, 0);
  }
}

/** What a page does next: up to three edits, each followed by a wait mostly within the app's 300 ms save delays, then a leave. */
function plan() {
  const ops: object[] = [];
  for (let i = 0, n = Math.floor(rand() * 4); i < n; i++) {
    if (!expected.has("cards")) {
      if (!ops.length) ops.push({ edit: "new", title: "cards" });
      continue;
    }
    if (rand() < 0.4) {
      ops.push({ card: `c${++counter}`, end: "escape" }, { wait: Math.floor(rand() * 600) });
      continue;
    }
    const titles = [...expected.keys()].filter((t) => t !== "cards");
    const kind = titles.length && rand() < 0.35 ? pick(["rename", "delete"]) : "new";
    if (kind === "new") ops.push({ edit: "new", title: `b${++counter}` });
    else if (kind === "rename") ops.push({ edit: "rename", title: pick(titles), to: `b${++counter}` });
    else ops.push({ edit: "delete", title: pick(titles) });
    ops.push({ wait: Math.floor(rand() < 0.6 ? rand() * 400 : rand() * 2500) });
  }
  // now and then with a card's editor still open
  if (expected.has("cards") && rand() < 0.3) ops.push({ card: `c${++counter}`, end: "open" }, { wait: Math.floor(rand() * 500) });
  ops.push({ leave: pick(["fresh", "fresh", "back", "back", "reload", "background", "kill", "hash"]) });
  return { ops, step: ++steps };
}

async function host(action: string) {
  busyHost = true;
  try {
    if (action === "background") {
      await simctl("launch", "booted", "com.apple.Preferences");
      await sleep(300 + rand() * 6000);
      await simctl("launch", "booted", "com.apple.mobilesafari");
    } else if (action === "kill") {
      await sleep(rand() * 400);
      lastKill = Date.now();
      await simctl("terminate", "booted", "com.apple.mobilesafari");
      await sleep(500);
      await simctl("openurl", "booted", `http://localhost:${PORT}/`);
    }
  } finally {
    busyHost = false;
    lastHeard = Date.now();
  }
}

// In every page of the app, ahead of its own scripts. It drives the app through its DOM as a person would, and says
// over beacons what it did, what it shows and each write to IndexedDB, as a frozen page answers nothing later.
const PAGE = `<script>
(() => {
  const post = (path, o) => fetch(path, { method: "POST", body: JSON.stringify(o), keepalive: true }).then((r) => r.json()).catch(() => null);
  const beacon = (path, o) => navigator.sendBeacon(path, JSON.stringify(o));
  const event = (name) => beacon("/event", { event: name, age: Math.round(performance.now()) });
  addEventListener("error", (e) => beacon("/log", { error: String(e.message), at: e.filename + ":" + e.lineno }));
  addEventListener("unhandledrejection", (e) => beacon("/log", { rejection: String(e.reason?.stack ?? e.reason) }));
  for (const level of ["warn", "error"]) {
    const was = console[level].bind(console);
    console[level] = (...a) => { beacon("/log", { console: level, text: a.map((x) => x?.stack ?? String(x)).join(" ").slice(0, 500) }); was(...a); };
  }
  let inHide = false;
  for (const m of ["put", "delete"]) {
    const was = IDBObjectStore.prototype[m];
    IDBObjectStore.prototype[m] = function (...a) {
      const t = this.transaction;
      if (!t.logged) {
        t.logged = true;
        const key = String(m === "put" ? a[1] : a[0]);
        const idb = (what, extra) => beacon("/event", { idb: what + " " + key, age: Math.round(performance.now()), inHide, ...extra });
        idb(m);
        t.addEventListener("complete", () => idb("complete"));
        t.addEventListener("abort", () => idb("abort", { error: String(t.error) }));
        t.addEventListener("error", () => idb("error", { error: String(t.error) }));
      }
      return was.apply(this, a);
    };
  }
  addEventListener("pagehide", () => { inHide = true; setTimeout(() => (inHide = false)); }, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (what, f, ms = 8000) => {
    for (const end = performance.now() + ms; ; await sleep(30)) {
      const v = f();
      if (v) return v;
      if (performance.now() > end) throw new Error("timed out: " + what);
    }
  };
  const OTHER = "Breezy is open in another tab";
  const sheetTitle = () => document.querySelector("#sheet:not([hidden]) .sheet-title")?.textContent ?? null;
  const clickSheet = (k) => document.querySelector('#sheet [data-sheet="' + k + '"]').click();
  const local = () => document.querySelector('.boards-group[data-group="local"]');
  const titles = () => [...(local()?.querySelectorAll("li[data-board] .open") ?? [])].map((b) => b.textContent);
  const rowOf = (t) => [...(local()?.querySelectorAll("li[data-board]") ?? [])].find((li) => li.querySelector(".open").textContent === t);
  const state = async () => ({
    screen: document.body.dataset.screen, sheet: sheetTitle(), url: location.href.replace(/#join=.*/, "#join=…"), age: Math.round(performance.now()),
    locks: await Promise.race([navigator.locks.query().then((q) => ({ held: q.held.length, pending: q.pending.length })), sleep(1000).then(() => "no answer")]),
  });
  // a touch the app tracks as a press, where a click would not do
  const press = (el, x, y) => {
    const at = { bubbles: true, clientX: x, clientY: y, pointerId: 9, isPrimary: true, pointerType: "touch" };
    el.dispatchEvent(new PointerEvent("pointerdown", at));
    el.dispatchEvent(new PointerEvent("pointerup", at));
  };
  const escape = () => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  async function toList() {
    if (document.body.dataset.screen === "board") {
      const b = document.querySelector('[data-act="boards"]'), r = b.getBoundingClientRect();
      press(b, r.x + r.width / 2, r.y + r.height / 2);
    }
    await until("the board list", () => document.body.dataset.screen === "boards" && local());
  }
  async function openCards() {
    const row = rowOf("cards");
    if (!row) return false;
    row.querySelector(".open").click();
    await until("the cards board", () => document.body.dataset.screen === "board");
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return true;
  }
  // a card's front, without its back's text
  const cardTexts = () => [...document.querySelectorAll(".cards > [data-id]")].map((c) => c.firstChild?.children[0]?.textContent.trim()).filter(Boolean);
  async function readCards() {
    if (!(await openCards())) return null;
    const texts = cardTexts();
    await toList();
    return texts;
  }
  async function card(op) {
    if (!(await openCards())) return { skipped: true };
    let x, y;
    for (let k = 0; k < 40; k++) {
      x = 40 + Math.random() * (innerWidth - 80);
      y = 160 + Math.random() * (innerHeight - 320);
      if (!document.elementFromPoint(x, y)?.closest(".cards > [data-id], .lanes > *, button, .pill, .plus, header")) break;
    }
    const target = document.elementFromPoint(x, y);
    press(target, x, y);
    await sleep(60);
    press(target, x, y);
    if (!(await until("a card's editor", () => document.activeElement?.isContentEditable, 2000).catch(() => false))) return { skipped: "the double tap opened nothing" };
    // it came down on a card already there, which it edits
    if (document.activeElement.textContent.trim()) {
      escape();
      await until("the edit ended", () => !document.activeElement?.isContentEditable, 2000).catch(() => {});
      return { skipped: "the double tap came down on a card" };
    }
    document.execCommand("insertText", false, op.card);
    if (op.end === "escape") {
      escape();
      await until("the edit ended", () => !document.activeElement?.isContentEditable, 2000);
    }
    return {};
  }
  async function edit(op) {
    if (op.card) return card(op);
    if (op.edit === "new") {
      local().querySelector("button.new").click();
      await until("the name sheet", () => sheetTitle() === "New Board");
      const input = document.querySelector("#sheet input");
      input.value = op.title;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      clickSheet("ok");
      await until("the new board open", () => document.body.dataset.screen === "board");
      return {};
    }
    const row = rowOf(op.title);
    if (!row) return { skipped: true };
    row.querySelector(".edit").click();
    await until("the board's sheet", () => sheetTitle() === "Rename Board");
    if (op.edit === "rename") {
      const input = document.querySelector("#sheet input");
      input.value = op.to;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      clickSheet("ok");
      await until("the rename", () => rowOf(op.to));
    } else {
      clickSheet("danger");
      await until("the delete sheet", () => sheetTitle()?.startsWith("Delete"));
      clickSheet("danger");
      await until("the delete", () => !rowOf(op.title));
    }
    return {};
  }
  let running = false;
  async function run(how) {
    if (running) return;
    running = true;
    try {
      // up: the list drawn and the link read, or the other tab's sheet
      await until("the app ready", () => (document.body.dataset.screen && local() && !location.hash.includes("#join=")) || sheetTitle() === OTHER)
        .catch(async (e) => { await post("/stuck", { how, error: e.message, ...(await state()) }); throw e; });
      if (sheetTitle() === OTHER) {
        const r = await post("/hello", { how, other: true, hidden: document.hidden, ...(await state()) });
        if (!r?.useHere) return;
        clickSheet("ok");
        how = "took over";
        await until("the boards handed over", () => sheetTitle() !== OTHER && local())
          .catch(async (e) => { await post("/stuck", { how, error: e.message, ...(await state()) }); throw e; });
      }
      await toList();
      const list = titles();
      const shownCards = await readCards().catch(() => null);
      const { ops, step } = await post("/hello", { how, titles: list, cards: shownCards, ...(await state()) });
      for (const op of ops) {
        if (op.wait != null) await sleep(op.wait);
        else if (op.edit || op.card) {
          const r = await edit(op).catch((e) => ({ failed: e.message }));
          if (r.failed) await post("/stuck", { how, step, op, error: r.failed, ...(await state()) });
          else if (!r.skipped) beacon("/ack", { ...op, step });
          else if (r.skipped !== true) beacon("/event", { skipped: r.skipped, op });
          // the next edit starts from the list, unless a card is left open on purpose
          if (op.end !== "open") await toList().catch(() => {});
        } else if (op.leave) {
          beacon("/leaving", { leave: op.leave, step });
          if (op.leave === "fresh") location.href = "/blank?then=fresh";
          else if (op.leave === "back") location.href = "/blank?then=back";
          else if (op.leave === "reload") location.reload();
          else if (op.leave === "hash") location.href = "/?h=" + step + "#" + step;
          else await post("/host", { action: op.leave });
        }
      }
    } catch {} finally {
      running = false;
    }
  }
  addEventListener("pageshow", (e) => { event("pageshow" + (e.persisted ? " persisted" : "")); run(e.persisted ? "restored" : "load"); });
  addEventListener("pagehide", (e) => event("pagehide" + (e.persisted ? " persisted" : "")));
  document.addEventListener("visibilitychange", () => { event(document.hidden ? "hidden" : "visible"); document.hidden || run("visible"); });
})();
</script>`;

// another page, from which the app is navigated to afresh or gone back to
const BLANK = `<!doctype html><title>blank</title><body><script>
const then = new URLSearchParams(location.search).get("then");
setTimeout(() => (then === "back" ? history.back() : (location.href = "/")), Math.random() * 300);
</script>`;

// the site's data of the runs before, gone
const CLEAR = `<!doctype html><title>clear</title><body><script>
(async () => {
  const regs = await navigator.serviceWorker.getRegistrations();
  if (regs.length) { await Promise.all(regs.map((r) => r.unregister())); return location.reload(); }
  for (const name of await caches.keys()) await caches.delete(name);
  for (const { name } of await indexedDB.databases()) await new Promise((res, rej) => Object.assign(indexedDB.deleteDatabase(name), { onsuccess: res, onerror: rej, onblocked: rej }));
  location.href = "/";
})();
</script>`;

const json = (res: ServerResponse, o: unknown) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(o));
const html = (res: ServerResponse, body: string) => res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" }).end(body);

createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      const o = JSON.parse(body || "{}");
      lastHeard = Date.now();
      switch (url.pathname) {
        case "/hello": {
          // the tab in front takes the boards
          if (o.other) return record({ hello: o }), json(res, { useHere: !o.hidden });
          check(o.titles, o.how);
          checkCards(o.cards, o.how);
          const p = plan();
          record({ hello: { how: o.how, titles: o.titles.length, age: o.age, locks: o.locks }, plan: p });
          return json(res, p);
        }
        case "/ack": {
          const at = Date.now();
          ackLog.push({ op: o.edit, title: o.title, at });
          if (o.edit === "new") expected.set(o.title, at);
          if (o.edit === "rename") {
            expected.delete(o.title);
            expected.set(o.to, at);
          }
          if (o.edit === "delete") expected.delete(o.title);
          if (o.card) cards.set(o.card, at);
          record({ ack: o });
          return res.writeHead(204).end();
        }
        case "/stuck":
          finding("STUCK", o);
          return json(res, {});
        case "/log":
          finding("ERROR", o);
          return res.writeHead(204).end();
        case "/event":
          record({ event: o });
          return res.writeHead(204).end();
        case "/leaving":
          record({ leaving: o });
          return res.writeHead(204).end();
        case "/host":
          record({ host: o.action });
          host(o.action);
          return json(res, {});
      }
      res.writeHead(404).end();
    });
    return;
  }
  if (url.pathname === "/chaos-clear") return html(res, CLEAR);
  if (url.pathname === "/blank") return html(res, BLANK);
  const path = join(dir, url.pathname.replace(/\/$/, "/index.html"));
  if (!existsSync(path)) return res.writeHead(404).end();
  let body: Buffer | string = readFileSync(path);
  // the service worker's copy too
  if (path.endsWith(".html")) body = body.toString().replace("<head>", `<head>${PAGE}`);
  res.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream" }).end(body);
}).listen(PORT, "127.0.0.1", async () => {
  console.log(`seed ${seed}, ${args.minutes ?? 10} min, log ${out}`);
  record({ start: { seed, site: dir } });
  // frozen pages of a run before go with Safari, its tabs, and the sites' data, as a service worker a scenario left on
  // this port served the first page from its snapshot, without the script, and the run heard nothing
  await simctl("terminate", "booted", "com.apple.mobilesafari");
  const sim = join(homedir(), "Library/Developer/CoreSimulator/Devices", execFileSync("xcrun", ["simctl", "getenv", "booted", "SIMULATOR_UDID"]).toString().trim(), "data");
  for (const f of ["SafariTabs.db", "BrowserState.db"]) for (const x of ["", "-wal", "-shm"]) rmSync(join(sim, "Library/Safari", f + x), { force: true });
  const safari = execFileSync("xcrun", ["simctl", "get_app_container", "booted", "com.apple.mobilesafari", "data"]).toString().trim();
  rmSync(join(safari, "Library/WebKit/com.apple.mobilesafari/WebsiteData"), { recursive: true, force: true });
  await simctl("openurl", "booted", `http://localhost:${PORT}/chaos-clear`);
  for (;;) {
    await sleep(2000);
    if (Date.now() > END) {
      record({ end: { steps, findings } });
      summarize(lines);
      process.exit(0);
    }
    if (!busyHost && Date.now() - lastHeard > 25_000) {
      finding("SILENT", { sinceMs: Date.now() - lastHeard });
      lastHeard = lastKill = Date.now();
      await simctl("terminate", "booted", "com.apple.mobilesafari");
      await simctl("openurl", "booted", `http://localhost:${PORT}/`);
    }
  }
});
