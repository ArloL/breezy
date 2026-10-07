import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";

const SCOPE = "https://example.org/breezy/";
const source = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const hash = (body) => createHash("sha256").update(body).digest("hex");

class FakeCache {
  entries = new Map();
  async match(key) {
    const e = this.entries.get(typeof key === "string" ? key : key.url);
    return e && new Response(e.body, { headers: e.headers });
  }
  async put(key, res) {
    this.entries.set(typeof key === "string" ? key : key.url, { body: await res.arrayBuffer(), headers: Object.fromEntries(res.headers) });
  }
}

class FakeCaches {
  stores = new Map();
  async open(name) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache());
    return this.stores.get(name);
  }
  async has(name) { return this.stores.has(name); }
  async delete(name) { return this.stores.delete(name); }
  async keys() { return [...this.stores.keys()]; }
}

/** GitHub Pages: serves the deployed files, or whatever a test says instead. */
class Server {
  files = {};
  override = {};
  requests = [];
  down = false;
  hang = new Set();
  deploy(version, extra = {}) {
    this.files = { "index.html": `<p>${version}</p>`, "main.js": `// ${version}`, ...extra };
    const files = Object.fromEntries(Object.entries(this.files).map(([p, b]) => [p, hash(b)]));
    this.files["version.json"] = JSON.stringify({ version, files });
  }
  fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const path = url.href.slice(SCOPE.length).split("?")[0] || "index.html";
    this.requests.push(path);
    if (this.hang.has(path)) {
      return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    if (this.down) throw new TypeError("Load failed");
    const body = this.override[path] ?? this.files[path];
    if (body === undefined) return new Response("", { status: 404 });
    const type = path.endsWith(".js") ? "text/javascript" : path.endsWith(".json") ? "application/json" : "text/html";
    return new Response(body, { headers: { "content-type": type } });
  };
}

function worker() {
  const server = new Server();
  const caches = new FakeCaches();
  const handlers = {};
  const timers = [];
  const ctx = {
    self: null,
    registration: { scope: SCOPE },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    caches,
    fetch: server.fetch,
    Response, Headers, URL, TextEncoder, crypto,
    console: { warn: () => {} },
    // timeouts fire only when a test says so
    AbortSignal: { timeout: (ms) => { const c = new AbortController(); timers.push(c); return c.signal; } },
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(source, ctx);

  const dispatch = (type, fields) => {
    const waits = [];
    let response;
    handlers[type]({ ...fields, respondWith: (p) => { response = p; }, waitUntil: (p) => waits.push(p) });
    return { response, done: Promise.all(waits) };
  };
  const text = async (p) => (await p).text();
  return {
    server, caches, timers,
    /** A cold launch: returns the page's HTML and waits for the update check it starts. */
    async launch() {
      const { response, done } = dispatch("fetch", { request: { url: SCOPE, method: "GET", mode: "navigate" } });
      const html = await text(response);
      await done;
      return html;
    },
    /** A cold launch's response alone, not waiting for its update check. */
    respond() {
      return text(dispatch("fetch", { request: { url: SCOPE, method: "GET", mode: "navigate" } }).response);
    },
    get(path) {
      return dispatch("fetch", { request: { url: SCOPE + path, method: "GET", mode: "cors" } }).response;
    },
    async message(type) {
      let reply;
      const { done } = dispatch("message", { data: { type }, ports: [{ postMessage: (d) => { reply = d; } }] });
      await done;
      return { ...reply };
    },
    snapshots: async () => (await caches.keys()).filter((n) => n.startsWith("breezy-snapshot-")).sort(),
  };
}

test("the first launch comes from the network, then a snapshot of it boots without one", async () => {
  const w = worker();
  w.server.deploy("1");
  assert.equal(await w.launch(), "<p>1</p>");
  w.server.down = true;
  assert.equal(await w.launch(), "<p>1</p>");
  assert.equal(await (await w.get("main.js")).text(), "// 1");
});

test("a launch never waits for the network", async () => {
  const w = worker();
  w.server.deploy("1");
  await w.launch();
  w.server.deploy("2");
  for (const path of ["version.json", "index.html", "main.js"]) w.server.hang.add(path);
  assert.equal(await w.respond(), "<p>1</p>");
  assert.equal(await (await w.get("main.js")).text(), "// 1");
});

test("an update downloads in the background and runs from the next launch on", async () => {
  const w = worker();
  w.server.deploy("1");
  await w.launch();
  w.server.deploy("2");
  assert.equal(await w.launch(), "<p>1</p>", "the launch that finds the update still runs the old version");
  assert.equal(await (await w.get("main.js")).text(), "// 1", "and so do its modules");
  assert.deepEqual(await w.message("status"), { current: "1", next: "2" });
  w.server.down = true;
  assert.equal(await w.launch(), "<p>2</p>");
  assert.equal(await (await w.get("main.js")).text(), "// 2");
  assert.deepEqual(await w.message("status"), { current: "2", next: null });
});

test("switching versions deletes older snapshots", async () => {
  const w = worker();
  w.server.deploy("1");
  await w.launch();
  w.server.deploy("2");
  await w.launch();
  assert.deepEqual(await w.snapshots(), ["breezy-snapshot-1", "breezy-snapshot-2"]);
  await w.launch();
  assert.deepEqual(await w.snapshots(), ["breezy-snapshot-2"]);
});

test("a deploy caught halfway, with a file not matching its hash, is not used", async () => {
  const w = worker();
  w.server.deploy("1");
  await w.launch();
  w.server.deploy("2");
  w.server.override["main.js"] = "// 1";
  await w.launch();
  assert.deepEqual(await w.message("status"), { current: "1", next: null });
  assert.deepEqual(await w.snapshots(), ["breezy-snapshot-1"]);
  delete w.server.override["main.js"];
  await w.message("check");
  assert.deepEqual(await w.message("status"), { current: "1", next: "2" });
});

test("a failed download keeps the running version and retries on the next check", async () => {
  const w = worker();
  w.server.deploy("1");
  await w.launch();
  w.server.deploy("2");
  delete w.server.files["main.js"];
  await w.launch();
  assert.deepEqual(await w.message("status"), { current: "1", next: null });
  w.server.deploy("2");
  await w.message("check");
  assert.deepEqual(await w.message("status"), { current: "1", next: "2" });
});

test("a download that hangs is given up when its timer runs out", async () => {
  const w = worker();
  w.server.deploy("1");
  await w.launch();
  w.server.deploy("2");
  w.server.hang.add("main.js");
  const check = w.message("check");
  await new Promise((r) => setTimeout(r, 10));
  for (const t of w.timers) t.abort();
  await check;
  assert.deepEqual(await w.message("status"), { current: "1", next: null });
  assert.deepEqual(await w.snapshots(), ["breezy-snapshot-1"]);
});

test("checks at the same time fetch the version once", async () => {
  const w = worker();
  w.server.deploy("1");
  await Promise.all([w.message("check"), w.message("check"), w.launch()]);
  assert.equal(w.server.requests.filter((p) => p === "version.json").length, 1);
});

test("a launch finding its snapshot gone falls back to the network", async () => {
  const w = worker();
  w.server.deploy("1");
  await w.launch();
  await w.caches.delete("breezy-snapshot-1");
  assert.equal(await w.launch(), "<p>1</p>");
  assert.ok(await w.caches.has("breezy-snapshot-1"), "the check downloads the snapshot again");
});

test("a file missing from the snapshot comes from the network", async () => {
  const w = worker();
  w.server.deploy("1");
  await w.launch();
  w.server.files["late.js"] = "// late";
  assert.equal(await (await w.get("late.js")).text(), "// late");
});

test("the worker and the version file are left to the browser", async () => {
  const w = worker();
  assert.equal(w.get("sw.js"), undefined);
  assert.equal(w.get("version.json?t=1"), undefined);
});

test("an update reuses unchanged files from the running snapshot", async () => {
  const w = worker();
  w.server.deploy("1", { "style.css": "p {}" });
  await w.launch();
  w.server.deploy("2", { "style.css": "p {}" });
  w.server.requests = [];
  await w.message("check");
  assert.deepEqual(w.server.requests.sort(), ["index.html", "main.js", "version.json"]);
  w.server.down = true;
  await w.launch();
  assert.equal(await (await w.get("style.css")).text(), "p {}");
});
