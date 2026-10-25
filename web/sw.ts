// Every launch runs from a complete local snapshot of one version, without waiting for the network.
// Updates download in the background and run from the next launch on.

declare var registration: ServiceWorkerRegistration;
declare var clients: Clients;
declare function skipWaiting(): Promise<void>;
declare function addEventListener<K extends keyof ServiceWorkerGlobalScopeEventMap>(type: K, listener: (ev: ServiceWorkerGlobalScopeEventMap[K]) => unknown): void;

interface State {
  current: string | null;
  next: string | null;
}

interface Manifest {
  version: string;
  files: Record<string, string>;
}

const SCOPE = self.registration.scope;
const PREFIX = "breezy-snapshot-";
const STATE = "breezy-state";
const VERSION_TIMEOUT_MS = 10_000;
const FILE_TIMEOUT_MS = 30_000;

const url = (path: string) => new URL(path, SCOPE).href;

async function readState(): Promise<State> {
  const res = await (await caches.open(STATE)).match(url("state"));
  return res ? res.json() : { current: null, next: null };
}

async function writeState(state: State) {
  await (await caches.open(STATE)).put(url("state"), new Response(JSON.stringify(state)));
}

// The state is read, changed and written back, so changes take turns.
let turn: Promise<unknown> = Promise.resolve();
function changeState(change: (state: State) => Promise<void>) {
  const done = turn.then(async () => {
    const state = await readState();
    await change(state);
    await writeState(state);
    return state;
  });
  turn = done.catch(() => {});
  return done;
}

let downloading: string | null = null;

async function prune(state: State) {
  const keep = [state.current, state.next, downloading].filter(Boolean).map((v) => PREFIX + v);
  for (const name of await caches.keys()) {
    if (name.startsWith(PREFIX) && !keep.includes(name)) await caches.delete(name);
  }
}

/** As web/sync/plant.ts's, which a worker cannot import. */
const planted = (name: string) =>
  ((globalThis as { __breezyPlant?: string }).__breezyPlant ?? (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.BREEZY_PLANT) === name;

async function hex(buffer: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function download(cache: Cache, version: string, path: string, expected: string, running: { cache: Cache; files: Record<string, string> } | null) {
  const kept = running?.files[path] === expected && (await running.cache.match(url(path)));
  if (kept) return cache.put(url(path), kept);
  // The query gets past the CDN's copy of the last deploy.
  const res = await fetch(url(`${path}?v=${version}`), { cache: "no-store", signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  const body = await res.arrayBuffer();
  // A deploy caught halfway serves files from two versions.
  if ((await hex(body)) !== expected && !planted("half-deploy")) throw new Error(`${path}: not the file of ${version}`);
  await cache.put(url(path), new Response(body, { headers: { "content-type": res.headers.get("content-type") ?? "" } }));
}

async function update() {
  const res = await fetch(url(`version.json?t=${Date.now()}`), { cache: "no-store", signal: AbortSignal.timeout(VERSION_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`version.json: ${res.status}`);
  const manifest: Manifest = await res.json();
  const { version, files } = manifest;
  const state = await readState();
  const have = async (v: string | null) => v === version && (await caches.has(PREFIX + v));
  if ((await have(state.current)) || (await have(state.next))) return;
  // Each snapshot keeps its manifest, so unchanged files are copied rather than downloaded.
  const running = state.current && (await caches.has(PREFIX + state.current)) && (await caches.open(PREFIX + state.current));
  const runningManifest = running && (await running.match(url("version.json")));
  const reuse = runningManifest ? { cache: running as Cache, files: (await runningManifest.json()).files } : null;

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

let checking: Promise<void> | null = null;
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

async function fromSnapshot(version: string | null, path: string) {
  if (!version || !(await caches.has(PREFIX + version))) return undefined;
  return (await caches.open(PREFIX + version)).match(url(path));
}

async function serve(lookup: () => Promise<Response | undefined>, request: Request) {
  let res: Response | undefined;
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
  // the worker, its version file and the sync server are the network's
  if (path === "sw.js" || path === "version.json" || path === "sync.php") return;
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
