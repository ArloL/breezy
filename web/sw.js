// Every launch runs from a complete local snapshot of one version, without waiting for the network.
// Updates download in the background and run from the next launch on.

const SCOPE = self.registration.scope;
const PREFIX = "breezy-snapshot-";
const STATE = "breezy-state";
const VERSION_TIMEOUT_MS = 10_000;
const FILE_TIMEOUT_MS = 30_000;

const url = (path) => new URL(path, SCOPE).href;

async function readState() {
  const res = await (await caches.open(STATE)).match(url("state"));
  return res ? res.json() : { current: null, next: null };
}

async function writeState(state) {
  await (await caches.open(STATE)).put(url("state"), new Response(JSON.stringify(state)));
}

// The state is read, changed and written back, so changes take turns.
let turn = Promise.resolve();
function changeState(change) {
  const done = turn.then(async () => {
    const state = await readState();
    await change(state);
    await writeState(state);
    return state;
  });
  turn = done.catch(() => {});
  return done;
}

let downloading = null;

async function prune(state) {
  const keep = [state.current, state.next, downloading].filter(Boolean).map((v) => PREFIX + v);
  for (const name of await caches.keys()) {
    if (name.startsWith(PREFIX) && !keep.includes(name)) await caches.delete(name);
  }
}

async function hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function download(cache, version, path, expected, running) {
  const kept = running?.files[path] === expected && (await running.cache.match(url(path)));
  if (kept) return cache.put(url(path), kept);
  // The query gets past the CDN's copy of the last deploy.
  const res = await fetch(url(`${path}?v=${version}`), { cache: "no-store", signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  const body = await res.arrayBuffer();
  // A deploy caught halfway serves files from two versions.
  if ((await hex(body)) !== expected) throw new Error(`${path}: not the file of ${version}`);
  await cache.put(url(path), new Response(body, { headers: { "content-type": res.headers.get("content-type") ?? "" } }));
}

async function update() {
  const res = await fetch(url(`version.json?t=${Date.now()}`), { cache: "no-store", signal: AbortSignal.timeout(VERSION_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`version.json: ${res.status}`);
  const manifest = await res.json();
  const { version, files } = manifest;
  const state = await readState();
  const have = async (v) => v === version && (await caches.has(PREFIX + v));
  if ((await have(state.current)) || (await have(state.next))) return;
  // Each snapshot keeps its manifest, so unchanged files are copied rather than downloaded.
  const running = state.current && (await caches.has(PREFIX + state.current)) && (await caches.open(PREFIX + state.current));
  const runningManifest = running && (await running.match(url("version.json")));
  const reuse = runningManifest ? { cache: running, files: (await runningManifest.json()).files } : null;

  const name = PREFIX + version;
  downloading = version;
  try {
    await caches.delete(name);
    const cache = await caches.open(name);
    await Promise.all(Object.entries(files).map(([path, h]) => download(cache, version, path, h, reuse)));
    await cache.put(url("version.json"), new Response(JSON.stringify(manifest)));
    await changeState(async (s) => {
      // with no snapshot running, there is nothing to wait for
      if (s.current && s.current !== version && (await caches.has(PREFIX + s.current))) s.next = version;
      else s.current = version;
    }).then(prune);
  } catch (error) {
    await caches.delete(name);
    throw error;
  } finally {
    downloading = null;
  }
}

let checking = null;
function check() {
  checking ??= update().catch((error) => console.warn("update check failed", error)).finally(() => { checking = null; });
  return checking;
}

/** Switches to the downloaded version, if there is one, and returns the page to launch from it. */
async function launch() {
  const state = await changeState(async (s) => {
    if (s.next && (await caches.has(PREFIX + s.next))) s.current = s.next;
    s.next = null;
  });
  prune(state).catch(() => {});
  return fromSnapshot(state.current, "index.html");
}

async function fromSnapshot(version, path) {
  if (!version || !(await caches.has(PREFIX + version))) return undefined;
  return (await caches.open(PREFIX + version)).match(url(path));
}

async function serve(lookup, request) {
  let res;
  try {
    res = await lookup();
  } catch (error) {
    console.warn("snapshot lookup failed", error);
  }
  return res ?? fetch(request);
}

addEventListener("install", () => skipWaiting());
addEventListener("activate", (event) => event.waitUntil(clients.claim()));

addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || !request.url.startsWith(SCOPE)) return;
  const path = request.url.slice(SCOPE.length).split(/[?#]/)[0];
  if (path === "sw.js" || path === "version.json") return;
  if (request.mode === "navigate") {
    const response = serve(launch, request);
    event.respondWith(response);
    event.waitUntil(response.catch(() => {}).then(check));
  } else {
    event.respondWith(serve(async () => fromSnapshot((await readState()).current, path), request));
  }
});

addEventListener("message", (event) => {
  const reply = async () => {
    if (event.data?.type === "check") await check();
    const { current, next } = await readState();
    event.ports[0]?.postMessage({ current, next });
  };
  event.waitUntil(reply());
});
