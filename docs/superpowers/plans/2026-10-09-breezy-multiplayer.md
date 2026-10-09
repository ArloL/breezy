# Breezy multiplayer — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People in a space see each other's cursors, selections and boards, watch drags and typing as they happen, and hold what they drag or edit until they let go.

**Architecture:** A Cloudflare Worker with one Durable Object per space (`relay/`) relays sealed messages and keeps holds. `sync.php` names the relay in every response. Each space's `SyncEngine` learns the relay and its group gets a `Live` client (`Live.swift`, `web/sync/live.js`) that connects over WebSocket, sends presence, cursors, live fields and `pushed`, and tracks peers, holds and overlays. The apps draw peers over the board and route gestures through holds. Records, merge and the sync protocol do not change.

**Tech Stack:** Cloudflare Workers and Durable Objects (WebSocket hibernation, SQLite-backed storage) with Wrangler 4.149.0; PHP 8; Swift 6 toolchain in Swift 5 mode, swift-testing, CryptoKit, `URLSessionWebSocketTask`, AppKit; plain ES modules with `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-09-breezy-multiplayer-design.md` (extends the sync and spaces designs)

## Cost check (done while writing this plan)

Cloudflare's Durable Objects pricing, read on 2026-10-09: the Workers Free plan allows 100,000 requests a day, 13,000 GB-s of duration a day and 100,000 SQLite rows written a day. Incoming WebSocket messages bill at 20:1 (100 messages count as 5 requests); outgoing messages are free; an object is billed at 128 MB while awake and not while hibernating.

Four people each sending 15 messages a second (cursors at up to 20 a second, live edits, presence) for 3 hours a day send 648,000 messages: 32,400 requests, a third of the free allowance. Awake for those 3 hours, one space uses 10,800 s × 0.125 GB = 1,350 GB-s, a tenth. Writes are one token row per space plus alarms. The spec's rates stand; the Paid plan ($5 a month) would lift every limit if use grows.

## Global Constraints

- Records, merge, the sync protocol and record `format` (1) stay unchanged. `sync.php`'s responses gain `relay` only when `config.php` has a `relay` key holding a `ws://` or `wss://` URL.
- Relay: Worker `breezy-relay`, Durable Object class `Space`, binding `SPACE`, `wss://breezy-relay.blissfulbird.workers.dev/` in production, `ws://127.0.0.1:58568/` under `wrangler dev`. A connection is `<relay>?space=<space id>`.
- Frames and sealed bodies exactly as the spec's tables. Close code 4001 means unauthorized. Frames over 65,536 characters are dropped by the relay and never sent by the apps.
- A body is 12-byte nonce + AES-GCM ciphertext + tag, with the space key; additional data is the 4 bytes `live` followed by the 16-byte space id.
- Timings: cursors and live fields at most every 50 ms; presence every 15 s; a peer is gone after 30 s without a message; a cursor fades after 60 s still; a phone's cursor hides 3 s after the finger lifts; a holder sends `live` at least every 5 s; a hold lapses after 10 s without a message; `auth` within 5 s; reconnect after 1 s doubling to 30 s; while connected, polling every 30 s instead of 5 s.
- Live fields: `pos`, `size`, `w`, `text`, `notes`, `color`, and `title` for a lane renamed live; an item new during the gesture also sends `kind` and all of these.
- Palette, in order: `#e5484d`, `#f76b15`, `#12a594`, `#8e4ec6`, `#3e63dd`, `#e93d82`, `#ad7f58`, `#00a2c7`. A device's colour is entry `first byte of its id % 8`.
- Fixed strings: `Your Name` (web ⋯ menu and sheet title), `Your Name…` (Mac Breezy menu), "Others in your spaces see it beside your cursor." (prompt message), `Name` (placeholder).
- Mac `UserDefaults`: `BreezyDevice`, `BreezyName`. Web IndexedDB key `me`: `{device, name}`.
- BreezyKit depends on Apple frameworks only. The web app takes no dependency and has no build step. The relay's only dependency is `wrangler` 4.149.0, as a dev dependency.
- Match the surrounding code: two-space indents, doc comments on types and non-obvious functions, few other comments. Commit messages are one imperative line, ending with the `Claude-Session:` trailer the session supplies.

## Review Focus

1. **The network changes mid-drag** (Wi-Fi to mobile data). The relay drops the hold with the socket; on reconnecting the device must ask for it again, and cancel the drag if someone else took the card meanwhile. Pinned by `aReconnectAsksForItsHoldsAgain` (Task 5) and `a reconnect asks for its holds again` (Task 6).
2. **A holder that crashes or goes silent.** Its holds lapse after 10 s and every receiver must drop its overlay then, not keep a ghost card. Pinned by the relay's lapse test (Task 1) and `aHoldThatEndsWithoutAPushDropsTheOverlay` (Task 5) and its twin (Task 6).
3. **The same person in two windows or two tabs.** "Who's here" shows them once, but a card held in one window must still be held for the other. Pinned by `anotherConnectionOfTheSameDeviceStillHolds` (Task 5) and its twin (Task 6).
4. **A pushed version that is not pulled yet**, or a sync that fails after a gesture. The overlay must stay until the pull reaches the version, so the card does not jump back. Pinned by `theOverlayStaysUntilThePullReachesThePushedVersion` (Task 5) and its twin (Task 6).
5. **A server without a relay** (an old `sync.php`, or no `relay` in its config). No live layer, and polling stays at 5 s. Pinned by `withoutARelayThereIsNoLiveLayer` (Task 7) and its twin (Task 8).

---

## File map

| File | Change |
|---|---|
| `relay/package.json`, `relay/wrangler.jsonc`, `relay/.gitignore`, `relay/test.sh` | new: the relay project |
| `relay/src/holds.js`, `relay/src/worker.js` | new: hold rules; Worker and `Space` Durable Object |
| `relay/test/holds.test.mjs`, `relay/test/relay.test.mjs` | new |
| `.github/workflows/main.yaml` | web job runs the hold rules' tests |
| `server/sync.php`, `server/config.example.php`, `server/dev.sh`, `scripts/deploy.py` | `relay` in responses and config |
| `server/test/relay.test.mjs` | new |
| `BreezyKit/Tests/Fixtures/live.json` | new: live-message vector |
| `BreezyKit/Sources/BreezyKit/JSONValue.swift` | `object`, `bool` |
| `BreezyKit/Sources/BreezyKit/SpaceKeys.swift` | `sealLive`, `openLive` |
| `BreezyKit/Sources/BreezyKit/Sync.swift` | `relay` in `Page`/`PushResult`; engine `relay`, `onRelay`, `onPushed`, `onPulled`, `lastSynced` |
| `BreezyKit/Sources/BreezyKit/Overlay.swift` | new: `LiveFields`, `Records.liveFields`, `Board.overlaid` |
| `BreezyKit/Sources/BreezyKit/BoardModel.swift`, `BoardBinding.swift` | `cancel`, `gestureStartBoard`; `taken`, `afterEdit`, `afterGesture` |
| `BreezyKit/Sources/BreezyKit/Live.swift` | new: `Person`, `Peer`, `Cursor`, `Caret`, `LiveSocket`, `WebSocketTaskSocket`, `Live` |
| `BreezyKit/Sources/BreezyKit/Spaces.swift` | `me`, `Group.live`, `onLive`, `syncAll(polling:)` |
| `BreezyKit/Tests/BreezyKitTests/*` | `CryptoTests`, `SyncTests`, `OverlayTests` (new), `BoardBindingTests`, `LiveTests` (new), `LiveFakes` (new), `SpacesTests`, `SyncFakes` |
| `web/sync/crypto.js`, `web/sync/engine.js`, `web/sync/overlay.js` (new), `web/model.js`, `web/binding.js` | as the Swift twins |
| `web/sync/live.js` | new |
| `web/sync/spaces.js` | `me`, `setName`, `group.live`, `onLive`, `syncAll({ polling })` |
| `web/test/*` | `crypto`, `engine`, `overlay` (new), `binding`, `live` (new), `spaces`; `helpers/fake-relay.js` (new), `helpers/fake-server.js` |
| `web/index.html`, `web/style.css`, `web/presence.js` (new), `web/view.js`, `web/app.js`, `web/input.js`, `web/mouse.js`, `web/main.js`, `web/ui.js`, `web/library.js` | presence, holds and live edits on the web |
| `Breezy/Canvas/PresenceView.swift` (new), `CanvasView.swift`, `CanvasView+Pointer.swift`, `CanvasView+Editing.swift`, `CardLayer.swift`, `LaneView.swift` | presence, holds and live edits on the Mac |
| `Breezy/Style/Typography.swift` | `TextMetrics.caret` |
| `Breezy/Library/Library.swift`, `BoardsWindowController.swift`, `Breezy/Window/BoardWindowController.swift`, `Breezy/App/AppDelegate.swift`, `MainMenu.swift` | names, connections, who's here |
| `README.md` | Sync section: the relay |

---

### Task 1: The relay

**Files:**
- Create: `relay/package.json`, `relay/wrangler.jsonc`, `relay/.gitignore`, `relay/test.sh`
- Create: `relay/src/holds.js`, `relay/src/worker.js`
- Test: `relay/test/holds.test.mjs`, `relay/test/relay.test.mjs`
- Modify: `.github/workflows/main.yaml` (web job)

**Interfaces:**
- Produces: the relay protocol of the spec's Messages table at `<relay>?space=<id>`. `relay/src/holds.js` exports `HOLD_TIMEOUT_MS` (10,000), `AUTH_TIMEOUT_MS` (5,000), `MAX_MESSAGE` (65,536), `conflicts(conns, id, ids)`, `holdsOf(conns)`, `lapsed(conns, now)`, `unauthenticated(conns, now)`, `validIDs(ids)`, where a conn is `{ id, authed, opened, last, holds: string[] }`. Task 6's fake relay imports these.

- [ ] **Step 1: Make the project**

`relay/package.json`:

```json
{
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev --port 58568",
    "deploy": "wrangler deploy"
  },
  "devDependencies": { "wrangler": "4.149.0" }
}
```

`relay/wrangler.jsonc`:

```jsonc
// The live layer's relay; see docs/superpowers/specs/2026-10-09-breezy-multiplayer-design.md.
{
  "name": "breezy-relay",
  "main": "src/worker.js",
  "compatibility_date": "2026-10-01",
  "durable_objects": { "bindings": [{ "name": "SPACE", "class_name": "Space" }] },
  // the Free plan has SQLite-backed Durable Objects only
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Space"] }]
}
```

`relay/.gitignore`:

```
node_modules/
.wrangler/
```

Run: `npm install --prefix relay`, which writes `relay/package-lock.json` (commit it).

- [ ] **Step 2: Write the failing tests for the hold rules**

`relay/test/holds.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { conflicts, holdsOf, lapsed, unauthenticated, validIDs, HOLD_TIMEOUT_MS, AUTH_TIMEOUT_MS } from "../src/holds.js";

const id = (n) => String(n).padStart(22, "A");
const conns = [
  { id: "a", authed: true, opened: 0, last: 0, holds: [id(1), id(2)] },
  { id: "b", authed: true, opened: 0, last: 0, holds: [] },
];

test("an id someone else holds conflicts; one's own do not", () => {
  assert.deepEqual(conflicts(conns, "b", [id(2), id(3)]), [id(2)]);
  assert.deepEqual(conflicts(conns, "a", [id(1)]), []);
});

test("holds list only the connections holding something", () => {
  assert.deepEqual(holdsOf(conns), { a: [id(1), id(2)] });
});

test("holds lapse after the timeout without a message", () => {
  assert.deepEqual(lapsed(conns, HOLD_TIMEOUT_MS), []);
  assert.deepEqual(lapsed(conns, HOLD_TIMEOUT_MS + 1).map((c) => c.id), ["a"]);
});

test("a connection must authenticate in time", () => {
  const all = [{ id: "x", authed: false, opened: 0, last: 0, holds: [] }, ...conns];
  assert.deepEqual(unauthenticated(all, AUTH_TIMEOUT_MS), []);
  assert.deepEqual(unauthenticated(all, AUTH_TIMEOUT_MS + 1).map((c) => c.id), ["x"]);
});

test("ids are 22 base64url characters", () => {
  assert.ok(validIDs([id(1), "AbC-_0123456789abcdefg"]));
  assert.ok(!validIDs(["short"]));
  assert.ok(!validIDs("x"));
  assert.ok(!validIDs([1]));
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `node --test relay/test/holds.test.mjs`
Expected: FAIL with `Cannot find module '…/relay/src/holds.js'`.

- [ ] **Step 4: Write the hold rules**

`relay/src/holds.js`:

```js
// Who holds what in a space, and who has to go; plain functions, so that they test without Cloudflare. A connection is
// { id, authed, opened, last, holds }, times in ms.

export const HOLD_TIMEOUT_MS = 10_000;
export const AUTH_TIMEOUT_MS = 5_000;
export const MAX_MESSAGE = 65_536;

/** Of `ids`, those a connection other than `id` holds. */
export function conflicts(conns, id, ids) {
  const taken = new Set(conns.filter((c) => c.id !== id).flatMap((c) => c.holds));
  return ids.filter((x) => taken.has(x));
}

/** `{connection id: ids}` for every connection holding something. */
export function holdsOf(conns) {
  return Object.fromEntries(conns.filter((c) => c.holds.length).map((c) => [c.id, c.holds]));
}

/** Connections whose holds lapse at `now`: silent for longer than the timeout. */
export const lapsed = (conns, now) => conns.filter((c) => c.holds.length && now - c.last > HOLD_TIMEOUT_MS);

/** Connections that have not authenticated in time. */
export const unauthenticated = (conns, now) => conns.filter((c) => !c.authed && now - c.opened > AUTH_TIMEOUT_MS);

export const validIDs = (ids) =>
  Array.isArray(ids) && ids.length <= 1000 && ids.every((x) => typeof x === "string" && /^[A-Za-z0-9_-]{22}$/.test(x));
```

- [ ] **Step 5: Run them to see them pass**

Run: `node --test relay/test/holds.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 6: Write the relay's integration tests**

`relay/test/relay.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

// relay/test.sh runs these against wrangler dev
const RELAY = process.env.BREEZY_RELAY;
const rand = (n) => randomBytes(n).toString("base64url");
const type = (t) => (m) => m.t === t;

/** A connection to `space`, authenticated with `token` unless `auth` is false. */
async function connect(space, token, { auth = true } = {}) {
  const url = new URL(RELAY);
  url.searchParams.set("space", space);
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  let closed = null;
  const wake = () => waiters.splice(0).forEach((w) => w());
  ws.onmessage = (e) => {
    inbox.push(JSON.parse(e.data));
    wake();
  };
  ws.onclose = (e) => {
    closed = e.code;
    wake();
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const wait = (ms) => new Promise((r) => {
    waiters.push(r);
    setTimeout(r, ms);
  });
  const c = {
    ws,
    send: (m) => ws.send(typeof m === "string" ? m : JSON.stringify(m)),
    /** The first message matching `match` within `ms`, taken from the inbox; null if none came. */
    async next(match = () => true, ms = 3000) {
      const end = Date.now() + ms;
      for (;;) {
        const i = inbox.findIndex(match);
        if (i >= 0) return inbox.splice(i, 1)[0];
        if (closed !== null || Date.now() >= end) return null;
        await wait(end - Date.now());
      }
    },
    async closedWith(ms = 8000) {
      const end = Date.now() + ms;
      while (closed === null && Date.now() < end) await wait(100);
      return closed;
    },
  };
  if (auth) {
    c.send({ t: "auth", token });
    c.welcome = await c.next(type("welcome"));
  }
  return c;
}

test("the first connection sets the token; later ones must match it", async () => {
  const space = rand(16), token = rand(32);
  const a = await connect(space, token);
  assert.deepEqual(a.welcome.peers, []);
  assert.deepEqual(a.welcome.holds, {});
  const b = await connect(space, token);
  assert.deepEqual(b.welcome.peers, [a.welcome.id]);
  assert.deepEqual(await a.next(type("join")), { t: "join", id: b.welcome.id });
  const c = await connect(space, token, { auth: false });
  c.send({ t: "auth", token: rand(32) });
  assert.equal(await c.closedWith(), 4001);
});

test("anything before auth closes the socket", async () => {
  const c = await connect(rand(16), rand(32), { auth: false });
  c.send({ body: "x" });
  assert.equal(await c.closedWith(), 4001);
});

test("a socket that never authenticates is closed", { timeout: 20_000 }, async () => {
  const c = await connect(rand(16), rand(32), { auth: false });
  assert.equal(await c.closedWith(15_000), 4001);
});

test("bodies go to everyone else, or to one", async () => {
  const space = rand(16), token = rand(32);
  const a = await connect(space, token), b = await connect(space, token), c = await connect(space, token);
  a.send({ body: "all" });
  assert.deepEqual(await b.next((m) => m.body === "all"), { from: a.welcome.id, body: "all" });
  assert.ok(await c.next((m) => m.body === "all"));
  a.send({ to: c.welcome.id, body: "one" });
  assert.ok(await c.next((m) => m.body === "one"));
  assert.equal(await b.next((m) => m.body === "one", 500), null);
  assert.equal(await a.next((m) => "body" in m, 300), null);
});

test("holds are all or none, and end with release or a close", async () => {
  const space = rand(16), token = rand(32);
  const a = await connect(space, token), b = await connect(space, token);
  const [x, y, z] = [rand(16), rand(16), rand(16)];
  a.send({ t: "hold", ids: [x, y] });
  assert.deepEqual((await b.next(type("holds"))).holds, { [a.welcome.id]: [x, y] });
  b.send({ t: "hold", ids: [y, z] });
  assert.deepEqual(await b.next(type("refused")), { t: "refused", ids: [y] });
  a.send({ t: "release" });
  assert.deepEqual((await b.next((m) => m.t === "holds" && !Object.keys(m.holds).length)).holds, {});
  b.send({ t: "hold", ids: [y, z] });
  assert.deepEqual((await a.next((m) => m.t === "holds" && m.holds[b.welcome.id])).holds, { [b.welcome.id]: [y, z] });
  const c = await connect(space, token);
  assert.deepEqual(c.welcome.holds, { [b.welcome.id]: [y, z] });
  b.ws.close();
  assert.deepEqual(await a.next(type("leave")), { t: "leave", id: b.welcome.id });
  assert.deepEqual((await a.next((m) => m.t === "holds" && !Object.keys(m.holds).length)).holds, {});
});

test("frames over 64 KB are dropped", async () => {
  const space = rand(16), token = rand(32);
  const a = await connect(space, token), b = await connect(space, token);
  a.send({ body: "x".repeat(70_000) });
  assert.equal(await b.next((m) => "body" in m, 800), null);
});

test("holds lapse after 10 s without a message", { timeout: 30_000 }, async () => {
  const space = rand(16), token = rand(32);
  const a = await connect(space, token), b = await connect(space, token);
  a.send({ t: "hold", ids: [rand(16)] });
  assert.ok(await b.next((m) => m.t === "holds" && m.holds[a.welcome.id]));
  const lapsed = await b.next((m) => m.t === "holds" && !Object.keys(m.holds).length, 20_000);
  assert.deepEqual(lapsed?.holds, {});
});
```

`relay/test.sh` (make it executable with `chmod +x relay/test.sh`):

```zsh
#!/bin/zsh
# Runs the hold rules' tests, then the relay under wrangler dev with test/relay.test.mjs against it: relay/test.sh
set -e
cd ${0:A:h}
npm install --silent
node --test test/holds.test.mjs
dir=$(mktemp -d)
npx wrangler dev --port 58568 --persist-to $dir >$dir/dev.log 2>&1 &
trap 'pkill -f "wrangler dev --port 58568"; rm -rf $dir' EXIT
for i in {1..120}; do curl --silent --output /dev/null http://127.0.0.1:58568/ && break; sleep 0.5; done
BREEZY_RELAY=ws://127.0.0.1:58568/ node --test test/relay.test.mjs || { cat $dir/dev.log; exit 1 }
```

- [ ] **Step 7: Run them to see them fail**

Run: `relay/test.sh`
Expected: the hold tests pass, then wrangler fails to start with a message naming `src/worker.js`, and the script exits non-zero.

- [ ] **Step 8: Write the Worker and the Durable Object**

`relay/src/worker.js`:

```js
// The live layer's relay: one Durable Object per space forwards sealed messages between that space's connections and
// keeps who holds what. It stores the space token's hash and nothing else; see the multiplayer design.
import { DurableObject } from "cloudflare:workers";
import { conflicts, holdsOf, lapsed, unauthenticated, validIDs, MAX_MESSAGE } from "./holds.js";

const SPACE = /^[A-Za-z0-9_-]{22}$/;
const TICK_MS = 5_000;

const fromB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const toB64 = (u) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** SHA-256 of the token's 32 bytes, as sync.php keeps it; null for anything else. */
async function digest(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return toB64(new Uint8Array(await crypto.subtle.digest("SHA-256", fromB64(token))));
}

function send(ws, text) {
  try {
    ws.send(text);
  } catch {}
}

export class Space extends DurableObject {
  async fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const now = Date.now();
    server.serializeAttachment({ id: crypto.randomUUID(), authed: false, opened: now, last: now, holds: [] });
    await this.wake();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Every socket with its connection, which survives hibernation as the socket's attachment. */
  conns() {
    return this.ctx.getWebSockets().map((ws) => ({ ws, ...ws.deserializeAttachment() }));
  }

  async webSocketMessage(ws, message) {
    if ((typeof message === "string" ? message.length : message.byteLength) > MAX_MESSAGE) return;
    let m;
    try {
      m = JSON.parse(message);
    } catch {
      return;
    }
    const me = ws.deserializeAttachment();
    me.last = Date.now();
    if (!me.authed) {
      if (m?.t !== "auth" || !(await this.authorised(m.token))) return ws.close(4001, "unauthorized");
      me.authed = true;
      ws.serializeAttachment(me);
      const others = this.conns().filter((c) => c.authed && c.id !== me.id);
      send(ws, JSON.stringify({ t: "welcome", id: me.id, peers: others.map((c) => c.id), holds: holdsOf(others) }));
      for (const c of others) send(c.ws, JSON.stringify({ t: "join", id: me.id }));
      return;
    }
    if (m?.t === "hold" && validIDs(m.ids)) {
      const refused = conflicts(this.conns().filter((c) => c.authed), me.id, m.ids);
      if (!refused.length) me.holds = [...new Set([...me.holds, ...m.ids])];
      ws.serializeAttachment(me);
      if (refused.length) return send(ws, JSON.stringify({ t: "refused", ids: refused }));
      await this.wake();
      return this.announce();
    }
    if (m?.t === "release") {
      const had = me.holds.length;
      me.holds = [];
      ws.serializeAttachment(me);
      if (had) this.announce();
      return;
    }
    ws.serializeAttachment(me);
    if (typeof m?.body !== "string") return;
    const out = JSON.stringify({ from: me.id, body: m.body });
    for (const c of this.conns()) if (c.authed && c.id !== me.id && (!m.to || c.id === m.to)) send(c.ws, out);
  }

  async webSocketClose(ws) {
    this.leave(ws);
  }

  async webSocketError(ws) {
    this.leave(ws);
  }

  leave(ws) {
    const me = ws.deserializeAttachment();
    try {
      ws.close(1000);
    } catch {}
    if (!me?.authed) return;
    for (const c of this.conns()) if (c.ws !== ws && c.authed) send(c.ws, JSON.stringify({ t: "leave", id: me.id }));
    if (me.holds.length) this.announce(ws);
  }

  /** Tells every connection who holds what, leaving out `closing`. */
  announce(closing) {
    const live = this.conns().filter((c) => c.authed && c.ws !== closing);
    const text = JSON.stringify({ t: "holds", holds: holdsOf(live) });
    for (const c of live) send(c.ws, text);
  }

  /** The first token sets the space's; later ones must match. */
  async authorised(token) {
    const hash = await digest(token);
    if (!hash) return false;
    const stored = await this.ctx.storage.get("token");
    if (stored === undefined) {
      await this.ctx.storage.put("token", hash);
      return true;
    }
    return stored === hash;
  }

  /** An alarm soon, if none is set, to close silent sockets and lapse silent holds. */
  async wake() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  async alarm() {
    const now = Date.now();
    const conns = this.conns();
    for (const c of unauthenticated(conns, now)) {
      try {
        c.ws.close(4001, "unauthorized");
      } catch {}
    }
    const gone = lapsed(conns.filter((c) => c.authed), now);
    for (const c of gone) c.ws.serializeAttachment({ ...c.ws.deserializeAttachment(), holds: [] });
    if (gone.length) this.announce();
    if (this.conns().some((c) => !c.authed || c.holds.length)) await this.ctx.storage.setAlarm(now + TICK_MS);
  }
}

export default {
  async fetch(request, env) {
    const space = new URL(request.url).searchParams.get("space") ?? "";
    if (!SPACE.test(space)) return new Response("space", { status: 400 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("websocket only", { status: 426 });
    return env.SPACE.get(env.SPACE.idFromName(space)).fetch(request);
  },
};
```

- [ ] **Step 9: Run the tests to see them pass**

Run: `relay/test.sh`
Expected: PASS, 5 hold tests and 7 relay tests (the lapse and auth-timeout tests take up to 15 s each).

- [ ] **Step 10: Run the hold rules' tests in CI**

In `.github/workflows/main.yaml`, in the `web` job after the step `Test the touch prototype`, add:

```yaml
    - name: Test the relay's hold rules
      run: node --test relay/test/holds.test.mjs
```

- [ ] **Step 11: Commit**

```bash
git add relay .github/workflows/main.yaml
git commit -m "Add the live layer's relay: a Durable Object per space with holds"
```

---

### Task 2: The server names the relay

**Files:**
- Modify: `server/sync.php`, `server/config.example.php`, `server/dev.sh`, `scripts/deploy.py`
- Test: `server/test/relay.test.mjs`

**Interfaces:**
- Produces: `relay` (string) in every GET and POST response body when `config.php` returns a `relay` key with a `ws://` or `wss://` URL; absent otherwise.

- [ ] **Step 1: Write the failing test**

`server/test/relay.test.mjs` (`server/test.sh` runs every `test/*.test.mjs`):

```js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// sync.php on a server of its own whose config names a relay; the other tests run without one
const here = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "breezy-relay-"));
const db = join(dir, "test.db");
execFileSync("php", ["-r", '$db = new PDO("sqlite:" . $argv[1]); $db->exec(file_get_contents($argv[2]));', db, join(here, "schema.sql")]);
writeFileSync(join(dir, "config.php"), `<?php return ['dsn' => 'sqlite:${db}', 'relay' => 'wss://relay.example/'];`);
const php = spawn("php", ["-S", "127.0.0.1:58567", "-t", here], { env: { ...process.env, BREEZY_CONFIG: join(dir, "config.php") }, stdio: "ignore" });
after(() => {
  php.kill();
  rmSync(dir, { recursive: true, force: true });
});

const rand = (n) => randomBytes(n).toString("base64url");

async function call(method, space, token, body) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:58567/sync.php?space=${space}&since=0`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body && JSON.stringify(body),
      });
      return await res.json();
    } catch (error) {
      if (i > 50) throw error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

test("responses name the relay when the config does", async () => {
  const space = rand(16), token = rand(32);
  assert.equal((await call("GET", space, token)).relay, "wss://relay.example/");
  const pushed = await call("POST", space, token, { writes: [{ id: rand(16), base: 0, blob: rand(40) }] });
  assert.equal(pushed.relay, "wss://relay.example/");
  assert.equal(pushed.accepted.length, 1);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `server/test.sh`
Expected: FAIL in `responses name the relay when the config does`: `undefined !== 'wss://relay.example/'`. The other server tests pass.

- [ ] **Step 3: Name the relay in `sync.php`**

After `function query(...) {…}` add:

```php
/** `body` with the relay's address, when the config names one. */
function named(array $body): array {
  global $relay;
  return $relay === null ? $body : $body + ['relay' => $relay];
}
```

After the line `$config = require (getenv('BREEZY_CONFIG') ?: __DIR__ . '/config.php');` add:

```php
$relay = is_string($config['relay'] ?? null) && preg_match('#^wss?://#', $config['relay']) ? $config['relay'] : null;
```

Change the GET reply to:

```php
  reply(200, named(['records' => $records, 'cursor' => $cursor, 'epoch' => $row ? b64e($row['epoch']) : null]));
```

and the last line to:

```php
reply(200, named(['accepted' => $accepted, 'refused' => $refused, 'epoch' => b64e($epoch)]));
```

Add to the file's header comment, after its first sentence: `Responses name the live layer's relay when config.php does.`

- [ ] **Step 4: Run the tests to see them pass**

Run: `server/test.sh`
Expected: PASS, every server test, then `HTTPTransportTests` (`Page` ignores the unknown key until Task 3).

- [ ] **Step 5: Configure the relay in deployment and development**

`server/config.example.php`:

```php
<?php
// Copy to config.php, which git ignores, and fill in the database. `relay` is the live layer's relay; leave it out for none.
return ['dsn' => 'mysql:host=localhost;dbname=breezy;charset=utf8mb4', 'user' => 'breezy', 'password' => '', 'relay' => 'wss://breezy-relay.example.workers.dev/'];
```

In `scripts/deploy.py`, after the `SITE_URL = …` line add:

```python
RELAY = os.environ.get("BREEZY_RELAY", "wss://breezy-relay.blissfulbird.workers.dev/")
```

and in `config_php()` change the dict to:

```python
    details = json.dumps({"dsn": DSN, "user": os.environ["BREEZY_DATABASE_USER"],
                          "password": os.environ["BREEZY_DATABASE_PASSWORD"], "relay": RELAY})
```

In `server/dev.sh`, replace the `print -r -- …` line with:

```zsh
# the relay npm --prefix relay run dev serves; BREEZY_DEV_RELAY= leaves it out
relay=${BREEZY_DEV_RELAY-ws://127.0.0.1:58568/}
print -r -- "<?php return ['dsn' => 'sqlite:$db'${relay:+, 'relay' => '$relay'}];" > $root/build/sync-dev-config.php
```

- [ ] **Step 6: Commit**

```bash
git add server scripts/deploy.py
git commit -m "Name the live layer's relay in sync.php's responses"
```

---

### Task 3: Live sealing, the engine's relay, overlays and holds in BreezyKit

**Files:**
- Create: `BreezyKit/Tests/Fixtures/live.json`
- Create: `BreezyKit/Sources/BreezyKit/Overlay.swift`
- Modify: `BreezyKit/Sources/BreezyKit/JSONValue.swift`, `SpaceKeys.swift`, `Sync.swift`, `BoardModel.swift`, `BoardBinding.swift`
- Test: `BreezyKit/Tests/BreezyKitTests/CryptoTests.swift`, `SyncTests.swift`, `SyncFakes.swift`, `OverlayTests.swift` (new), `BoardBindingTests.swift`, `BoardModelTests.swift`

**Interfaces:**
- Produces:
  - `JSONValue.object: [String: JSONValue]?`, `JSONValue.bool: Bool?`
  - `SpaceKeys.sealLive(_ plaintext: Data, nonce: AES.GCM.Nonce = AES.GCM.Nonce()) throws -> Data`, `SpaceKeys.openLive(_ body: Data) throws -> Data`
  - `Page.relay: String?`, `PushResult.relay: String?`
  - `SyncEngine.relay: String?` (read-only), `onRelay: ((String?) -> Void)?`, `onPushed: ((Int) -> Void)?` (highest accepted version), `onPulled: ((Int) -> Void)?` (store cursor after a pull), `lastSynced: Date?`
  - `public typealias LiveFields = [String: JSONValue]`; `Records.liveFieldNames: Set<String>`; `Records.liveFields(from: Board, to: Board, ids: Set<String>, board: String) -> [String: LiveFields]`; `Board.overlaid(_ overlay: [String: LiveFields]) -> Board`
  - `BoardModel.cancel()`, `BoardModel.gestureStartBoard: Board?`
  - `BoardBinding.taken: () -> Set<String>` (default empty), `afterEdit: (() -> Void)?`, `afterGesture: (() -> Void)?`

- [ ] **Step 1: Add the shared fixture**

`BreezyKit/Tests/Fixtures/live.json` (the space and secret of `crypto.json`; the body is the plaintext sealed with the nonce):

```json
{
  "secret": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  "space": "QEFCQ0RFRkdISUpLTE1OTw",
  "nonce": "gIGCg4SFhoeIiYqL",
  "plaintext": "{\"board\":\"YGFiY2RlZmdoaWprbG1ubw\",\"t\":\"cursor\",\"x\":120,\"y\":-48}",
  "body": "gIGCg4SFhoeIiYqLCD5JiEQgnZvGpv6SLgfViV8k0FR262YQLdRVkGnCqFr0Xmgun8p_xZYc7WCCD2HQmYd7nEWzCLTkapN_cU2B_JkX47hB8v94xbVl6TCneg"
}
```

- [ ] **Step 2: Write the failing tests**

In `CryptoTests.swift` add:

```swift
private struct LiveVector: Decodable { var secret, space, nonce, plaintext, body: String }

@Test func liveMessagesMatchTheSharedVector() throws {
  let v = try JSONDecoder().decode(LiveVector.self, from: fixture("live.json"))
  let keys = SpaceKeys(space: Base64URL.decode(v.space)!, secret: Base64URL.decode(v.secret)!)
  let sealed = try keys.sealLive(Data(v.plaintext.utf8), nonce: AES.GCM.Nonce(data: Base64URL.decode(v.nonce)!))
  #expect(Base64URL.encode(sealed) == v.body)
  #expect(try keys.openLive(Base64URL.decode(v.body)!) == Data(v.plaintext.utf8))
}

@Test func liveMessagesAndRecordsNeverPassForEachOther() throws {
  let keys = SpaceKeys(space: randomBytes(16), secret: randomBytes(32))
  let body = try keys.sealLive(Data("x".utf8))
  #expect(throws: (any Error).self) { try keys.open(body, id: Data("live".utf8)) }
  let blob = try keys.seal(Data("x".utf8), id: randomBytes(16))
  #expect(throws: (any Error).self) { try keys.openLive(blob) }
  let other = SpaceKeys(space: randomBytes(16), secret: randomBytes(32))
  #expect(throws: (any Error).self) { try other.openLive(body) }
}
```

In `SyncFakes.swift`, give `FakeServer` a relay and pass it on:

```swift
  /// What the server names as its relay, if anything.
  var relay: String?
```

and in `pull` return `Page(records: r.map(marked), cursor: r.last?.version ?? since, epoch: epoch, relay: relay)`, in `push` return `PushResult(accepted: accepted, refused: refused, epoch: epoch, relay: relay)`.

In `SyncTests.swift` add:

```swift
@MainActor @Test func theEngineLearnsTheRelayAndReportsPushesAndPulls() async {
  let (server, a, b, id) = await pair()
  var relays: [String?] = [], pushed: [Int] = [], pulled: [Int] = []
  a.engine.onRelay = { relays.append($0) }
  a.engine.onPushed = { pushed.append($0) }
  a.engine.onPulled = { pulled.append($0) }
  server.relay = "wss://relay.example/"
  let c = a.store.board(id).cards[0].id
  a.edit(id) { $0.setColor([c], 2) }
  await a.engine.sync()
  #expect(a.engine.relay == "wss://relay.example/")
  #expect(relays == ["wss://relay.example/"])
  #expect(pushed == [server.version])
  #expect(pulled == [server.version - 1])
  #expect(a.engine.lastSynced != nil)
  server.relay = "http://not-a-relay"
  await b.engine.sync()
  #expect(b.engine.relay == nil)
}
```

New `OverlayTests.swift`:

```swift
import Foundation
import Testing
@testable import BreezyKit

@Test func liveFieldsAreWhatAGestureChangedOfItsItems() {
  let start = board([card("a", 0, 0, "x"), card("b", 0, 96)], [lane("l", 0, 0)])
  var now = start
  now.cards[0].x = 48
  now.cards[0].text = "typed"
  now.cards[1].x = 480
  now.lanes[0].w = 720
  now.cards.append(card("n", 24, 24, "new"))
  let f = Records.liveFields(from: start, to: now, ids: ["a", "l", "n"], board: "B")
  #expect(f["a"] == ["pos": .array([.number(48), .number(0)]), "text": .string("typed")])
  #expect(f["b"] == nil)
  #expect(f["l"] == ["size": .array([.number(720), .number(720)])])
  #expect(f["n"]?["kind"] == .string("card"))
  #expect(f["n"]?["text"] == .string("new"))
  #expect(f["n"]?["order"] == nil)
}

@Test func anOverlayIsDrawnOverTheBoard() {
  let b = board([card("a", 0, 0, "x")], [lane("l", 0, 0)])
  let shown = b.overlaid([
    "a": ["pos": .array([.number(48), .number(24)]), "text": .string("typed"), "notes": .string(""), "color": .number(3)],
    "l": ["pos": .array([.number(10), .number(20)]), "size": .array([.number(500), .number(600)]), "title": .string("Now")],
    "n": ["kind": .string("card"), "pos": .array([.number(1), .number(2)]), "w": .number(240), "text": .string("new"),
          "notes": .string(""), "color": .number(1)],
    "gone": ["pos": .array([.number(1), .number(2)])],
  ])
  #expect(shown.card("a") == Card(id: "a", x: 48, y: 24, text: "typed", color: 3))
  #expect(shown.lane("l") == Lane(id: "l", x: 10, y: 20, w: 500, h: 600, title: "Now"))
  #expect(shown.card("n")?.text == "new")
  #expect(shown.cards.count == 2 && shown.lanes.count == 1)
  #expect(b.overlaid([:]) == b)
}
```

In `BoardModelTests.swift` add:

```swift
@Test func cancelPutsTheBoardBackAsTheGestureBegan() {
  let m = BoardModel(board: board([card("a", 0, 0)]))
  var ended = 0
  m.onGestureEnd = { ended += 1 }
  m.begin()
  #expect(m.gestureStartBoard == m.board)
  m.update { $0.setText("a", "typed") }
  m.cancel()
  #expect(m.board.card("a")?.text == "t")
  #expect(!m.inGesture && m.gestureStartBoard == nil)
  #expect(ended == 1)
  #expect(!m.undoManager.canUndo)
}
```

In `BoardBindingTests.swift` add:

```swift
@MainActor @Test func changesToItemsOthersHoldAreNotWritten() {
  let (store, id, model, binding) = opened(board([card("a", 0, 0), card("b", 0, 96)]))
  binding.taken = { ["b"] }
  model.perform("Move") {
    $0.cards[0].x = 48
    $0.cards[1].x = 480
  }
  binding.flush()
  #expect(store.board(id).card("a")?.x == 48)
  #expect(store.board(id).card("b")?.x == 0)
}

@MainActor @Test func theBindingTellsOfEditsAndOfGestureEnds() async throws {
  let (_, _, model, binding) = opened(board([card("a", 0, 0)]))
  var edits = 0, ends = 0
  binding.afterEdit = { edits += 1 }
  binding.afterGesture = { ends += 1 }
  model.begin()
  model.update { $0.setText("a", "y") }
  model.end("Edit Card")
  try await Task.sleep(for: .milliseconds(50))
  #expect(edits == 1)
  #expect(ends == 1)
}
```

- [ ] **Step 3: Run them to see them fail**

Run: `swift test --package-path BreezyKit`
Expected: build errors naming `sealLive`, `relay`, `liveFields`, `overlaid`, `cancel`, `taken`.

- [ ] **Step 4: Add the accessors and live sealing**

In `JSONValue.swift`, after `array`:

```swift
  public var object: [String: JSONValue]? { if case .object(let o) = self { o } else { nil } }
  public var bool: Bool? { if case .bool(let b) = self { b } else { nil } }
```

In `SpaceKeys.swift`, inside `struct SpaceKeys` after `open`:

```swift
  /// A live message's body: bound to the space, and marked live so that it never passes for a record.
  public func sealLive(_ plaintext: Data, nonce: AES.GCM.Nonce = AES.GCM.Nonce()) throws -> Data {
    try AES.GCM.seal(plaintext, using: key, nonce: nonce, authenticating: Data("live".utf8) + space).combined!
  }

  public func openLive(_ body: Data) throws -> Data {
    try AES.GCM.open(AES.GCM.SealedBox(combined: body), using: key, authenticating: Data("live".utf8) + space)
  }
```

- [ ] **Step 5: Teach the engine the relay**

In `Sync.swift`, add to `Page` and `PushResult`:

```swift
  /// The live layer's relay, when the server names one.
  public var relay: String? = nil
```

In `SyncEngine`, after `public var flushLocal`:

```swift
  /// The relay the server last named; nil until it names one.
  public private(set) var relay: String?
  public var onRelay: ((String?) -> Void)?
  /// After a push the server took, with the highest version it gave.
  public var onPushed: ((Int) -> Void)?
  /// After the pulls of a cycle, with the store's cursor.
  public var onPulled: ((Int) -> Void)?
  /// When a cycle last ended synced.
  public private(set) var lastSynced: Date?
```

and before `decode`:

```swift
  private func note(relay r: String?) {
    let valid = r.flatMap { $0.hasPrefix("wss://") || $0.hasPrefix("ws://") ? $0 : nil }
    guard valid != relay else { return }
    relay = valid
    onRelay?(valid)
  }
```

In `cycle()`: after `guard same() else { return }` following `transport.pull`, add `note(relay: page.relay)`. After the pull loop's closing brace (before `var refusals = 0`), add `onPulled?(store.state.cursor)`. After the line `for a in result.accepted { … }`, add:

```swift
        note(relay: result.relay)
        if let top = result.accepted.map(\.version).max() { onPushed?(top) }
```

and before `update(.synced)` add `lastSynced = now()`.

- [ ] **Step 6: Write overlays**

`BreezyKit/Sources/BreezyKit/Overlay.swift`:

```swift
import Foundation

/// Record fields of an item someone else is dragging or editing, as their live messages carry them.
public typealias LiveFields = [String: JSONValue]

extension Records {
  /// The fields a live message may carry; an item new during the gesture also carries `kind`.
  public static let liveFieldNames: Set<String> = ["pos", "size", "w", "text", "notes", "color", "title"]

  /// What the gesture changed of items `ids` between `start` and `now`, as record fields.
  public static func liveFields(from start: Board, to now: Board, ids: Set<String>, board: String) -> [String: LiveFields] {
    var out: [String: LiveFields] = [:]
    func put(_ id: String, _ before: Record?, _ after: Record) {
      let names = before == nil ? liveFieldNames.union(["kind"]) : liveFieldNames
      let f = after.fields.filter { names.contains($0.key) && before?[$0.key] != $0.value }
      if !f.isEmpty { out[id] = f }
    }
    for c in now.cards where ids.contains(c.id) {
      put(c.id, start.card(c.id).map { card($0, board: board, order: "") }, card(c, board: board, order: ""))
    }
    for l in now.lanes where ids.contains(l.id) {
      put(l.id, start.lane(l.id).map { lane($0, board: board) }, lane(l, board: board))
    }
    return out
  }
}

extension Board {
  /// This board as others' live edits show it; a new card appears, other unknown ids are left out.
  public func overlaid(_ overlay: [String: LiveFields]) -> Board {
    guard !overlay.isEmpty else { return self }
    var b = self
    for i in b.cards.indices {
      guard let f = overlay[b.cards[i].id] else { continue }
      if let (x, y) = Records.unpair(f["pos"]) { (b.cards[i].x, b.cards[i].y) = (x, y) }
      if let w = f["w"]?.number, w.isFinite { b.cards[i].w = w }
      if let t = f["text"]?.string { b.cards[i].text = t }
      if let n = f["notes"]?.string { b.cards[i].notes = n.isEmpty ? nil : n }
      if let c = f["color"]?.number { b.cards[i].color = Int(min(max(c, 1), 5)) }
    }
    for i in b.lanes.indices {
      guard let f = overlay[b.lanes[i].id] else { continue }
      if let (x, y) = Records.unpair(f["pos"]) { (b.lanes[i].x, b.lanes[i].y) = (x, y) }
      if let (w, h) = Records.unpair(f["size"]) { (b.lanes[i].w, b.lanes[i].h) = (w, h) }
      if let t = f["title"]?.string { b.lanes[i].title = t }
    }
    let known = Set(b.cards.map(\.id))
    for (id, f) in overlay.sorted(by: { $0.key < $1.key }) where f["kind"]?.string == "card" && !known.contains(id) {
      let (x, y) = Records.unpair(f["pos"]) ?? (0, 0)
      let notes = f["notes"]?.string ?? ""
      b.cards.append(Card(id: id, x: x, y: y, w: f["w"]?.number ?? Metrics.cardWidth, text: f["text"]?.string ?? "",
                          notes: notes.isEmpty ? nil : notes, color: Int(min(max(f["color"]?.number ?? 1, 1), 5))))
    }
    return b
  }
}
```

(`Records.unpair` is `static` without an access modifier, so internal: fine within the module.)

- [ ] **Step 7: Cancel a gesture, and filter what others hold**

In `BoardModel.swift`, after `end(_:)`:

```swift
  /// Ends the gesture, putting the board back as it began, without an undo step.
  public func cancel() {
    guard let start = gestureStart else { return }
    let before = board
    board = start
    cancelGesture()
    if board != before { notify(before) }
  }

  /// The board as the gesture under way began, if one is.
  public var gestureStartBoard: Board? { gestureStart }
```

In `BoardBinding.swift`, add after `public var restack`:

```swift
  /// Items someone else holds: local changes to them are not written, as the holder's are the ones that count.
  public var taken: () -> Set<String> = { [] }
  /// After every change to the model, after the binding's own handling.
  public var afterEdit: (() -> Void)?
  /// After a gesture ends or is cancelled.
  public var afterGesture: (() -> Void)?
```

change the init's closures to:

```swift
    model.onEdit = { [weak self] in
      self?.changed()
      self?.afterEdit?()
    }
    model.onGestureEnd = { [weak self] in
      // after the gesture's undo step is registered, so that the step holds only local changes
      DispatchQueue.main.async {
        if self?.waiting == true { self?.pull() }
        self?.afterGesture?()
      }
    }
```

and in `flush()` filter the changes:

```swift
  public func flush() {
    guard model.board != seen else { return }
    let held = taken()
    let changes = Records.changes(from: seen, to: model.board, board: id, orders: store.orders(of: id)).filter { !held.contains($0.key) }
    seen = model.board
    store.apply(changes)
  }
```

- [ ] **Step 8: Run the tests to see them pass**

Run: `swift test --package-path BreezyKit`
Expected: PASS, every test.

- [ ] **Step 9: Commit**

```bash
git add BreezyKit
git commit -m "Seal live messages, learn the relay, and draw overlays in BreezyKit"
```

---

### Task 4: The same in the web app

**Files:**
- Create: `web/sync/overlay.js`
- Modify: `web/sync/crypto.js`, `web/sync/engine.js`, `web/model.js`, `web/binding.js`, `web/test/helpers/fake-server.js`
- Test: `web/test/crypto.test.js`, `web/test/engine.test.js`, `web/test/overlay.test.js` (new), `web/test/model.test.js`, `web/test/binding.test.js`

**Interfaces:**
- Consumes: `BreezyKit/Tests/Fixtures/live.json` (Task 3).
- Produces:
  - `SpaceKeys.sealLive(plain: Uint8Array, nonce = randomBytes(12)) -> Promise<Uint8Array>`, `SpaceKeys.openLive(body: Uint8Array) -> Promise<Uint8Array>`
  - `SyncEngine`: `relay` (string|null), `onRelay(relay)`, `onPushed(version)`, `onPulled(cursor)`, `lastCycle` (ms, 0 before the first synced cycle)
  - `web/sync/overlay.js`: `LIVE_FIELDS` (array), `liveFields(start, now, ids: Set, board) -> {id: fields}`, `overlaid(board, overlay: Map<id, fields>) -> board`
  - `Model.cancel()` exists already; `Model.start` is the gesture's starting board.
  - `Binding.taken: () => Set` (default empty).

- [ ] **Step 1: Write the failing tests**

In `web/test/crypto.test.js` add:

```js
test("live messages match the shared vector", async () => {
  const lv = fixture("live.json");
  const keys = await SpaceKeys.create(decode(lv.space), decode(lv.secret));
  assert.equal(encode(await keys.sealLive(enc.encode(lv.plaintext), decode(lv.nonce))), lv.body);
  assert.equal(new TextDecoder().decode(await keys.openLive(decode(lv.body))), lv.plaintext);
});

test("live messages and records never pass for each other", async () => {
  const keys = await SpaceKeys.create(randomBytes(16), randomBytes(32));
  const body = await keys.sealLive(enc.encode("x"));
  await assert.rejects(keys.open(body, enc.encode("live")));
  await assert.rejects(keys.openLive(await keys.seal(enc.encode("x"), randomBytes(16))));
  await assert.rejects((await SpaceKeys.create(randomBytes(16), randomBytes(32))).openLive(body));
});
```

In `web/test/helpers/fake-server.js`, add `this.relay = null;` to the `FakeServer` constructor; in `pull` return `{ records: …, cursor: …, epoch: this.epoch, ...(this.relay ? { relay: this.relay } : {}) }` and in `push` return `{ accepted, refused, epoch: this.epoch, ...(this.relay ? { relay: this.relay } : {}) }`.

In `web/test/engine.test.js` add:

```js
test("the engine learns the relay and reports pushes and pulls", async () => {
  const { server, a, b, id } = await pair(newID);
  const relays = [], pushed = [], pulled = [];
  a.engine.onRelay = (r) => relays.push(r);
  a.engine.onPushed = (v) => pushed.push(v);
  a.engine.onPulled = (c) => pulled.push(c);
  server.relay = "wss://relay.example/";
  a.edit(id, (x) => (x.cards[0].color = 2));
  await a.engine.sync();
  assert.equal(a.engine.relay, "wss://relay.example/");
  assert.deepEqual(relays, ["wss://relay.example/"]);
  assert.deepEqual(pushed, [server.version]);
  assert.deepEqual(pulled, [server.version - 1]);
  assert.ok(a.engine.lastCycle > 0);
  server.relay = "http://not-a-relay";
  await b.engine.sync();
  assert.equal(b.engine.relay, null);
});
```

New `web/test/overlay.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { liveFields, overlaid } from "../sync/overlay.js";

const card = (id, x, y, text = "t") => ({ id, x, y, w: 240, text, color: 1 });
const lane = (id, x, y) => ({ id, x, y, w: 480, h: 720, title: "Lane" });

test("live fields are what a gesture changed of its items", () => {
  const start = { cards: [card("a", 0, 0, "x"), card("b", 0, 96)], lanes: [lane("l", 0, 0)] };
  const now = structuredClone(start);
  Object.assign(now.cards[0], { x: 48, text: "typed" });
  now.cards[1].x = 480;
  now.lanes[0].w = 720;
  now.cards.push(card("n", 24, 24, "new"));
  const f = liveFields(start, now, new Set(["a", "l", "n"]), "B");
  assert.deepEqual(f.a, { pos: [48, 0], text: "typed" });
  assert.equal(f.b, undefined);
  assert.deepEqual(f.l, { size: [720, 720] });
  assert.equal(f.n.kind, "card");
  assert.equal(f.n.text, "new");
  assert.equal(f.n.order, undefined);
});

test("an overlay is drawn over the board", () => {
  const b = { cards: [card("a", 0, 0, "x")], lanes: [lane("l", 0, 0)] };
  const shown = overlaid(b, new Map([
    ["a", { pos: [48, 24], text: "typed", notes: "", color: 3 }],
    ["l", { pos: [10, 20], size: [500, 600], title: "Now" }],
    ["n", { kind: "card", pos: [1, 2], w: 240, text: "new", notes: "", color: 1 }],
    ["gone", { pos: [1, 2] }],
  ]));
  assert.deepEqual(shown.cards[0], { id: "a", x: 48, y: 24, w: 240, text: "typed", color: 3 });
  assert.deepEqual(shown.lanes[0], { id: "l", x: 10, y: 20, w: 500, h: 600, title: "Now" });
  assert.equal(shown.cards[1].text, "new");
  assert.equal(shown.cards.length, 2);
  assert.equal(overlaid(b, new Map()), b);
  assert.equal(b.cards[0].x, 0);
});
```

In `web/test/binding.test.js` add:

```js
test("changes to items others hold are not written", () => {
  const { store, id, model, binding } = opened([card("a", 0), card("b", 96)]);
  binding.taken = () => new Set(["b"]);
  model.perform("Move", (b) => {
    b.cards[0].x = 48;
    b.cards[1].x = 480;
  });
  binding.flush();
  assert.equal(store.board(id).cards.find((c) => c.id === "a").x, 48);
  assert.equal(store.board(id).cards.find((c) => c.id === "b").x, 0);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test web/test/*.test.js`
Expected: FAIL: `keys.sealLive is not a function`, `Cannot find module '…/sync/overlay.js'`, `a.engine.relay` undefined, and the binding test writes `b`.

- [ ] **Step 3: Seal live messages**

In `web/sync/crypto.js`, inside `SpaceKeys` after `open`:

```js
  /** A live message's body: bound to the space, and marked live so that it never passes for a record. */
  async sealLive(plain, nonce = randomBytes(12)) {
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: this.liveAad() }, this.key, plain));
    const out = new Uint8Array(nonce.length + ct.length);
    out.set(nonce);
    out.set(ct, nonce.length);
    return out;
  }

  async openLive(body) {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: body.slice(0, 12), additionalData: this.liveAad() }, this.key, body.slice(12)));
  }

  liveAad() {
    const a = new Uint8Array(4 + this.space.length);
    a.set(enc.encode("live"));
    a.set(this.space, 4);
    return a;
  }
```

- [ ] **Step 4: Teach the engine the relay**

In `web/sync/engine.js`, in the `SyncEngine` constructor after `this.flushLocal = () => {};`:

```js
    /** The relay the server last named; null until it names one. */
    this.relay = null;
    this.onRelay = () => {};
    /** After a push the server took, with the highest version it gave. */
    this.onPushed = () => {};
    /** After the pulls of a cycle, with the store's cursor. */
    this.onPulled = () => {};
    /** When a cycle last ended synced, in ms. */
    this.lastCycle = 0;
```

Add a method after `reset()`:

```js
  noteRelay(r) {
    const relay = typeof r === "string" && /^wss?:\/\//.test(r) ? r : null;
    if (relay === this.relay) return;
    this.relay = relay;
    this.onRelay(relay);
  }
```

In `cycle()`: after `if (!same()) return;` following `transport.pull`, add `this.noteRelay(page.relay);`. After the pull loop (before `let refusals = 0;`), add `this.onPulled(this.store.state.cursor);`. After the line `for (const a of result.accepted) …`, add:

```js
        this.noteRelay(result.relay);
        if (result.accepted.length) this.onPushed(Math.max(...result.accepted.map((a) => a.version)));
```

and before `this.update("synced");` add `this.lastCycle = this.now();`.

- [ ] **Step 5: Write overlays**

`web/sync/overlay.js`:

```js
// Others' live edits drawn over a board, and what a gesture sends of them, as BreezyKit's Overlay.
import { cardRecord, laneRecord } from "./records.js";

/** The fields a live message may carry; an item new during the gesture also carries `kind`. */
export const LIVE_FIELDS = ["pos", "size", "w", "text", "notes", "color", "title"];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** What the gesture changed of items `ids` between `start` and `now`, as record fields. */
export function liveFields(start, now, ids, board) {
  const out = {};
  const put = (id, before, after) => {
    const names = before ? LIVE_FIELDS : [...LIVE_FIELDS, "kind"];
    const f = Object.fromEntries(names.filter((k) => k in after && !same(before?.[k], after[k])).map((k) => [k, after[k]]));
    if (Object.keys(f).length) out[id] = f;
  };
  for (const c of now.cards) {
    if (!ids.has(c.id)) continue;
    const was = start.cards.find((x) => x.id === c.id);
    put(c.id, was && cardRecord(was, board, ""), cardRecord(c, board, ""));
  }
  for (const l of now.lanes) {
    if (!ids.has(l.id)) continue;
    const was = start.lanes.find((x) => x.id === l.id);
    put(l.id, was && laneRecord(was, board), laneRecord(l, board));
  }
  return out;
}

const pair = (v) => (Array.isArray(v) && v.length === 2 && v.every(Number.isFinite) ? v : null);
const colour = (v) => Math.trunc(Math.min(5, Math.max(1, v)));

/** `board` as others' live edits show it, a copy; a new card appears, other unknown ids are left out. */
export function overlaid(board, overlay) {
  if (!overlay.size) return board;
  const b = structuredClone(board);
  for (const c of b.cards) {
    const f = overlay.get(c.id);
    if (!f) continue;
    const p = pair(f.pos);
    if (p) [c.x, c.y] = p;
    if (Number.isFinite(f.w)) c.w = f.w;
    if (typeof f.text === "string") c.text = f.text;
    if (typeof f.notes === "string") {
      if (f.notes) c.notes = f.notes;
      else delete c.notes;
    }
    if (Number.isFinite(f.color)) c.color = colour(f.color);
  }
  for (const l of b.lanes) {
    const f = overlay.get(l.id);
    if (!f) continue;
    const p = pair(f.pos), s = pair(f.size);
    if (p) [l.x, l.y] = p;
    if (s) [l.w, l.h] = s;
    if (typeof f.title === "string") l.title = f.title;
  }
  const known = new Set(b.cards.map((c) => c.id));
  for (const [id, f] of [...overlay].sort(([a], [z]) => (a < z ? -1 : 1))) {
    if (f.kind !== "card" || known.has(id)) continue;
    const [x, y] = pair(f.pos) ?? [0, 0];
    b.cards.push({ id, x, y, w: Number.isFinite(f.w) ? f.w : 240, text: typeof f.text === "string" ? f.text : "",
      color: Number.isFinite(f.color) ? colour(f.color) : 1, ...(f.notes ? { notes: f.notes } : {}) });
  }
  return b;
}
```

- [ ] **Step 6: Filter what others hold**

In `web/binding.js`, in the constructor after `this.timer = null;`:

```js
    /** Items someone else holds: local changes to them are not written, as the holder's are the ones that count. */
    this.taken = () => new Set();
```

and in `flush()`:

```js
  flush() {
    clearTimeout(this.timer);
    const held = this.taken();
    const c = changes(this.seen, this.model.board, this.id, this.store.orders(this.id));
    for (const id of held) delete c[id];
    this.seen = structuredClone(this.model.board);
    if (Object.keys(c).length) this.store.apply(c);
  }
```

(`Model.cancel()` and `Model.start` already exist in `web/model.js`; no change there.)

- [ ] **Step 7: Run the tests to see them pass**

Run: `node --test web/test/*.test.js`
Expected: PASS, every test.

- [ ] **Step 8: Commit**

```bash
git add web
git commit -m "Seal live messages, learn the relay, and draw overlays in the web app"
```

---
### Task 5: `Live` in BreezyKit

**Files:**
- Create: `BreezyKit/Sources/BreezyKit/Live.swift`
- Create: `BreezyKit/Tests/BreezyKitTests/LiveFakes.swift`, `BreezyKit/Tests/BreezyKitTests/LiveTests.swift`

**Interfaces:**
- Consumes: `SpaceKeys.sealLive`/`openLive`, `LiveFields`, `Records.liveFieldNames`, `JSONValue.object` (Task 3).
- Produces:
  - `struct Person: Equatable, Sendable { device, name; init(device:name:); colour: UInt32; initials: String; static palette }`
  - `struct Cursor { board, x, y }`, `struct Caret { id, back, at }` (both `Equatable, Sendable`, public memberwise inits)
  - `struct Peer { person: Person?, board: String?, selection: [String], cursor: Cursor?, heard: Date, overlay: [String: LiveFields], overlayBoard: String?, caret: Caret? }`
  - `@MainActor protocol LiveSocket: AnyObject { onOpen, onMessage(String), onClose(Int); send(_:); close() }`, `@MainActor final class WebSocketTaskSocket: LiveSocket` (`init(url:)`)
  - `@MainActor final class Live`:
    - `init(relay: String, space: String, keys: SpaceKeys, me: Person, socket: @escaping @MainActor (URL) -> LiveSocket = { WebSocketTaskSocket(url: $0) }, now: @escaping () -> Date = Date.init, schedule: @escaping (TimeInterval, @escaping @MainActor () -> Void) -> Void = …)`
    - `relay`, `space`, `me` (settable; a change sends presence), `connected: Bool`, `peers: [String: Peer]`, `holds: [String: Set<String>]`, `mine: Set<String>`
    - `connect()`, `close()`, `tick()`, `noteCursor(_ cursor: Int)`
    - `setPresence(board: String?, selection: [String])`, `sendCursor(board: String, x: Double?, y: Double?)`, `hold(_ ids: Set<String>)`, `release()`, `sendLive(board: String, items: [String: LiveFields], caret: Caret?)`, `sendPushed(_ version: Int)`
    - `taken: Set<String>`, `holder(of id: String) -> Person?`, `overlay(on board: String) -> [String: LiveFields]`, `cursors(on:) -> [(key: String, person: Person, cursor: Cursor)]`, `carets(on:) -> [(key: String, person: Person, caret: Caret)]`, `people(on board: String?) -> [Person]`, `selections(on board: String) -> [String: Person]`
    - callbacks `onChange: (() -> Void)?`, `onPushed: ((Int) -> Void)?`, `onRefused: ((Set<String>) -> Void)?`, `onUnauthorized: (() -> Void)?`
  - Test fakes: `Clock` (`now`, `schedule(_:_:)`, `advance(_:)`), `FakeRelay` (`connect(_:) -> LiveSocket`, `run()`, `sockets`, `frames`, `token`, `kick(_:code:)`, `lapse(_:)`). Task 7 uses both.

- [ ] **Step 1: Write the fakes**

`BreezyKit/Tests/BreezyKitTests/LiveFakes.swift`:

```swift
import Foundation
@testable import BreezyKit

/// Time and timers under a test's control.
@MainActor final class Clock {
  var now = Date(timeIntervalSince1970: 1_000_000)
  private var timers: [(at: Date, work: @MainActor () -> Void)] = []

  func schedule(_ delay: TimeInterval, _ work: @escaping @MainActor () -> Void) {
    timers.append((now.addingTimeInterval(delay), work))
  }

  /// Moves time on by `seconds`, running the timers due meanwhile, earliest first.
  func advance(_ seconds: TimeInterval) {
    let end = now.addingTimeInterval(seconds)
    while let i = timers.indices.filter({ timers[$0].at <= end }).min(by: { timers[$0].at < timers[$1].at }) {
      let t = timers.remove(at: i)
      now = max(now, t.at)
      t.work()
    }
    now = end
  }
}

/// The relay's rules, in memory. What sockets send is delivered when `run` is called.
@MainActor final class FakeRelay {
  final class Socket: LiveSocket {
    var onOpen: (() -> Void)?
    var onMessage: ((String) -> Void)?
    var onClose: ((Int) -> Void)?
    let id = UUID().uuidString
    weak var relay: FakeRelay?
    var authed = false
    var holds: [String] = []

    init(relay: FakeRelay) { self.relay = relay }

    func send(_ text: String) { relay?.queue.append { [weak self] in if let self { self.relay?.received(self, text) } } }
    func close() { relay?.queue.append { [weak self] in if let self { self.relay?.drop(self, code: nil) } } }
  }

  var sockets: [Socket] = []
  var queue: [() -> Void] = []
  /// The space's token, set by the first `auth`.
  var token: String?
  /// Every frame received, in order.
  var frames: [(from: String, text: String)] = []

  func connect(_ url: URL) -> LiveSocket {
    let s = Socket(relay: self)
    sockets.append(s)
    queue.append { s.onOpen?() }
    return s
  }

  func run() { while !queue.isEmpty { queue.removeFirst()() } }

  /// Closes `s` from the relay's side, as a dropped network does with 1006.
  func kick(_ s: Socket, code: Int) { drop(s, code: code) }

  /// Lets `s`'s holds lapse, as after 10 s without a message.
  func lapse(_ s: Socket) {
    s.holds = []
    announce()
  }

  private func others(_ s: Socket) -> [Socket] { sockets.filter { $0 !== s && $0.authed } }

  private func deliver(_ s: Socket, _ m: [String: Any]) {
    let text = String(decoding: try! JSONSerialization.data(withJSONObject: m), as: UTF8.self)
    queue.append { [weak s] in s?.onMessage?(text) }
  }

  private var holds: [String: [String]] {
    Dictionary(uniqueKeysWithValues: sockets.filter { $0.authed && !$0.holds.isEmpty }.map { ($0.id, $0.holds) })
  }

  private func announce() { for s in sockets where s.authed { deliver(s, ["t": "holds", "holds": holds]) } }

  func received(_ s: Socket, _ text: String) {
    guard sockets.contains(where: { $0 === s }),
          let m = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { return }
    frames.append((s.id, text))
    guard s.authed else {
      guard m["t"] as? String == "auth", let t = m["token"] as? String, token == nil || token == t else { return drop(s, code: 4001) }
      token = t
      s.authed = true
      let o = others(s)
      deliver(s, ["t": "welcome", "id": s.id, "peers": o.map(\.id), "holds": holds])
      for x in o { deliver(x, ["t": "join", "id": s.id]) }
      return
    }
    switch m["t"] as? String {
    case "hold":
      let ids = m["ids"] as? [String] ?? []
      let taken = Set(others(s).flatMap(\.holds))
      let refused = ids.filter(taken.contains)
      guard refused.isEmpty else { return deliver(s, ["t": "refused", "ids": refused]) }
      s.holds = Array(Set(s.holds + ids)).sorted()
      announce()
    case "release":
      guard !s.holds.isEmpty else { return }
      s.holds = []
      announce()
    default:
      guard let body = m["body"] as? String else { return }
      let to = m["to"] as? String
      for x in others(s) where to == nil || to == x.id { deliver(x, ["from": s.id, "body": body]) }
    }
  }

  func drop(_ s: Socket, code: Int?) {
    guard let i = sockets.firstIndex(where: { $0 === s }) else { return }
    sockets.remove(at: i)
    if s.authed {
      for x in sockets where x.authed { deliver(x, ["t": "leave", "id": s.id]) }
      if !s.holds.isEmpty { announce() }
    }
    if let code { queue.append { s.onClose?(code) } }
  }
}
```

- [ ] **Step 2: Write the failing tests**

`BreezyKit/Tests/BreezyKitTests/LiveTests.swift`:

```swift
import Foundation
import Testing
@testable import BreezyKit

private let space = "QEFCQ0RFRkdISUpLTE1OTw"

private func keys() -> SpaceKeys {
  SpaceKeys(space: Base64URL.decode(space)!, secret: Base64URL.decode("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")!)
}

@MainActor private func live(_ relay: FakeRelay, _ clock: Clock, name: String = "Ana", device: String = newID(), keys k: SpaceKeys = keys()) -> Live {
  Live(relay: "wss://relay.example/", space: space, keys: k, me: Person(device: device, name: name),
       socket: { relay.connect($0) }, now: { clock.now }, schedule: { clock.schedule($0, $1) })
}

/// Two connected devices, both showing board B1.
@MainActor private func two() -> (FakeRelay, Clock, Live, Live) {
  let relay = FakeRelay(), clock = Clock()
  let a = live(relay, clock, name: "Ana Lima"), b = live(relay, clock, name: "Bo")
  a.connect()
  relay.run()
  b.connect()
  relay.run()
  a.setPresence(board: "B1", selection: [])
  b.setPresence(board: "B1", selection: [])
  relay.run()
  return (relay, clock, a, b)
}

private let moved: [String: LiveFields] = ["c1": ["pos": .array([.number(48), .number(0)])]]

@MainActor @Test func peopleSeeEachOtherAndWhatTheyHaveSelected() {
  let (relay, _, a, b) = two()
  #expect(a.connected && b.connected)
  a.setPresence(board: "B1", selection: ["c1"])
  relay.run()
  #expect(b.people(on: "B1").map(\.name) == ["Ana Lima"])
  #expect(b.people(on: "B1").first?.initials == "AL")
  #expect(b.selections(on: "B1")["c1"]?.name == "Ana Lima")
  #expect(a.people(on: "B1").map(\.name) == ["Bo"])
  #expect(a.people(on: "B2").isEmpty)
  #expect(Person(device: newID(), name: " ").initials == "?")
}

@MainActor @Test func cursorsGoAtMostTwentyTimesASecond() {
  let (relay, clock, a, b) = two()
  let before = relay.frames.count
  a.sendCursor(board: "B1", x: 1, y: 1)
  a.sendCursor(board: "B1", x: 2, y: 2)
  a.sendCursor(board: "B1", x: 3, y: 3)
  relay.run()
  #expect(relay.frames.count == before + 1)
  #expect(b.cursors(on: "B1").map { $0.cursor.x } == [1])
  clock.advance(0.05)
  relay.run()
  #expect(relay.frames.count == before + 2)
  #expect(b.cursors(on: "B1").map { $0.cursor.x } == [3])
  a.sendCursor(board: "B1", x: nil, y: nil)
  clock.advance(0.05)
  relay.run()
  #expect(b.cursors(on: "B1").isEmpty)
}

@MainActor @Test func aStillCursorFadesAfterAMinute() {
  let (relay, clock, a, b) = two()
  a.sendCursor(board: "B1", x: 1, y: 1)
  relay.run()
  clock.advance(29)
  a.tick()
  relay.run()
  clock.advance(29)
  a.tick()
  relay.run()
  b.tick()
  #expect(b.cursors(on: "B1").count == 1)
  clock.advance(3)
  b.tick()
  #expect(b.cursors(on: "B1").isEmpty)
  #expect(b.people(on: "B1").count == 1)
}

@MainActor @Test func holdsAreAllOrNoneAndShowWhoHolds() {
  let (relay, _, a, b) = two()
  var refused: Set<String> = []
  b.onRefused = { refused = $0 }
  a.hold(["x", "y"])
  relay.run()
  #expect(b.taken == ["x", "y"])
  #expect(b.holder(of: "x")?.name == "Ana Lima")
  #expect(a.taken.isEmpty)
  b.hold(["y", "z"])
  relay.run()
  #expect(refused == ["y"])
  b.release()
  a.release()
  relay.run()
  #expect(b.taken.isEmpty && a.mine.isEmpty)
}

@MainActor @Test func liveEditsShowAsAnOverlay() {
  let (relay, _, a, b) = two()
  a.hold(["c1"])
  a.sendLive(board: "B1", items: moved, caret: Caret(id: "c1", back: false, at: 3))
  relay.run()
  #expect(b.overlay(on: "B1") == moved)
  #expect(b.overlay(on: "B2").isEmpty)
  #expect(b.carets(on: "B1").map { $0.caret } == [Caret(id: "c1", back: false, at: 3)])
}

@MainActor @Test func theOverlayStaysUntilThePullReachesThePushedVersion() {
  let (relay, _, a, b) = two()
  var pushes: [Int] = []
  b.onPushed = { pushes.append($0) }
  a.hold(["c1"])
  a.sendLive(board: "B1", items: moved, caret: nil)
  relay.run()
  a.sendPushed(7)
  a.release()
  relay.run()
  #expect(pushes == [7])
  #expect(b.overlay(on: "B1") == moved)
  b.noteCursor(6)
  #expect(b.overlay(on: "B1") == moved)
  b.noteCursor(7)
  #expect(b.overlay(on: "B1").isEmpty)
}

@MainActor @Test func aHoldThatEndsWithoutAPushDropsTheOverlay() {
  let (relay, _, a, b) = two()
  a.hold(["c1"])
  a.sendLive(board: "B1", items: moved, caret: Caret(id: "c1", back: false, at: 0))
  relay.run()
  relay.lapse(relay.sockets[0])
  relay.run()
  #expect(b.taken.isEmpty)
  #expect(b.overlay(on: "B1").isEmpty)
  #expect(b.carets(on: "B1").isEmpty)
}

@MainActor @Test func anotherConnectionOfTheSameDeviceStillHolds() {
  let relay = FakeRelay(), clock = Clock()
  let device = newID()
  let a = live(relay, clock, device: device), a2 = live(relay, clock, device: device)
  a.connect()
  a2.connect()
  relay.run()
  a.setPresence(board: "B1", selection: [])
  a.hold(["c1"])
  relay.run()
  #expect(a2.taken == ["c1"])
  #expect(a2.people(on: "B1").isEmpty)
}

@MainActor @Test func aPeerThatLeavesOrFallsSilentIsGone() {
  let (relay, clock, a, b) = two()
  a.hold(["c1"])
  relay.run()
  a.close()
  relay.run()
  #expect(b.people(on: "B1").isEmpty && b.taken.isEmpty)
  let c = live(relay, clock, name: "Cy")
  c.connect()
  relay.run()
  c.setPresence(board: "B1", selection: [])
  relay.run()
  #expect(b.people(on: "B1").map(\.name) == ["Cy"])
  clock.advance(31)
  b.tick()
  #expect(b.people(on: "B1").isEmpty)
}

@MainActor @Test func presenceRepeatsAndAHolderKeepsSendingLive() {
  let (relay, clock, a, _) = two()
  let me = relay.sockets[0].id
  func bodies() -> Int { relay.frames.filter { $0.from == me && $0.text.contains("\"body\"") }.count }
  a.hold(["c1"])
  a.sendLive(board: "B1", items: moved, caret: nil)
  relay.run()
  let start = bodies()
  clock.advance(5)
  a.tick()
  relay.run()
  #expect(bodies() == start + 1)
  clock.advance(10)
  a.tick()
  relay.run()
  #expect(bodies() == start + 3)
  a.release()
  clock.advance(5)
  a.tick()
  relay.run()
  #expect(bodies() == start + 3)
}

@MainActor @Test func aReconnectAsksForItsHoldsAgain() {
  let (relay, clock, a, b) = two()
  var refused: Set<String> = []
  a.onRefused = { refused = $0 }
  a.hold(["c1"])
  relay.run()
  relay.kick(relay.sockets[0], code: 1006)
  relay.run()
  #expect(!a.connected && b.taken.isEmpty)
  #expect(a.mine == ["c1"])
  b.hold(["c1"])
  relay.run()
  clock.advance(1)
  relay.run()
  #expect(a.connected)
  #expect(refused == ["c1"])
}

@MainActor @Test func reconnectsBackOffAndStopForAWrongToken() {
  let relay = FakeRelay(), clock = Clock()
  let a = live(relay, clock)
  a.connect()
  relay.run()
  relay.kick(relay.sockets[0], code: 1006)
  relay.run()
  clock.advance(1)
  relay.kick(relay.sockets[0], code: 1006)
  relay.run()
  clock.advance(1.9)
  relay.run()
  #expect(relay.sockets.isEmpty)
  clock.advance(0.1)
  relay.run()
  #expect(a.connected)

  let wrong = FakeRelay()
  wrong.token = "someone else's"
  var unauthorized = false
  let b = live(wrong, clock)
  b.onUnauthorized = { unauthorized = true }
  b.connect()
  wrong.run()
  clock.advance(60)
  wrong.run()
  #expect(unauthorized && !b.connected && wrong.sockets.isEmpty)
}

@MainActor @Test func bodiesSealedForAnotherSpaceAreDropped() {
  let relay = FakeRelay(), clock = Clock()
  // the same secret, so the same token and key, but another space: its bodies do not open here
  let other = SpaceKeys(space: randomBytes(16), secret: Base64URL.decode("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")!)
  let stranger = live(relay, clock, keys: other)
  let b = live(relay, clock)
  stranger.connect()
  b.connect()
  relay.run()
  stranger.setPresence(board: "B1", selection: [])
  relay.run()
  #expect(stranger.connected && b.connected)
  #expect(b.people(on: "B1").isEmpty)
}
```

- [ ] **Step 3: Run them to see them fail**

Run: `swift test --package-path BreezyKit --filter LiveTests`
Expected: build errors: `cannot find type 'LiveSocket'`, `cannot find 'Live'`.

- [ ] **Step 4: Write `Live`**

`BreezyKit/Sources/BreezyKit/Live.swift`:

```swift
import Foundation

/// Someone in a space: a device, the name its person goes by, and the colour that device shows in.
public struct Person: Equatable, Sendable {
  public static let palette: [UInt32] = [0xe5484d, 0xf76b15, 0x12a594, 0x8e4ec6, 0x3e63dd, 0xe93d82, 0xad7f58, 0x00a2c7]
  public var device: String
  public var name: String

  public init(device: String, name: String) {
    self.device = device
    self.name = name
  }

  public var colour: UInt32 { Self.palette[Int(Base64URL.decode(device)?.first ?? 0) % Self.palette.count] }

  /// One or two letters for avatars.
  public var initials: String {
    let s = name.split(whereSeparator: \.isWhitespace).prefix(2).compactMap { $0.first.map { String($0).uppercased() } }.joined()
    return s.isEmpty ? "?" : s
  }

  var hex: String { String(format: "#%06x", colour) }
}

/// Where someone's pointer is, in board coordinates.
public struct Cursor: Equatable, Sendable {
  public var board: String
  public var x: Double
  public var y: Double

  public init(board: String, x: Double, y: Double) {
    self.board = board
    self.x = x
    self.y = y
  }
}

/// Where someone's caret is in the card they edit: a UTF-16 offset into its front, or into its notes.
public struct Caret: Equatable, Sendable {
  public var id: String
  public var back: Bool
  public var at: Int

  public init(id: String, back: Bool, at: Int) {
    self.id = id
    self.back = back
    self.at = at
  }
}

/// Another connection to the space, as its messages describe it.
public struct Peer: Equatable, Sendable {
  /// Nil until its first presence.
  public var person: Person?
  public var board: String?
  public var selection: [String] = []
  public var cursor: Cursor?
  public var heard: Date
  var cursorAt: Date?
  public var overlay: [String: LiveFields] = [:]
  public var overlayBoard: String?
  public var caret: Caret?
  /// A version it pushed that this device has not pulled yet; its overlay stays until then.
  var awaiting = 0
}

/// A WebSocket as `Live` uses it; tests put a fake in its place.
@MainActor public protocol LiveSocket: AnyObject {
  var onOpen: (() -> Void)? { get set }
  var onMessage: ((String) -> Void)? { get set }
  /// With the close code: 1006 when the connection failed.
  var onClose: ((Int) -> Void)? { get set }
  func send(_ text: String)
  func close()
}

/// `LiveSocket` over `URLSessionWebSocketTask`, calling back on the main queue.
@MainActor public final class WebSocketTaskSocket: NSObject, LiveSocket, URLSessionWebSocketDelegate {
  public var onOpen: (() -> Void)?
  public var onMessage: ((String) -> Void)?
  public var onClose: ((Int) -> Void)?
  private var session: URLSession!
  private var task: URLSessionWebSocketTask!
  private var ended = false

  public init(url: URL) {
    super.init()
    session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
    task = session.webSocketTask(with: url)
    task.resume()
    receive()
  }

  private func receive() {
    task.receive { [weak self] result in
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let self, !ended else { return }
          switch result {
          case .success(.string(let s)):
            onMessage?(s)
            receive()
          case .success(.data(let d)):
            onMessage?(String(decoding: d, as: UTF8.self))
            receive()
          case .success:
            receive()
          case .failure:
            end(task.closeCode == .invalid ? 1006 : task.closeCode.rawValue)
          }
        }
      }
    }
  }

  public func send(_ text: String) {
    guard !ended else { return }
    task.send(.string(text)) { _ in }
  }

  /// Closes from this side, without `onClose`.
  public func close() {
    guard !ended else { return }
    ended = true
    task.cancel(with: .normalClosure, reason: nil)
    session.invalidateAndCancel()
  }

  private func end(_ code: Int) {
    guard !ended else { return }
    ended = true
    session.invalidateAndCancel()
    onClose?(code)
  }

  public nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    MainActor.assumeIsolated { if !ended { onOpen?() } }
  }

  public nonisolated func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
  ) {
    MainActor.assumeIsolated { end(closeCode.rawValue) }
  }

  public nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    MainActor.assumeIsolated { end(1006) }
  }
}

/// A space's live layer over its relay: who is here and where, what they hold, and their edits as they happen; see
/// the multiplayer design. Bodies are sealed with the space key, so the relay reads none of them.
@MainActor public final class Live {
  public static let sendInterval: TimeInterval = 0.05
  public static let heartbeat: TimeInterval = 5
  public static let presenceInterval: TimeInterval = 15
  public static let gone: TimeInterval = 30
  public static let idleCursor: TimeInterval = 60
  public static let maxBackoff: TimeInterval = 30
  static let maxFrame = 65_536
  static let encoder: JSONEncoder = {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return e
  }()

  public let relay: String
  public let space: String
  let keys: SpaceKeys
  public var me: Person { didSet { if me != oldValue { sendPresence() } } }
  public private(set) var id: String?
  public var connected: Bool { id != nil }
  public private(set) var peers: [String: Peer] = [:]
  public private(set) var holds: [String: Set<String>] = [:]
  /// What this connection holds, or has asked to.
  public private(set) var mine: Set<String> = []
  public var onChange: (() -> Void)?
  public var onPushed: ((Int) -> Void)?
  public var onRefused: ((Set<String>) -> Void)?
  public var onUnauthorized: (() -> Void)?

  private let makeSocket: @MainActor (URL) -> LiveSocket
  private let now: () -> Date
  private let schedule: (TimeInterval, @escaping @MainActor () -> Void) -> Void
  private var socket: LiveSocket?
  private var wanted = false
  private var failures = 0
  private var presence: (board: String?, selection: [String]) = (nil, [])
  private var cursor: Cursor?
  private var cursorBoard = ""
  private var presenceSent = Date.distantPast
  private var cursorSent = Date.distantPast, cursorQueued = false
  private var liveSent = Date.distantPast, liveQueued = false
  private var lastLive: [String: JSONValue]?
  private var storeCursor = 0

  public init(
    relay: String, space: String, keys: SpaceKeys, me: Person,
    socket: @escaping @MainActor (URL) -> LiveSocket = { WebSocketTaskSocket(url: $0) },
    now: @escaping () -> Date = Date.init,
    schedule: @escaping (TimeInterval, @escaping @MainActor () -> Void) -> Void = { delay, work in
      DispatchQueue.main.asyncAfter(deadline: .now() + delay) { MainActor.assumeIsolated(work) }
    }
  ) {
    self.relay = relay
    self.space = space
    self.keys = keys
    self.me = me
    makeSocket = socket
    self.now = now
    self.schedule = schedule
  }

  // MARK: connection

  public func connect() {
    wanted = true
    if socket == nil { open() }
  }

  public func close() {
    wanted = false
    let s = socket
    socket = nil
    s?.close()
    reset()
  }

  private func open() {
    guard var c = URLComponents(string: relay) else { return }
    c.queryItems = (c.queryItems ?? []) + [URLQueryItem(name: "space", value: space)]
    guard let url = c.url else { return }
    let s = makeSocket(url)
    socket = s
    s.onOpen = { [weak self, weak s] in
      guard let self, let s, s === socket else { return }
      frame(["t": .string("auth"), "token": .string(Base64URL.encode(keys.token))])
    }
    s.onMessage = { [weak self, weak s] text in
      guard let self, let s, s === socket else { return }
      received(text)
    }
    s.onClose = { [weak self, weak s] code in
      guard let self, let s, s === socket else { return }
      socket = nil
      reset()
      if code == 4001 { return onUnauthorized?() }
      guard wanted else { return }
      let delay = min(Self.maxBackoff, pow(2, Double(failures)))
      failures += 1
      schedule(delay) { [weak self] in
        guard let self, wanted, socket == nil else { return }
        open()
      }
    }
  }

  private func reset() {
    let had = connected || !peers.isEmpty || !holds.isEmpty
    id = nil
    peers = [:]
    holds = [:]
    if had { onChange?() }
  }

  private func frame(_ f: [String: JSONValue]) {
    guard let data = try? Self.encoder.encode(JSONValue.object(f)) else { return }
    socket?.send(String(decoding: data, as: UTF8.self))
  }

  /// A sealed body to everyone else, or to connection `to`.
  private func send(_ body: [String: JSONValue], to: String? = nil) {
    guard connected, let plain = try? Self.encoder.encode(JSONValue.object(body)), let sealed = try? keys.sealLive(plain) else { return }
    let b = Base64URL.encode(sealed)
    guard b.count <= Self.maxFrame - 100 else { return }
    var f: [String: JSONValue] = ["body": .string(b)]
    if let to { f["to"] = .string(to) }
    frame(f)
  }

  // MARK: receiving

  private static func holds(_ v: JSONValue?) -> [String: Set<String>] {
    (v?.object ?? [:]).mapValues { Set(($0.array ?? []).compactMap(\.string)) }
  }

  private static func cursor(_ v: JSONValue?) -> Cursor? {
    guard let o = v?.object, let board = o["board"]?.string, let x = o["x"]?.number, let y = o["y"]?.number, x.isFinite, y.isFinite
    else { return nil }
    return Cursor(board: board, x: x, y: y)
  }

  private static func caret(_ v: JSONValue?) -> Caret? {
    guard let o = v?.object, let id = o["id"]?.string, let back = o["back"]?.bool, let at = o["at"]?.number, at >= 0, at == at.rounded()
    else { return nil }
    return Caret(id: id, back: back, at: Int(at))
  }

  private func received(_ text: String) {
    guard let m = try? JSONDecoder().decode([String: JSONValue].self, from: Data(text.utf8)) else { return }
    switch m["t"]?.string {
    case "welcome":
      id = m["id"]?.string
      failures = 0
      holds = Self.holds(m["holds"])
      sendPresence()
      if !mine.isEmpty { frame(["t": .string("hold"), "ids": .array(mine.sorted().map(JSONValue.string))]) }
      onChange?()
    case "join":
      if let who = m["id"]?.string { sendPresence(to: who) }
    case "leave":
      guard let who = m["id"]?.string else { return }
      peers[who] = nil
      holds[who] = nil
      onChange?()
    case "holds":
      holds = Self.holds(m["holds"])
      dropReleased()
      onChange?()
    case "refused":
      let ids = Set((m["ids"]?.array ?? []).compactMap(\.string))
      if !ids.isEmpty { onRefused?(ids) }
    default:
      guard connected, let from = m["from"]?.string, let body = m["body"]?.string, let sealed = Base64URL.decode(body),
            let plain = try? keys.openLive(sealed), let b = try? JSONDecoder().decode([String: JSONValue].self, from: plain)
      else { return }
      heard(from, b)
    }
  }

  private func heard(_ from: String, _ b: [String: JSONValue]) {
    let t = now()
    var p = peers[from] ?? Peer(heard: t)
    p.heard = t
    switch b["t"]?.string {
    case "presence":
      guard let device = b["device"]?.string, Base64URL.decode(device)?.count == 16 else { return }
      p.person = Person(device: device, name: String((b["name"]?.string ?? "").prefix(100)))
      p.board = b["board"]?.string
      p.selection = (b["selection"]?.array ?? []).compactMap(\.string)
      // a cursor not heard yet, as a newcomer gets it; later ones come as cursor messages, so a faded one stays faded
      if b["cursor"] != nil, p.cursorAt == nil {
        p.cursor = Self.cursor(b["cursor"])
        p.cursorAt = t
      }
    case "cursor":
      p.cursor = Self.cursor(.object(b))
      p.cursorAt = t
    case "live":
      p.overlayBoard = b["board"]?.string
      for (id, f) in b["items"]?.object ?? [:] {
        guard let f = f.object else { continue }
        p.overlay[id, default: [:]].merge(f.filter { Records.liveFieldNames.contains($0.key) || $0.key == "kind" }) { $1 }
      }
      p.caret = Self.caret(b["caret"])
    case "pushed":
      guard let v = b["version"]?.number, v >= 0, v == v.rounded() else { return }
      p.awaiting = max(p.awaiting, Int(v))
      peers[from] = p
      onPushed?(Int(v))
      dropReleased()
      return onChange?()
    default:
      return
    }
    peers[from] = p
    dropReleased()
    onChange?()
  }

  /// Overlays of items no longer held go, unless their holder pushed a version not pulled yet.
  private func dropReleased() {
    for (conn, var p) in peers {
      guard p.awaiting <= storeCursor else { continue }
      p.awaiting = 0
      let held = holds[conn] ?? []
      p.overlay = p.overlay.filter { held.contains($0.key) }
      if held.isEmpty { p.caret = nil }
      peers[conn] = p
    }
  }

  /// The store pulled up to `cursor`: overlays waiting for it can go.
  public func noteCursor(_ cursor: Int) {
    storeCursor = max(storeCursor, cursor)
    dropReleased()
    onChange?()
  }

  /// About once a second: forgets the silent, fades still cursors, repeats presence and a holder's live fields.
  public func tick() {
    let t = now()
    var changed = false
    for (conn, var p) in peers {
      if t.timeIntervalSince(p.heard) > Self.gone {
        peers[conn] = nil
        changed = true
      } else if p.cursor != nil, t.timeIntervalSince(p.cursorAt ?? t) > Self.idleCursor {
        p.cursor = nil
        peers[conn] = p
        changed = true
      }
    }
    if connected && t.timeIntervalSince(presenceSent) >= Self.presenceInterval { sendPresence() }
    if connected && !mine.isEmpty, let l = lastLive, t.timeIntervalSince(liveSent) >= Self.heartbeat {
      liveSent = t
      send(l)
    }
    if changed { onChange?() }
  }

  // MARK: sending

  public func setPresence(board: String?, selection: [String]) {
    guard board != presence.board || selection != presence.selection else { return }
    presence = (board, selection)
    sendPresence()
  }

  private func sendPresence(to: String? = nil) {
    guard connected else { return }
    if to == nil { presenceSent = now() }
    send([
      "t": .string("presence"), "device": .string(me.device), "name": .string(me.name), "colour": .string(me.hex),
      "board": presence.board.map(JSONValue.string) ?? .null, "selection": .array(presence.selection.map(JSONValue.string)),
      "cursor": cursor.map { .object(["board": .string($0.board), "x": .number($0.x), "y": .number($0.y)]) } ?? .null,
    ], to: to)
  }

  /// This device's pointer on `board`; nil hides it. At most every 50 ms, and the last one always goes.
  public func sendCursor(board: String, x: Double?, y: Double?) {
    cursor = x.flatMap { x in y.map { Cursor(board: board, x: x, y: $0) } }
    cursorBoard = board
    let wait = Self.sendInterval - now().timeIntervalSince(cursorSent)
    if wait <= 0 { return flushCursor() }
    guard !cursorQueued else { return }
    cursorQueued = true
    schedule(wait) { [weak self] in
      self?.cursorQueued = false
      self?.flushCursor()
    }
  }

  private func flushCursor() {
    cursorSent = now()
    send(["t": .string("cursor"), "board": .string(cursorBoard), "x": cursor.map { .number($0.x) } ?? .null, "y": cursor.map { .number($0.y) } ?? .null])
  }

  /// Asks the relay for `ids`; `onRefused` tells if someone else has any. Asked again after a reconnect.
  public func hold(_ ids: Set<String>) {
    let fresh = ids.subtracting(mine)
    guard !fresh.isEmpty else { return }
    mine.formUnion(fresh)
    if connected { frame(["t": .string("hold"), "ids": .array(fresh.sorted().map(JSONValue.string))]) }
  }

  public func release() {
    guard !mine.isEmpty else { return }
    mine = []
    lastLive = nil
    if connected { frame(["t": .string("release")]) }
  }

  /// What the gesture under way changed of what it holds; at most every 50 ms, and repeated every 5 s while held.
  public func sendLive(board: String, items: [String: LiveFields], caret: Caret?) {
    lastLive = [
      "t": .string("live"), "board": .string(board), "items": .object(items.mapValues(JSONValue.object)),
      "caret": caret.map { .object(["id": .string($0.id), "back": .bool($0.back), "at": .number(Double($0.at))]) } ?? .null,
    ]
    let wait = Self.sendInterval - now().timeIntervalSince(liveSent)
    if wait <= 0 { return flushLive() }
    guard !liveQueued else { return }
    liveQueued = true
    schedule(wait) { [weak self] in
      self?.liveQueued = false
      self?.flushLive()
    }
  }

  private func flushLive() {
    guard let l = lastLive else { return }
    liveSent = now()
    send(l)
  }

  public func sendPushed(_ version: Int) { send(["t": .string("pushed"), "version": .number(Double(version))]) }

  // MARK: what others do

  /// Ids another connection holds.
  public var taken: Set<String> { Set(holds.filter { $0.key != id }.values.joined()) }

  /// Who holds `id`, if another connection does.
  public func holder(of item: String) -> Person? {
    guard let conn = holds.first(where: { $0.key != id && $0.value.contains(item) })?.key else { return nil }
    return peers[conn]?.person ?? Person(device: "", name: "")
  }

  public func overlay(on board: String) -> [String: LiveFields] {
    var out: [String: LiveFields] = [:]
    for p in peers.values where p.overlayBoard == board { out.merge(p.overlay) { $1 } }
    return out
  }

  public func cursors(on board: String) -> [(key: String, person: Person, cursor: Cursor)] {
    peers.compactMap { k, p in
      guard let person = p.person, let c = p.cursor, c.board == board else { return nil }
      return (k, person, c)
    }.sorted { $0.key < $1.key }
  }

  public func carets(on board: String) -> [(key: String, person: Person, caret: Caret)] {
    peers.compactMap { k, p in
      guard let person = p.person, let c = p.caret, p.overlayBoard == board else { return nil }
      return (k, person, c)
    }.sorted { $0.key < $1.key }
  }

  /// The people on `board`, once each and not this device's, by name.
  public func people(on board: String?) -> [Person] {
    var byDevice: [String: Person] = [:]
    for p in peers.values { if let person = p.person, p.board == board, person.device != me.device { byDevice[person.device] = person } }
    return byDevice.values.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
  }

  /// What the people on `board` have selected, and who.
  public func selections(on board: String) -> [String: Person] {
    var out: [String: Person] = [:]
    for p in peers.values where p.board == board {
      guard let person = p.person else { continue }
      for id in p.selection { out[id] = person }
    }
    return out
  }
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `swift test --package-path BreezyKit --filter LiveTests`
Expected: PASS, 13 tests.

- [ ] **Step 6: Run every BreezyKit test**

Run: `swift test --package-path BreezyKit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add BreezyKit
git commit -m "Add Live to BreezyKit: presence, cursors, holds and live edits over the relay"
```

---

### Task 6: `Live` in the web app

**Files:**
- Create: `web/sync/live.js`
- Create: `web/test/helpers/fake-relay.js`, `web/test/live.test.js`

**Interfaces:**
- Consumes: `SpaceKeys.sealLive`/`openLive` (Task 4), `LIVE_FIELDS` (Task 4), `conflicts`, `holdsOf` from `relay/src/holds.js` (Task 1, in the fake relay).
- Produces: `web/sync/live.js` exports `PALETTE`, `colourOf(device) -> "#rrggbb"`, `initials(name)`, and `class Live` with the Swift twin's behaviour:
  - `new Live({ relay, space, keys, me: { device, name }, socket = (url) => new WebSocket(url), now = () => Date.now(), schedule = (ms, fn) => setTimeout(fn, ms) })`
  - `connected`, `peers`, `holds`, `mine` (Set), `me`
  - `connect()`, `close()`, `tick()`, `noteCursor(cursor)`, `setMe(me)`, `setPresence({ board, selection })`, `sendCursor(board, x, y)` (null x, y hide), `hold(ids)`, `release()`, `sendLive(board, items, caret)`, `sendPushed(version)`
  - `taken() -> Set`, `holderOf(id) -> person|null`, `overlay(board) -> Map`, `cursors(board) -> [{ key, person, x, y }]`, `carets(board) -> [{ key, person, id, back, at }]`, `people(board) -> [person]`, `selections(board) -> Map<id, person>`
  - a person is `{ device, name, colour }`
  - callbacks `onChange()`, `onPushed(version)`, `onRefused(ids: Set)`, `onUnauthorized()`
  - Test helpers: `FakeRelay` (`connect(url)`, `async run()`, `sockets`, `frames`, `token`, `kick(socket, code)`, `lapse(socket)`), `Clock` (`now()`, `schedule(ms, fn)`, `advance(ms)`). Task 8 uses both.

- [ ] **Step 1: Write the fakes**

`web/test/helpers/fake-relay.js`:

```js
// The relay's rules in memory, with the real hold rules, and a clock for the timers of Live.
import { conflicts, holdsOf } from "../../../relay/src/holds.js";

/** Time and timers under a test's control, in ms. */
export class Clock {
  constructor() {
    this.t = 1_000_000;
    this.timers = [];
    this.now = () => this.t;
    this.schedule = (ms, fn) => this.timers.push({ at: this.t + ms, fn });
  }

  /** Moves time on by `ms`, running the timers due meanwhile, earliest first. */
  advance(ms) {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers.splice(this.timers.indexOf(due), 1);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = end;
  }
}

class Socket {
  constructor(relay) {
    this.relay = relay;
    this.id = crypto.randomUUID();
    this.authed = false;
    this.holds = [];
    this.readyState = 0;
  }

  send(text) {
    this.relay.queue.push(() => this.relay.received(this, text));
  }

  close() {
    this.relay.queue.push(() => this.relay.drop(this, null));
  }
}

/** What sockets send is delivered when `run` is called. */
export class FakeRelay {
  constructor() {
    this.sockets = [];
    this.queue = [];
    this.token = null;
    /** Every frame received, in order: { from, text }. */
    this.frames = [];
  }

  connect() {
    const s = new Socket(this);
    this.sockets.push(s);
    this.queue.push(() => {
      s.readyState = 1;
      s.onopen?.();
    });
    return s;
  }

  /** Delivers until nothing is left, letting sealing and opening finish between rounds. */
  async run() {
    for (let i = 0; i < 40; i++) {
      while (this.queue.length) this.queue.shift()();
      await new Promise((r) => setImmediate(r));
    }
  }

  kick(s, code) {
    this.drop(s, code);
  }

  lapse(s) {
    s.holds = [];
    this.announce();
  }

  conns() {
    return this.sockets.filter((s) => s.authed);
  }

  deliver(s, m) {
    const data = JSON.stringify(m);
    this.queue.push(() => s.onmessage?.({ data }));
  }

  announce() {
    for (const s of this.conns()) this.deliver(s, { t: "holds", holds: holdsOf(this.conns()) });
  }

  received(s, text) {
    if (!this.sockets.includes(s)) return;
    const m = JSON.parse(text);
    this.frames.push({ from: s.id, text });
    if (!s.authed) {
      if (m.t !== "auth" || (this.token !== null && this.token !== m.token)) return this.drop(s, 4001);
      this.token = m.token;
      s.authed = true;
      const others = this.conns().filter((x) => x !== s);
      this.deliver(s, { t: "welcome", id: s.id, peers: others.map((x) => x.id), holds: holdsOf(others) });
      for (const x of others) this.deliver(x, { t: "join", id: s.id });
      return;
    }
    if (m.t === "hold") {
      const refused = conflicts(this.conns(), s.id, m.ids);
      if (refused.length) return this.deliver(s, { t: "refused", ids: refused });
      s.holds = [...new Set([...s.holds, ...m.ids])].sort();
      return this.announce();
    }
    if (m.t === "release") {
      if (!s.holds.length) return;
      s.holds = [];
      return this.announce();
    }
    if (typeof m.body !== "string") return;
    for (const x of this.conns()) if (x !== s && (!m.to || m.to === x.id)) this.deliver(x, { from: s.id, body: m.body });
  }

  drop(s, code) {
    if (!this.sockets.includes(s)) return;
    this.sockets.splice(this.sockets.indexOf(s), 1);
    s.readyState = 3;
    if (s.authed) {
      for (const x of this.conns()) this.deliver(x, { t: "leave", id: s.id });
      if (s.holds.length) this.announce();
    }
    if (code !== null) this.queue.push(() => s.onclose?.({ code }));
  }
}
```

- [ ] **Step 2: Write the failing tests**

`web/test/live.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { Live, initials, colourOf, PALETTE } from "../sync/live.js";
import { SpaceKeys, randomBytes } from "../sync/crypto.js";
import { encode, decode } from "../sync/base64.js";
import { FakeRelay, Clock } from "./helpers/fake-relay.js";

const SPACE = "QEFCQ0RFRkdISUpLTE1OTw";
const keys = await SpaceKeys.create(decode(SPACE), decode("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"));
const device = () => encode(randomBytes(16));
const moved = { c1: { pos: [48, 0] } };

function live(relay, clock, { name = "Ana", dev = device(), k = keys } = {}) {
  return new Live({ relay: "wss://relay.example/", space: SPACE, keys: k, me: { device: dev, name }, socket: () => relay.connect(), now: clock.now, schedule: clock.schedule });
}

/** Two connected devices, both showing board B1. */
async function two() {
  const relay = new FakeRelay(), clock = new Clock();
  const a = live(relay, clock, { name: "Ana Lima" }), b = live(relay, clock, { name: "Bo" });
  a.connect();
  await relay.run();
  b.connect();
  await relay.run();
  a.setPresence({ board: "B1", selection: [] });
  b.setPresence({ board: "B1", selection: [] });
  await relay.run();
  return { relay, clock, a, b };
}

test("people see each other and what they have selected", async () => {
  const { relay, a, b } = await two();
  assert.ok(a.connected && b.connected);
  a.setPresence({ board: "B1", selection: ["c1"] });
  await relay.run();
  assert.deepEqual(b.people("B1").map((p) => p.name), ["Ana Lima"]);
  assert.equal(initials(b.people("B1")[0].name), "AL");
  assert.equal(b.people("B1")[0].colour, colourOf(a.me.device));
  assert.equal(b.selections("B1").get("c1").name, "Ana Lima");
  assert.deepEqual(a.people("B1").map((p) => p.name), ["Bo"]);
  assert.deepEqual(a.people("B2"), []);
  assert.equal(initials(" "), "?");
  assert.ok(PALETTE.includes(colourOf(device())));
});

test("cursors go at most twenty times a second", async () => {
  const { relay, clock, a, b } = await two();
  const before = relay.frames.length;
  a.sendCursor("B1", 1, 1);
  a.sendCursor("B1", 2, 2);
  a.sendCursor("B1", 3, 3);
  await relay.run();
  assert.equal(relay.frames.length, before + 1);
  assert.deepEqual(b.cursors("B1").map((c) => c.x), [1]);
  clock.advance(50);
  await relay.run();
  assert.equal(relay.frames.length, before + 2);
  assert.deepEqual(b.cursors("B1").map((c) => c.x), [3]);
  a.sendCursor("B1", null, null);
  clock.advance(50);
  await relay.run();
  assert.deepEqual(b.cursors("B1"), []);
});

test("a still cursor fades after a minute", async () => {
  const { relay, clock, a, b } = await two();
  a.sendCursor("B1", 1, 1);
  await relay.run();
  for (let i = 0; i < 2; i++) {
    clock.advance(29_000);
    a.tick();
    await relay.run();
  }
  b.tick();
  assert.equal(b.cursors("B1").length, 1);
  clock.advance(3000);
  b.tick();
  assert.deepEqual(b.cursors("B1"), []);
  assert.equal(b.people("B1").length, 1);
});

test("holds are all or none and show who holds", async () => {
  const { relay, a, b } = await two();
  let refused = null;
  b.onRefused = (ids) => (refused = ids);
  a.hold(["x", "y"]);
  await relay.run();
  assert.deepEqual([...b.taken()].sort(), ["x", "y"]);
  assert.equal(b.holderOf("x").name, "Ana Lima");
  assert.equal(a.taken().size, 0);
  b.hold(["y", "z"]);
  await relay.run();
  assert.deepEqual([...refused], ["y"]);
  b.release();
  a.release();
  await relay.run();
  assert.equal(b.taken().size, 0);
  assert.equal(a.mine.size, 0);
});

test("live edits show as an overlay", async () => {
  const { relay, a, b } = await two();
  a.hold(["c1"]);
  a.sendLive("B1", moved, { id: "c1", back: false, at: 3 });
  await relay.run();
  assert.deepEqual(Object.fromEntries(b.overlay("B1")), moved);
  assert.equal(b.overlay("B2").size, 0);
  assert.deepEqual(b.carets("B1").map(({ id, back, at }) => ({ id, back, at })), [{ id: "c1", back: false, at: 3 }]);
});

test("the overlay stays until the pull reaches the pushed version", async () => {
  const { relay, a, b } = await two();
  const pushes = [];
  b.onPushed = (v) => pushes.push(v);
  a.hold(["c1"]);
  a.sendLive("B1", moved, null);
  await relay.run();
  a.sendPushed(7);
  a.release();
  await relay.run();
  assert.deepEqual(pushes, [7]);
  assert.deepEqual(Object.fromEntries(b.overlay("B1")), moved);
  b.noteCursor(6);
  assert.equal(b.overlay("B1").size, 1);
  b.noteCursor(7);
  assert.equal(b.overlay("B1").size, 0);
});

test("a hold that ends without a push drops the overlay", async () => {
  const { relay, a, b } = await two();
  a.hold(["c1"]);
  a.sendLive("B1", moved, { id: "c1", back: false, at: 0 });
  await relay.run();
  relay.lapse(relay.sockets[0]);
  await relay.run();
  assert.equal(b.taken().size, 0);
  assert.equal(b.overlay("B1").size, 0);
  assert.deepEqual(b.carets("B1"), []);
});

test("another connection of the same device still holds", async () => {
  const relay = new FakeRelay(), clock = new Clock();
  const dev = device();
  const a = live(relay, clock, { dev }), a2 = live(relay, clock, { dev });
  a.connect();
  a2.connect();
  await relay.run();
  a.setPresence({ board: "B1", selection: [] });
  a.hold(["c1"]);
  await relay.run();
  assert.deepEqual([...a2.taken()], ["c1"]);
  assert.deepEqual(a2.people("B1"), []);
});

test("a peer that leaves or falls silent is gone", async () => {
  const { relay, clock, a, b } = await two();
  a.hold(["c1"]);
  await relay.run();
  a.close();
  await relay.run();
  assert.deepEqual(b.people("B1"), []);
  assert.equal(b.taken().size, 0);
  const c = live(relay, clock, { name: "Cy" });
  c.connect();
  await relay.run();
  c.setPresence({ board: "B1", selection: [] });
  await relay.run();
  assert.deepEqual(b.people("B1").map((p) => p.name), ["Cy"]);
  clock.advance(31_000);
  b.tick();
  assert.deepEqual(b.people("B1"), []);
});

test("presence repeats and a holder keeps sending live", async () => {
  const { relay, clock, a } = await two();
  const me = relay.sockets[0].id;
  const bodies = () => relay.frames.filter((f) => f.from === me && f.text.includes('"body"')).length;
  a.hold(["c1"]);
  a.sendLive("B1", moved, null);
  await relay.run();
  const start = bodies();
  clock.advance(5000);
  a.tick();
  await relay.run();
  assert.equal(bodies(), start + 1);
  clock.advance(10_000);
  a.tick();
  await relay.run();
  assert.equal(bodies(), start + 3);
  a.release();
  clock.advance(5000);
  a.tick();
  await relay.run();
  assert.equal(bodies(), start + 3);
});

test("a reconnect asks for its holds again", async () => {
  const { relay, clock, a, b } = await two();
  let refused = null;
  a.onRefused = (ids) => (refused = ids);
  a.hold(["c1"]);
  await relay.run();
  relay.kick(relay.sockets[0], 1006);
  await relay.run();
  assert.ok(!a.connected);
  assert.equal(b.taken().size, 0);
  assert.deepEqual([...a.mine], ["c1"]);
  b.hold(["c1"]);
  await relay.run();
  clock.advance(1000);
  await relay.run();
  assert.ok(a.connected);
  assert.deepEqual([...refused], ["c1"]);
});

test("reconnects back off and stop for a wrong token", async () => {
  const relay = new FakeRelay(), clock = new Clock();
  const a = live(relay, clock);
  a.connect();
  await relay.run();
  relay.kick(relay.sockets[0], 1006);
  await relay.run();
  clock.advance(1000);
  relay.kick(relay.sockets[0], 1006);
  await relay.run();
  clock.advance(1900);
  await relay.run();
  assert.equal(relay.sockets.length, 0);
  clock.advance(100);
  await relay.run();
  assert.ok(a.connected);

  const wrong = new FakeRelay();
  wrong.token = "someone else's";
  let unauthorized = false;
  const b = live(wrong, clock);
  b.onUnauthorized = () => (unauthorized = true);
  b.connect();
  await wrong.run();
  clock.advance(60_000);
  await wrong.run();
  assert.ok(unauthorized && !b.connected);
  assert.equal(wrong.sockets.length, 0);
});

test("bodies sealed for another space are dropped", async () => {
  const relay = new FakeRelay(), clock = new Clock();
  // the same secret, so the same token and key, but another space: its bodies do not open here
  const stranger = live(relay, clock, { k: await SpaceKeys.create(randomBytes(16), decode("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")) });
  const b = live(relay, clock);
  stranger.connect();
  b.connect();
  await relay.run();
  stranger.setPresence({ board: "B1", selection: [] });
  await relay.run();
  assert.ok(stranger.connected && b.connected);
  assert.deepEqual(b.people("B1"), []);
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `node --test web/test/live.test.js`
Expected: FAIL with `Cannot find module '…/web/sync/live.js'`.

- [ ] **Step 4: Write `Live`**

`web/sync/live.js`:

```js
// A space's live layer over its relay: who is here and where, what they hold, and their edits as they happen, as
// BreezyKit's Live; see the multiplayer design. Bodies are sealed with the space key, so the relay reads none of them.
import { encode, decode } from "./base64.js";
import { LIVE_FIELDS } from "./overlay.js";

export const PALETTE = ["#e5484d", "#f76b15", "#12a594", "#8e4ec6", "#3e63dd", "#e93d82", "#ad7f58", "#00a2c7"];
export const SEND_MS = 50;
export const HEARTBEAT_MS = 5_000;
export const PRESENCE_MS = 15_000;
export const GONE_MS = 30_000;
export const IDLE_CURSOR_MS = 60_000;
export const MAX_BACKOFF_MS = 30_000;
const MAX_FRAME = 65_536;
const enc = new TextEncoder(), dec = new TextDecoder();

export const colourOf = (device) => PALETTE[(decode(device)?.[0] ?? 0) % PALETTE.length];

/** One or two letters for avatars. */
export function initials(name) {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0].toUpperCase()).join("") || "?";
}

const personOf = (device, name) => ({ device, name, colour: colourOf(device) });
const pointOf = (c) => (c && typeof c.board === "string" && Number.isFinite(c.x) && Number.isFinite(c.y) ? { board: c.board, x: c.x, y: c.y } : null);
const caretOf = (c) =>
  c && typeof c.id === "string" && typeof c.back === "boolean" && Number.isInteger(c.at) && c.at >= 0 ? { id: c.id, back: c.back, at: c.at } : null;
const pick = (f) => Object.fromEntries(Object.entries(f).filter(([k]) => k === "kind" || LIVE_FIELDS.includes(k)));
const holdsFrom = (h) => new Map(Object.entries(h ?? {}).filter(([, ids]) => Array.isArray(ids)).map(([k, ids]) => [k, new Set(ids)]));

/** Runs the latest `go` at most every SEND_MS: at once when it may, else once when it may again. */
class Gate {
  constructor(live) {
    this.live = live;
    this.sent = -Infinity;
    this.queued = false;
    this.go = null;
  }

  run(go) {
    this.go = go;
    const wait = SEND_MS - (this.live.now() - this.sent);
    if (wait <= 0) return this.fire();
    if (this.queued) return;
    this.queued = true;
    this.live.schedule(wait, () => {
      this.queued = false;
      this.fire();
    });
  }

  fire() {
    this.sent = this.live.now();
    this.go();
  }
}

export class Live {
  constructor({ relay, space, keys, me, socket = (url) => new WebSocket(url), now = () => Date.now(), schedule = (ms, fn) => setTimeout(fn, ms) }) {
    Object.assign(this, { relay, space, keys, me, makeSocket: socket, now, schedule });
    this.ws = null;
    this.id = null;
    this.wanted = false;
    this.failures = 0;
    /** Connection id → { person, board, selection, cursor, cursorAt, heard, overlay: Map, overlayBoard, caret, awaiting }. */
    this.peers = new Map();
    /** Connection id → the ids it holds. */
    this.holds = new Map();
    /** What this connection holds, or has asked to. */
    this.mine = new Set();
    this.presence = { board: null, selection: [] };
    this.cursor = null;
    this.cursorBoard = "";
    this.presenceSent = -Infinity;
    this.cursorGate = new Gate(this);
    this.liveGate = new Gate(this);
    this.lastLive = null;
    this.storeCursor = 0;
    this.out = Promise.resolve();
    this.in = Promise.resolve();
    this.onChange = () => {};
    this.onPushed = () => {};
    this.onRefused = () => {};
    this.onUnauthorized = () => {};
  }

  get connected() {
    return this.id !== null;
  }

  connect() {
    this.wanted = true;
    if (!this.ws) this.open();
  }

  close() {
    this.wanted = false;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.reset();
  }

  open() {
    const url = new URL(this.relay);
    url.searchParams.set("space", this.space);
    const ws = this.makeSocket(url.href);
    this.ws = ws;
    ws.onopen = () => ws === this.ws && this.frame({ t: "auth", token: encode(this.keys.token) });
    ws.onmessage = (e) => {
      if (ws === this.ws) this.in = this.in.then(() => this.received(String(e.data))).catch(() => {});
    };
    ws.onclose = (e) => {
      if (ws !== this.ws) return;
      this.ws = null;
      this.reset();
      if (e.code === 4001) return this.onUnauthorized();
      if (!this.wanted) return;
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.failures++);
      this.schedule(delay, () => this.wanted && !this.ws && this.open());
    };
  }

  reset() {
    const had = this.connected || this.peers.size || this.holds.size;
    this.id = null;
    this.peers.clear();
    this.holds.clear();
    if (had) this.onChange();
  }

  /** A frame to the relay, after everything sent before it. */
  frame(f) {
    const ws = this.ws;
    this.out = this.out.then(() => {
      if (ws === this.ws && ws.readyState === 1) ws.send(JSON.stringify(f));
    });
  }

  /** A sealed body to everyone else, or to connection `to`. */
  send(body, to) {
    if (!this.connected) return;
    const ws = this.ws;
    this.out = this.out.then(async () => {
      const sealed = encode(await this.keys.sealLive(enc.encode(JSON.stringify(body))));
      if (sealed.length > MAX_FRAME - 100 || ws !== this.ws || ws.readyState !== 1) return;
      ws.send(JSON.stringify(to ? { to, body: sealed } : { body: sealed }));
    }).catch(() => {});
  }

  async received(text) {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    switch (m?.t) {
      case "welcome":
        this.id = m.id;
        this.failures = 0;
        this.holds = holdsFrom(m.holds);
        this.sendPresence();
        if (this.mine.size) this.frame({ t: "hold", ids: [...this.mine].sort() });
        return this.onChange();
      case "join":
        return this.sendPresence(m.id);
      case "leave":
        this.peers.delete(m.id);
        this.holds.delete(m.id);
        return this.onChange();
      case "holds":
        this.holds = holdsFrom(m.holds);
        this.dropReleased();
        return this.onChange();
      case "refused":
        if (Array.isArray(m.ids) && m.ids.length) this.onRefused(new Set(m.ids));
        return;
    }
    if (typeof m?.from !== "string" || typeof m.body !== "string") return;
    let b;
    try {
      b = JSON.parse(dec.decode(await this.keys.openLive(decode(m.body))));
    } catch {
      return;
    }
    if (this.connected) this.heard(m.from, b);
  }

  heard(from, b) {
    const now = this.now();
    const p = this.peers.get(from) ?? { person: null, board: null, selection: [], cursor: null, cursorAt: 0, overlay: new Map(), overlayBoard: null, caret: null, awaiting: 0 };
    p.heard = now;
    switch (b?.t) {
      case "presence":
        if (decode(b.device)?.length !== 16) return;
        p.person = personOf(b.device, String(b.name ?? "").slice(0, 100));
        p.board = typeof b.board === "string" ? b.board : null;
        p.selection = Array.isArray(b.selection) ? b.selection.filter((x) => typeof x === "string") : [];
        // a cursor not heard yet, as a newcomer gets it; later ones come as cursor messages, so a faded one stays faded
        if ("cursor" in b && !p.cursorAt) [p.cursor, p.cursorAt] = [pointOf(b.cursor), now];
        break;
      case "cursor":
        [p.cursor, p.cursorAt] = [pointOf(b), now];
        break;
      case "live":
        p.overlayBoard = typeof b.board === "string" ? b.board : null;
        for (const [id, f] of Object.entries(b.items ?? {})) if (f && typeof f === "object") p.overlay.set(id, { ...p.overlay.get(id), ...pick(f) });
        p.caret = caretOf(b.caret);
        break;
      case "pushed":
        if (!Number.isInteger(b.version) || b.version < 0) return;
        p.awaiting = Math.max(p.awaiting, b.version);
        break;
      default:
        return;
    }
    this.peers.set(from, p);
    if (b.t === "pushed") this.onPushed(b.version);
    this.dropReleased();
    this.onChange();
  }

  /** Overlays of items no longer held go, unless their holder pushed a version not pulled yet. */
  dropReleased() {
    for (const [conn, p] of this.peers) {
      if (p.awaiting > this.storeCursor) continue;
      p.awaiting = 0;
      const held = this.holds.get(conn) ?? new Set();
      for (const id of [...p.overlay.keys()]) if (!held.has(id)) p.overlay.delete(id);
      if (!held.size) p.caret = null;
    }
  }

  /** The store pulled up to `cursor`: overlays waiting for it can go. */
  noteCursor(cursor) {
    this.storeCursor = Math.max(this.storeCursor, cursor);
    this.dropReleased();
    this.onChange();
  }

  /** About once a second: forgets the silent, fades still cursors, repeats presence and a holder's live fields. */
  tick() {
    const now = this.now();
    let changed = false;
    for (const [conn, p] of this.peers) {
      if (now - p.heard > GONE_MS) {
        this.peers.delete(conn);
        changed = true;
      } else if (p.cursor && now - p.cursorAt > IDLE_CURSOR_MS) {
        p.cursor = null;
        changed = true;
      }
    }
    if (this.connected && now - this.presenceSent >= PRESENCE_MS) this.sendPresence();
    if (this.connected && this.mine.size && this.lastLive && now - this.liveGate.sent >= HEARTBEAT_MS) {
      this.liveGate.sent = now;
      this.send(this.lastLive);
    }
    if (changed) this.onChange();
  }

  setMe(me) {
    if (me.device === this.me.device && me.name === this.me.name) return;
    this.me = me;
    this.sendPresence();
  }

  setPresence({ board, selection }) {
    if (board === this.presence.board && JSON.stringify(selection) === JSON.stringify(this.presence.selection)) return;
    this.presence = { board, selection };
    this.sendPresence();
  }

  sendPresence(to) {
    if (!this.connected) return;
    if (!to) this.presenceSent = this.now();
    const { device, name } = this.me;
    this.send({ t: "presence", device, name, colour: colourOf(device), board: this.presence.board, selection: this.presence.selection, cursor: this.cursor }, to);
  }

  /** This device's pointer on `board`; null x and y hide it. At most every 50 ms, and the last one always goes. */
  sendCursor(board, x, y) {
    this.cursor = Number.isFinite(x) && Number.isFinite(y) ? { board, x, y } : null;
    this.cursorBoard = board;
    this.cursorGate.run(() => this.send({ t: "cursor", board: this.cursorBoard, x: this.cursor?.x ?? null, y: this.cursor?.y ?? null }));
  }

  /** Asks the relay for `ids`; `onRefused` tells if someone else has any. Asked again after a reconnect. */
  hold(ids) {
    const fresh = [...ids].filter((id) => !this.mine.has(id));
    if (!fresh.length) return;
    for (const id of fresh) this.mine.add(id);
    if (this.connected) this.frame({ t: "hold", ids: fresh.sort() });
  }

  release() {
    if (!this.mine.size) return;
    this.mine.clear();
    this.lastLive = null;
    if (this.connected) this.frame({ t: "release" });
  }

  /** What the gesture under way changed of what it holds; at most every 50 ms, and repeated every 5 s while held. */
  sendLive(board, items, caret = null) {
    this.lastLive = { t: "live", board, items, caret };
    this.liveGate.run(() => this.lastLive && this.send(this.lastLive));
  }

  sendPushed(version) {
    this.send({ t: "pushed", version });
  }

  /** Ids another connection holds. */
  taken() {
    const out = new Set();
    for (const [conn, ids] of this.holds) if (conn !== this.id) for (const id of ids) out.add(id);
    return out;
  }

  /** Who holds `id`, if another connection does. */
  holderOf(id) {
    for (const [conn, ids] of this.holds) if (conn !== this.id && ids.has(id)) return this.peers.get(conn)?.person ?? personOf("", "");
    return null;
  }

  overlay(board) {
    const out = new Map();
    for (const p of this.peers.values()) if (p.overlayBoard === board) for (const [id, f] of p.overlay) out.set(id, f);
    return out;
  }

  cursors(board) {
    return [...this.peers].filter(([, p]) => p.person && p.cursor?.board === board).map(([key, p]) => ({ key, person: p.person, x: p.cursor.x, y: p.cursor.y }));
  }

  carets(board) {
    return [...this.peers].filter(([, p]) => p.person && p.caret && p.overlayBoard === board).map(([key, p]) => ({ key, person: p.person, ...p.caret }));
  }

  /** The people on `board`, once each and not this device's, by name. */
  people(board) {
    const byDevice = new Map();
    for (const p of this.peers.values()) if (p.person && p.board === board && p.person.device !== this.me.device) byDevice.set(p.person.device, p.person);
    return [...byDevice.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** What the people on `board` have selected, and who. */
  selections(board) {
    const out = new Map();
    for (const p of this.peers.values()) if (p.person && p.board === board) for (const id of p.selection) out.set(id, p.person);
    return out;
  }
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `node --test web/test/live.test.js`
Expected: PASS, 13 tests.

- [ ] **Step 6: Run every web test**

Run: `node --test web/test/*.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web
git commit -m "Add Live to the web app: presence, cursors, holds and live edits over the relay"
```

---

### Task 7: Live layers for the Mac's spaces

**Files:**
- Modify: `BreezyKit/Sources/BreezyKit/Spaces.swift`
- Test: `BreezyKit/Tests/BreezyKitTests/SpacesTests.swift`

**Interfaces:**
- Consumes: `Live`, `Person`, `LiveSocket` (Task 5); `SyncEngine.onRelay`, `onPushed`, `onPulled`, `lastSynced` (Task 3); `FakeRelay` (Task 5).
- Produces:
  - `Spaces.init(directory: URL, me: Person = Person(device: newID(), name: ""), transport: …? = nil, socket: (@MainActor (URL) -> LiveSocket)? = nil)`
  - `Spaces.me: Person` (settable; passes to every live layer)
  - `Spaces.Group.live: Live?` (public get)
  - `Spaces.onLive: ((Group) -> Void)?`: a group's live layer appeared, went, or heard something
  - `Spaces.onRefused: ((Group, Set<String>) -> Void)?`
  - `Spaces.syncAll(polling: Bool = false, now: Date = Date())`: when `polling`, skips a space whose live layer is connected and that synced less than 30 s ago.

- [ ] **Step 1: Write the failing tests**

In `SpacesTests.swift` add:

```swift
@MainActor private func liveSpaces(_ servers: Servers, _ relay: FakeRelay, dir: URL = tempDirectory()) throws -> Spaces {
  try Spaces(directory: dir, me: Person(device: newID(), name: "Ana"), transport: servers.transport, socket: { relay.connect($0) })
}

@MainActor @Test func aRelayGivesTheSpaceALiveLayer() async throws {
  let servers = Servers(), relay = FakeRelay()
  let spaces = try liveSpaces(servers, relay)
  var heard = 0
  spaces.onLive = { _ in heard += 1 }
  let g = spaces.newSpace(server: testServer, name: "Work")
  servers.server(g.space!).relay = "wss://relay.example/"
  await g.engine.sync()
  #expect(g.live?.relay == "wss://relay.example/")
  #expect(g.live?.space == g.space)
  #expect(heard >= 1)
  spaces.me = Person(device: spaces.me.device, name: "Ana Lima")
  #expect(g.live?.me.name == "Ana Lima")
  servers.server(g.space!).relay = nil
  await g.engine.sync()
  #expect(g.live == nil)
}

@MainActor @Test func withoutARelayThereIsNoLiveLayer() async throws {
  let servers = Servers(), relay = FakeRelay()
  let spaces = try liveSpaces(servers, relay)
  let g = spaces.newSpace(server: testServer, name: "Work")
  await g.engine.sync()
  #expect(g.live == nil)
  let before = g.engine.lastSynced!
  spaces.syncAll(polling: true, now: before.addingTimeInterval(5))
  try await Task.sleep(for: .milliseconds(100))
  #expect(g.engine.lastSynced! > before)
}

@MainActor @Test func whileLiveIsConnectedPollingWaitsThirtySeconds() async throws {
  let servers = Servers(), relay = FakeRelay()
  let spaces = try liveSpaces(servers, relay)
  let g = spaces.newSpace(server: testServer, name: "Work")
  servers.server(g.space!).relay = "wss://relay.example/"
  await g.engine.sync()
  g.live!.connect()
  relay.run()
  #expect(g.live!.connected)
  let before = g.engine.lastSynced!
  spaces.syncAll(polling: true, now: before.addingTimeInterval(10))
  try await Task.sleep(for: .milliseconds(100))
  #expect(g.engine.lastSynced == before)
  spaces.syncAll(polling: true, now: before.addingTimeInterval(31))
  try await Task.sleep(for: .milliseconds(100))
  #expect(g.engine.lastSynced! > before)
}

@MainActor @Test func aPushIsAnnouncedAndAnnouncedPushesArePulledAtOnce() async throws {
  let servers = Servers(), relay = FakeRelay()
  let a = try liveSpaces(servers, relay), b = try liveSpaces(servers, relay)
  let ga = a.newSpace(server: testServer, name: "Work")
  servers.server(ga.space!).relay = "wss://relay.example/"
  await ga.engine.sync()
  let gb = b.join(ga.store.invite!)
  await gb.engine.sync()
  ga.live!.connect()
  gb.live!.connect()
  relay.run()
  let id = ga.store.createBoard(title: "Plans")
  await ga.engine.sync()
  relay.run()
  try await Task.sleep(for: .milliseconds(100))
  #expect(gb.store.title(of: id) == "Plans")
}

@MainActor @Test func leavingASpaceClosesItsLiveLayer() async throws {
  let servers = Servers(), relay = FakeRelay()
  let spaces = try liveSpaces(servers, relay)
  let g = spaces.newSpace(server: testServer, name: "Work")
  servers.server(g.space!).relay = "wss://relay.example/"
  await g.engine.sync()
  g.live!.connect()
  relay.run()
  spaces.leave(g)
  relay.run()
  #expect(relay.sockets.isEmpty)
}
```

(`Servers` hands each call a new `FakeTransport` on the same `FakeServer`; `FakeServer.relay` is from Task 3.)

- [ ] **Step 2: Run them to see them fail**

Run: `swift test --package-path BreezyKit --filter SpacesTests`
Expected: build errors: `extra arguments 'me', 'socket'`, `value of type 'Spaces.Group' has no member 'live'`.

- [ ] **Step 3: Give each space its live layer**

In `Spaces.swift`:

Add to `Group`:

```swift
    /// The space's live layer, once its server names a relay.
    public internal(set) var live: Live?
```

Add properties to `Spaces` after `flushLocal`:

```swift
  /// This device as others in its spaces see it.
  public var me: Person { didSet { for g in spaces { g.live?.me = me } } }
  /// After a group's live layer appears, goes, or hears something.
  public var onLive: ((Group) -> Void)?
  /// The relay refused holds the group's live layer asked for.
  public var onRefused: ((Group, Set<String>) -> Void)?
  private let socket: (@MainActor (URL) -> LiveSocket)?
```

Change the initialiser's signature and its first lines to:

```swift
  public init(
    directory: URL, me: Person = Person(device: newID(), name: ""), transport: ((SpaceState, SpaceKeys) -> Transport?)? = nil,
    socket: (@MainActor (URL) -> LiveSocket)? = nil
  ) throws {
    self.directory = directory.appendingPathComponent("Spaces")
    self.me = me
    self.transport = transport
    self.socket = socket
```

In `make(_:)`, before `file.onError = …`, add:

```swift
    engine.onRelay = { [weak self, weak g] relay in
      guard let self, let g else { return }
      setRelay(relay, for: g)
    }
    engine.onPushed = { [weak g] in g?.live?.sendPushed($0) }
    engine.onPulled = { [weak g] in g?.live?.noteCursor($0) }
```

Add after `make(_:)`:

```swift
  /// Replaces the group's live layer with one on `relay`, or none.
  private func setRelay(_ relay: String?, for g: Group) {
    guard relay != g.live?.relay else { return }
    g.live?.close()
    g.live = nil
    if let relay, let space = g.space, let keys = try? SpaceKeys(state: g.store.state) {
      let live = socket.map { Live(relay: relay, space: space, keys: keys, me: me, socket: $0) } ?? Live(relay: relay, space: space, keys: keys, me: me)
      live.onPushed = { [weak g] _ in
        guard let g else { return }
        Task { await g.engine.sync() }
      }
      live.onChange = { [weak self, weak g] in
        guard let self, let g else { return }
        onLive?(g)
      }
      live.onRefused = { [weak self, weak g] ids in
        guard let self, let g else { return }
        onRefused?(g, ids)
      }
      // a refused token is the server's to report: its 401 shows "Not in this space any more"
      live.onUnauthorized = { [weak g] in
        guard let g else { return }
        Task { await g.engine.sync() }
      }
      g.live = live
    }
    onLive?(g)
  }
```

In `leave(_:)`, after `group.engine.onStatus = nil`, add:

```swift
    group.live?.close()
    group.live = nil
```

Replace `syncAll()` with:

```swift
  /// A cycle for every space, each on its own. When `polling`, a space whose live layer is connected waits 30 s
  /// between cycles: its relay announces what others push.
  public func syncAll(polling: Bool = false, now: Date = Date()) {
    for g in spaces {
      if polling, g.live?.connected == true, let last = g.engine.lastSynced, now.timeIntervalSince(last) < 30 { continue }
      Task { await g.engine.sync() }
    }
  }
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `swift test --package-path BreezyKit`
Expected: PASS, every test.

- [ ] **Step 5: Commit**

```bash
git add BreezyKit
git commit -m "Give each space a live layer once its server names a relay"
```

---

### Task 8: Live layers for the web app's spaces

**Files:**
- Modify: `web/sync/spaces.js`
- Test: `web/test/spaces.test.js`

**Interfaces:**
- Consumes: `Live`, `colourOf` (Task 6); `SyncEngine.onRelay`, `onPushed`, `onPulled`, `lastCycle`, `keysOf` (Task 4 and before); `FakeRelay` (Task 6).
- Produces:
  - `new Spaces(storage, states, { transport, readOnly, socket, now })`; `Spaces.open(storage, options)` passes options on
  - `spaces.me`: `{ device, name }`, from IndexedDB key `me`, made and saved when missing
  - `async spaces.setName(name)`: saves and passes to every live layer
  - `group.live`: a `Live` or null
  - `spaces.onLive(group)`, `spaces.onRefused(group, ids)`
  - `spaces.syncAll({ polling = false } = {})`: when `polling`, skips a space whose live layer is connected and whose last cycle was less than 30 s ago

- [ ] **Step 1: Write the failing tests**

In `web/test/spaces.test.js`, add to the imports:

```js
import { FakeRelay } from "./helpers/fake-relay.js";
```

and add:

```js
async function liveSpaces(srv, relay, storage = new MemoryStorage()) {
  return Spaces.open(storage, { transport: srv.transport, socket: () => relay.connect() });
}

/** Lets the live layer appear: it needs the space's keys, which take a moment. */
const settleLive = () => new Promise((r) => setTimeout(r, 20));

test("a device has a name and an id, kept", async () => {
  const storage = new MemoryStorage();
  const spaces = await Spaces.open(storage);
  assert.equal(spaces.me.name, "");
  assert.equal(storage.data.get("me").device, spaces.me.device);
  await spaces.setName("Ana");
  const again = await Spaces.open(storage);
  assert.deepEqual(again.me, { device: spaces.me.device, name: "Ana" });
});

test("a relay gives the space a live layer", async () => {
  const srv = servers(), relay = new FakeRelay();
  const spaces = await liveSpaces(srv, relay);
  await spaces.setName("Ana");
  let heard = 0;
  spaces.onLive = () => heard++;
  const g = spaces.newSpace(SERVER, "Work");
  srv.server(g.space).relay = "wss://relay.example/";
  await g.engine.sync();
  await settleLive();
  assert.equal(g.live.relay, "wss://relay.example/");
  assert.equal(g.live.me.name, "Ana");
  assert.ok(heard >= 1);
  await spaces.setName("Ana Lima");
  assert.equal(g.live.me.name, "Ana Lima");
  srv.server(g.space).relay = null;
  await g.engine.sync();
  await settleLive();
  assert.equal(g.live, null);
});

test("without a relay there is no live layer", async () => {
  const srv = servers(), relay = new FakeRelay();
  const spaces = await liveSpaces(srv, relay);
  const g = spaces.newSpace(SERVER, "Work");
  await g.engine.sync();
  await settleLive();
  assert.equal(g.live, null);
  const before = g.engine.lastCycle;
  await new Promise((r) => setTimeout(r, 5));
  spaces.syncAll({ polling: true });
  await g.engine.running;
  assert.ok(g.engine.lastCycle > before);
});

test("while live is connected, polling waits 30 s", async () => {
  const srv = servers(), relay = new FakeRelay();
  let now = 1_000_000;
  const spaces = await Spaces.open(new MemoryStorage(), { transport: srv.transport, socket: () => relay.connect(), now: () => now });
  const g = spaces.newSpace(SERVER, "Work");
  srv.server(g.space).relay = "wss://relay.example/";
  await g.engine.sync();
  await settleLive();
  g.live.connect();
  await relay.run();
  assert.ok(g.live.connected);
  const before = g.engine.lastCycle;
  now += 10_000;
  spaces.syncAll({ polling: true });
  assert.equal(g.engine.running, null);
  now += 21_000;
  spaces.syncAll({ polling: true });
  await g.engine.running;
  assert.ok(g.engine.lastCycle > before);
});

test("a push is announced, and an announced push is pulled at once", async () => {
  const srv = servers(), relay = new FakeRelay();
  const a = await liveSpaces(srv, relay), b = await liveSpaces(srv, relay);
  const ga = a.newSpace(SERVER, "Work");
  srv.server(ga.space).relay = "wss://relay.example/";
  await ga.engine.sync();
  const gb = b.join(ga.store.invite);
  await gb.engine.sync();
  await settleLive();
  ga.live.connect();
  gb.live.connect();
  await relay.run();
  const id = ga.store.createBoard("Plans");
  await ga.engine.sync();
  await relay.run();
  await gb.engine.running;
  assert.equal(gb.store.title(id), "Plans");
});

test("leaving a space closes its live layer", async () => {
  const srv = servers(), relay = new FakeRelay();
  const spaces = await liveSpaces(srv, relay);
  const g = spaces.newSpace(SERVER, "Work");
  srv.server(g.space).relay = "wss://relay.example/";
  await g.engine.sync();
  await settleLive();
  g.live.connect();
  await relay.run();
  await spaces.leave(g);
  await relay.run();
  assert.equal(relay.sockets.length, 0);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test web/test/spaces.test.js`
Expected: FAIL: `spaces.me` undefined, `g.live` undefined.

- [ ] **Step 3: Give each space its live layer**

In `web/sync/spaces.js`, change the imports to:

```js
import { Store, withFreshIDs } from "./store.js";
import { Saver } from "./saver.js";
import { SyncEngine } from "./engine.js";
import { Live } from "./live.js";
import { encode, decode } from "./base64.js";
import { randomBytes } from "./crypto.js";
```

In `Group`'s constructor add `this.live = null;`:

```js
class Group {
  constructor(key, store, engine, saver) {
    Object.assign(this, { key, store, engine, saver });
    /** The space's live layer, once its server names a relay. */
    this.live = null;
  }
```

Change the `Spaces` constructor's signature and add, before `this.local = …`:

```js
  constructor(storage, states = {}, { transport, readOnly = false, socket, now } = {}) {
    this.storage = storage;
    this.transport = transport;
    this.socket = socket;
    this.now = now;
    this.readOnly = readOnly;
    this.fresh = false;
    this.lastServer = typeof states.server === "string" ? states.server : null;
    const me = states.me;
    /** This device as others in its spaces see it. */
    this.me = decode(me?.device)?.length === 16 && typeof me.name === "string" ? { device: me.device, name: me.name } : { device: encode(randomBytes(16)), name: "" };
    if (!me && !readOnly) storage.save("me", this.me).catch(() => {});
    /** After a group's live layer appears, goes, or hears something. */
    this.onLive = () => {};
    /** The relay refused holds a group's live layer asked for. */
    this.onRefused = () => {};
```

(keep the existing `onChange`, `onStatus`, `onSaveError`, `flushLocal` lines and the rest.)

In `make(key, store)`, change the engine line and add the hooks before `return g;`:

```js
    const engine = new SyncEngine(store, { ...(this.transport ? { transport: this.transport } : {}), ...(this.now ? { now: this.now } : {}) });
```

```js
    engine.onRelay = (relay) => this.setRelay(g, relay);
    engine.onPushed = (version) => g.live?.sendPushed(version);
    engine.onPulled = (cursor) => g.live?.noteCursor(cursor);
```

Add methods after `make`:

```js
  /** Replaces the group's live layer with one on `relay`, or none; the keys take a moment. */
  async setRelay(g, relay) {
    if (relay === (g.live?.relay ?? null)) return;
    g.live?.close();
    g.live = null;
    if (relay && g.space) {
      const keys = await g.engine.keysOf(g.store.state);
      if (g.engine.relay !== relay || g.live || !this.spaces.includes(g)) return;
      const live = new Live({ relay, space: g.space, keys, me: this.me, ...(this.socket ? { socket: this.socket } : {}) });
      live.onPushed = () => g.engine.sync();
      live.onChange = () => this.onLive(g);
      live.onRefused = (ids) => this.onRefused(g, ids);
      // a refused token is the server's to report: its 401 shows "Not in this space any more"
      live.onUnauthorized = () => g.engine.sync();
      g.live = live;
    }
    this.onLive(g);
  }

  /** This device's name, kept and shown to the others in every space. */
  async setName(name) {
    this.me = { ...this.me, name };
    for (const g of this.spaces) g.live?.setMe(this.me);
    if (!this.readOnly) await this.storage.save("me", this.me).catch(() => {});
  }
```

In `leave(group)`, after `group.store.onDirty = …`, add:

```js
    group.live?.close();
    group.live = null;
```

Replace `syncAll()` with:

```js
  /** A cycle for every space, each on its own. When `polling`, a space whose live layer is connected waits 30 s between
   * cycles: its relay announces what others push. */
  syncAll({ polling = false } = {}) {
    const now = (this.now ?? Date.now)();
    for (const g of this.spaces) {
      if (polling && g.live?.connected && now - g.engine.lastCycle < 30_000) continue;
      g.engine.sync();
    }
  }
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --test web/test/*.test.js`
Expected: PASS, every test.

- [ ] **Step 5: Commit**

```bash
git add web
git commit -m "Give each space a live layer in the web app, and keep the device's name"
```

---
### Task 9: People on the web: names, connections, cursors, who's here

**Files:**
- Create: `web/presence.js`
- Modify: `web/index.html`, `web/style.css`, `web/app.js`, `web/view.js`, `web/main.js`, `web/ui.js`, `web/library.js`

**Interfaces:**
- Consumes: `spaces.me`, `setName`, `group.live`, `onLive`, `syncAll({ polling })` (Task 8); `Live` queries and `initials` (Task 6).
- Produces:
  - `web/presence.js`: `chip(person) -> HTMLElement`; `class Presence(view)` with `show({ cursors, people })` and `place()`
  - `app.presence`; `app.state.taken: Map<id, person>`, `app.state.seen: Map<id, colour>`; `app.onSelect()` hook; `app.select` leaves out what others hold
  - `view.onRender()` hook
  - `library.live` (the open board's space's live layer or null), `library.updateLive()`, `library.showPresence()`, `library.pointerAt(p)`, `library.touchEnded()`, `library.askName()`

This task is DOM work that `node --test` cannot reach; it ends with a check in two browsers. Cursors glide with a CSS transition here and a Core Animation one on the Mac, so the spec's unit test for gliding becomes that check.

- [ ] **Step 1: Add the elements**

In `web/index.html`:

- inside `<div id="board">`, after the `world` div, add `<div class="presence"></div>`;
- inside `<header id="top">`, between its two `pill` divs, add `<div class="people" hidden></div>`;
- in `.menu.more`, after `<button data-act="join">Join Space</button>`, add `<button data-act="your-name">Your Name</button>`.

- [ ] **Step 2: Style them**

In `web/style.css`, after the `.lane { … }` block (before `.lane.selected`), add:

```css
.lane.taken { border: 2px solid var(--who); }
.lane.seen { border-color: var(--who); }
```

Before `.card.selected::after, .card.found::after {`, add:

```css
.card.taken::after, .card.seen::after {
  content: ""; position: absolute; inset: -4px; border: 2px solid var(--who); border-radius: 4px; pointer-events: none;
}
.card.seen::after { border-width: 1px; }
.card.taken::before, .lane.taken::before { content: attr(data-who); position: absolute; left: -4px; bottom: calc(100% + 6px); z-index: 1; pointer-events: none; }
```

At the end of the file, add:

```css
#board .presence { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.presence .cursor { position: absolute; left: 0; top: 0; transition: transform 60ms linear; }
.presence .cursor svg { display: block; width: 18px; height: 18px; fill: var(--who); stroke: #fff; stroke-width: 1.2; stroke-linejoin: round; }
.presence .cursor span, .card.taken::before, .lane.taken::before {
  padding: 0 6px; border-radius: 6px; background: var(--who); color: #fff; font-size: 12px; line-height: 18px; font-weight: 600; white-space: nowrap;
}
.presence .cursor span { position: absolute; left: 14px; top: 16px; }
.people { display: flex; gap: 4px; }
.person {
  width: 28px; height: 28px; border-radius: 14px; background: var(--who); color: #fff;
  font-size: 12px; line-height: 28px; font-weight: 600; text-align: center; box-shadow: 0 0 0 2px var(--paper);
}
.boards-list .people { gap: 2px; }
.boards-list .person { width: 22px; height: 22px; border-radius: 11px; font-size: 10px; line-height: 22px; }
```

and add `.presence .cursor` to the selector list of the `prefers-reduced-motion` rule.

- [ ] **Step 3: Draw others over the board**

`web/presence.js`:

```js
import { initials } from "./sync/live.js";

const ARROW = '<svg viewBox="0 0 16 16"><path d="M2 1.5 13.5 8 8.2 9.2 5.6 14.5Z"/></svg>';

/** A person's initials in their colour, as the top bar and the board list show them. */
export function chip(person) {
  const s = document.createElement("span");
  s.className = "person";
  s.style.setProperty("--who", person.colour);
  s.textContent = initials(person.name);
  s.title = person.name;
  return s;
}

/**
 * Others over the board: their cursors with names, in screen points so that they keep their size at any zoom, and the
 * row of initials in the top bar.
 */
export class Presence {
  constructor(view) {
    this.view = view;
    this.layer = document.querySelector("#board .presence");
    this.row = document.querySelector("#top .people");
    this.els = new Map();
    this.cursors = [];
  }

  /** `cursors`: [{ key, person, x, y }] in world points; `people`: who else is on the board. */
  show({ cursors, people }) {
    this.cursors = cursors;
    this.row.hidden = !people.length;
    this.row.replaceChildren(...people.map(chip));
    this.place();
  }

  /** After every render and camera move. */
  place() {
    const live = new Set();
    for (const c of this.cursors) {
      live.add(c.key);
      const el = this.element(c.key, "cursor", `${ARROW}<span></span>`);
      el.style.setProperty("--who", c.person.colour);
      el.lastChild.textContent = c.person.name;
      const p = this.view.toScreen(c);
      el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    }
    for (const [key, el] of this.els) {
      if (live.has(key)) continue;
      el.remove();
      this.els.delete(key);
    }
  }

  element(key, cls, html) {
    let el = this.els.get(key);
    if (!el) {
      el = document.createElement("div");
      el.className = cls;
      el.innerHTML = html;
      this.layer.append(el);
      this.els.set(key, el);
    }
    return el;
  }
}
```

- [ ] **Step 4: Mark what others hold and select**

In `web/view.js`, add to the constructor after `this.onCamera = () => {};`:

```js
    this.onRender = () => {};
```

and at the end of `render()`, after `this.ready = true;`, add `this.onRender();`.

In `renderCard(c, i)`, replace the `flags` and `key` lines with:

```js
    const who = s.taken.get(c.id);
    const mark = who?.colour ?? s.seen.get(c.id) ?? "";
    const flags = ["card", c.notes && "notes", turned && "turned", s.selection.has(c.id) && "selected", s.held.has(c.id) && "held",
      s.lifted.has(c.id) && "lifted", s.found === c.id && "found", editing && "editing", who && "taken", !who && mark && "seen"].filter(Boolean).join(" ");
    const f = s.held.has(c.id) && s.float?.x !== undefined ? s.float : { x: 0, y: 0 };
    const e = this.element(c.id, this.cardsEl, SHEET);
    const key = JSON.stringify([flags, c.x + f.x, c.y + f.y, r.w, r.h, c.color, c.text, c.notes, i, mark, who?.name]);
```

and after `el.className = flags;` add:

```js
    el.style.setProperty("--who", mark);
    el.dataset.who = who?.name ?? "";
```

In `renderLane(l)`, do the same: compute `who` and `mark` from `l.id`, add `who && "taken"` and `!who && mark && "seen"` to `flags`, add `mark, who?.name` to `key`, and set `--who` and `data-who` after `el.className = flags;`.

In `web/app.js`:

- import `import { Presence } from "./presence.js";`
- in the constructor, add `taken: new Map(), seen: new Map()` to `this.state`, and after `this.view = new View(…)`:

```js
    this.presence = new Presence(this.view);
    this.view.onRender = () => this.presence.place();
    /** After the selection changes, for others to see. */
    this.onSelect = () => {};
```

- in `this.view.onCamera`, add `this.presence.place();`
- replace `select(ids)` with:

```js
  /** Selects `ids`, leaving out what someone else holds. */
  select(ids) {
    this.state.selection = new Set([...ids].filter((id) => !this.state.taken.has(id)));
    this.view.invalidate();
    this.ui.update();
    this.onSelect();
  }
```

- [ ] **Step 5: Send this device's pointer**

In `web/main.js`:

- in the board's `pointerdown` listener, after `app.touching = …`, add `app.library?.pointerAt({ x: e.clientX, y: e.clientY });`
- at the top of the window `pointermove` listener, add `app.library?.pointerAt({ x: e.clientX, y: e.clientY });`
- at the top of the window `pointerup` listener, add `if (e.pointerType !== "mouse") app.library?.touchEnded();`
- replace the `pointerout` listener with:

```js
addEventListener("pointerout", (e) => {
  if (e.pointerType !== "mouse" || e.relatedTarget) return;
  mouse.leave();
  app.library?.pointerAt(null);
});
```

In `web/ui.js`, in `act`, after the `"join"` case add:

```js
      case "your-name": this.closeMenu(); return app.library?.askName();
```

- [ ] **Step 6: Connect, show who's here, and ask for a name**

In `web/library.js`:

- imports: add `import { chip } from "./presence.js";`
- in the constructor, replace `setInterval(() => !document.hidden && spaces.syncAll(), 5000);` with:

```js
    setInterval(() => !document.hidden && spaces.syncAll({ polling: true }), 5000);
    setInterval(() => this.spaces.spaces.forEach((g) => g.live?.tick()), 1000);
    spaces.onLive = (g) => this.liveChanged(g);
    app.onSelect = () => this.updateLive();
    document.addEventListener("visibilitychange", () => this.updateLive());
```

- at the end of `open(id)` add `this.updateLive();` and `this.showPresence();`; at the end of `showList()` add `this.updateLive();` and `this.showPresence();`
- in `renderBoard(id, title)`, set `li.dataset.board = id;`, create `const people = document.createElement("span"); people.className = "people";` and change the append to `li.append(open, people, edit);`
- at the end of `renderList()` add `this.renderPeople();`
- at the start of `newSpace()` and `join(text)` add:

```js
    if (!this.spaces.me.name && !(await this.askName())) return;
```

- add these methods:

```js
  /** The live layer of the open board's space, if it has one. */
  get live() {
    return this.group?.live ?? null;
  }

  /** Connects each space's live layer while the app shows it, its board or the list, and says what is open. */
  updateLive() {
    for (const g of this.spaces.spaces) {
      if (!g.live) continue;
      if (!document.hidden && (!this.id || this.group === g)) g.live.connect();
      else g.live.close();
      const here = this.group === g;
      g.live.setPresence({ board: here ? this.id : null, selection: here ? [...this.app.state.selection].sort() : [] });
    }
  }

  liveChanged(g) {
    this.updateLive();
    if (g === this.group) this.showPresence();
    if (!this.id) this.renderPeople();
  }

  /** Others on the open board: what they hold and have selected, their cursors, and their initials. */
  showPresence() {
    const { live, id } = this;
    const s = this.app.state;
    s.taken = new Map();
    s.seen = new Map();
    if (live && id) {
      for (const [item, p] of live.selections(id)) s.seen.set(item, p.colour);
      for (const item of live.taken()) s.taken.set(item, live.holderOf(item));
    }
    if ([...s.selection].some((x) => s.taken.has(x))) this.app.select(s.selection);
    this.app.view.invalidate();
    this.app.presence.show({ cursors: live && id ? live.cursors(id) : [], people: live && id ? live.people(id) : [] });
  }

  /** Each board row's initials of whoever is on it, in place. */
  renderPeople() {
    for (const g of this.spaces.spaces) {
      for (const { id } of g.store.boards()) {
        const span = document.querySelector(`.boards-list li[data-board="${id}"] .people`);
        span?.replaceChildren(...(g.live?.people(id) ?? []).map(chip));
      }
    }
  }

  /** This device's pointer or last touch, in screen points, for the open board's cursor; null when it left. */
  pointerAt(p) {
    clearTimeout(this.touchTimer);
    if (!this.live || !this.id) return;
    if (!p) return this.live.sendCursor(this.id, null, null);
    const w = this.app.view.toWorld(p);
    this.live.sendCursor(this.id, w.x, w.y);
  }

  /** A phone's cursor is its last touch, hidden 3 s after the finger lifts. */
  touchEnded() {
    clearTimeout(this.touchTimer);
    this.touchTimer = setTimeout(() => this.pointerAt(null), 3000);
  }

  /** Asks for this device's name; true once it has one. */
  async askName() {
    const r = await ask({ title: "Your Name", message: "Others in your spaces see it beside your cursor.", value: this.spaces.me.name, placeholder: "Name", ok: "OK" });
    const name = r?.value?.trim();
    if (name) await this.spaces.setName(name);
    return !!this.spaces.me.name;
  }
```

- [ ] **Step 7: Run the tests**

Run: `node --test web/test/*.test.js`
Expected: PASS (nothing here is reached by them, but nothing may break).

- [ ] **Step 8: Check it in two browsers**

In three terminals: `npm --prefix relay run dev`, `server/dev.sh`, `npx --yes live-server@1.2.2 web --port=58565 --no-browser`. Open http://localhost:58565/ in Safari and in a private Safari window (separate storage). In the first, ⋯ → New Space: it asks Your Name first; then name the space, server `http://127.0.0.1:58566/sync.php`; Share Invite; in the second, Join Space with the link.

Expected:
- Both board lists show the other's initials on a board once one of them opens it.
- On the same board, each shows the other's initials in the top bar and their cursor with their name, moving smoothly; leaving the window hides it.
- Selecting a card in one outlines it thinly in that person's colour in the other.
- ⋯ → Your Name renames: the other's cursor label changes within a moment.

- [ ] **Step 9: Commit**

```bash
git add web
git commit -m "Show who is where on the web: names, cursors, selections and initials"
```

---

### Task 10: Holds and live edits on the web

**Files:**
- Modify: `web/app.js`, `web/input.js`, `web/view.js`, `web/presence.js`, `web/style.css`, `web/library.js`

**Interfaces:**
- Consumes: `Live.hold`, `release`, `sendLive`, `taken`, `overlay`, `carets`, `mine`, `onRefused` via `spaces.onRefused` (Tasks 6 and 8); `liveFields`, `overlaid` (Task 4); `Binding.taken` (Task 4); `app.state.taken`, `library.live`, `presence` (Task 9).
- Produces: `app.hold(ids)`, `app.refused()`, `app.cancelEditing()`, `app.caret() -> { id, back, at } | null`; `view.shown()` hook; `view.caretRect(id, back, at) -> { x, y, h } | null`; `Presence.show({ cursors, carets, people })`.

- [ ] **Step 1: Hold what a gesture takes, and refuse what others hold**

In `web/app.js` add:

```js
  /** Asks the open board's space to hold `ids` for the gesture starting. */
  hold(ids) {
    this.library?.live?.hold(ids);
  }

  /** Someone else got there first: the gesture under way goes back as it began. */
  refused() {
    if (this.input.drag) return this.input.dragCancel();
    this.cancelEditing();
  }

  /** Ends the card edit or lane rename in progress, putting the board back as it began. */
  cancelEditing() {
    const s = this.state;
    const id = s.editing?.id ?? s.renaming;
    if (!id) return;
    const el = s.editing ? this.view.editorOf(s.editing.id, s.editing.back) : this.view.titleOf(s.renaming);
    s.editing = s.renaming = null;
    if (el) {
      el.onblur = el.oninput = el.onkeydown = null;
      el.blur();
      el.contentEditable = "false";
    }
    // the editor's text is the typed one; drawing afresh puts the board's back
    const e = this.view.els.get(id);
    if (e) e.key = "";
    this.model.cancel();
    this.ui.update();
  }

  /** Where the caret is in the card being edited, for others to draw. */
  caret() {
    const e = this.state.editing;
    const el = e && this.view.editorOf(e.id, e.back);
    const sel = getSelection();
    if (!el || !sel.rangeCount || !el.contains(sel.focusNode)) return null;
    const r = document.createRange();
    r.selectNodeContents(el);
    r.setEnd(sel.focusNode, sel.focusOffset);
    return { id: e.id, back: e.back, at: r.toString().replace(/​/g, "").length };
  }
```

In `beginEdit(id, name)`, after `if (!c) return;` add `if (this.state.taken.has(id)) return;`, and after `this.model.begin();` add `this.hold([id]);`. In `beginRename(id)`, after `if (!l) return;` add `if (this.state.taken.has(id)) return;`, and after `this.model.begin();` add `this.hold([id]);`.

In `web/input.js`, in `beginDrag`, after `const b = app.model.board;` add:

```js
    // what someone else holds stays where it is
    if (["move", "lane", "resize"].includes(action) && s.taken.has(h.id)) return;
```

In the `move` branch, after `app.model.begin();` add `app.hold(ids);`. Replace the `lane` branch with:

```js
    } else if (action === "lane") {
      app.select([h.id]);
      const l = R.lane(b, h.id);
      d.laneOrigin = { id: l.id, x: l.x, y: l.y };
      d.origins = R.cardsInLane(b, h.id, app.heightOf).map((c) => ({ id: c.id, x: c.x, y: c.y }));
      s.held = new Set([h.id, ...d.origins.map((o) => o.id)]);
      if ([...s.held].some((id) => s.taken.has(id))) {
        s.held = new Set();
        this.drag = null;
        return;
      }
      app.model.begin();
      app.hold(s.held);
```

In the `resize` branch, after `app.model.begin();` add `app.hold([h.id]);`.

- [ ] **Step 2: Draw others' live edits and carets**

In `web/view.js`:

- in the constructor, after `this.onRender = () => {};`, add:

```js
    /** The board as drawn: the model's, with others' live edits over it. */
    this.shown = () => this.model.board;
```

- in `render()`, change `const b = this.model.board;` to `const b = this.shown();`
- in `renderCard`, change the `place` call's fourth argument from `s.held.has(c.id)` to `s.held.has(c.id) || s.taken.has(c.id)`; in `renderLane`, the same for `l.id`
- add:

```js
  /** Where offset `at` of card `id`'s front or notes falls on screen, as { x, y, h }; null when that side isn't shown. */
  caretRect(id, back, at) {
    const e = this.els.get(id);
    if (!e || back !== (this.state.turned === id)) return null;
    const node = e.el.querySelector(back ? ".notes" : ".front")?.firstChild;
    if (node?.nodeType !== Node.TEXT_NODE) return null;
    const r = document.createRange();
    r.setStart(node, Math.min(at, node.length));
    r.collapse(true);
    const rect = r.getClientRects()[0] ?? r.getBoundingClientRect();
    if (!rect.height) return null;
    return { x: rect.left, y: rect.top, h: rect.height };
  }
```

In `web/presence.js`, in the constructor add `this.carets = [];`; change `show` to take and keep `carets`:

```js
  /** `cursors`: [{ key, person, x, y }] in world points; `carets`: [{ key, person, id, back, at }]; `people`: who else is on the board. */
  show({ cursors, carets = [], people }) {
    this.cursors = cursors;
    this.carets = carets;
    this.row.hidden = !people.length;
    this.row.replaceChildren(...people.map(chip));
    this.place();
  }
```

and in `place()`, before the loop that removes elements, add:

```js
    for (const c of this.carets) {
      const r = this.view.caretRect(c.id, c.back, c.at);
      if (!r) continue;
      const key = `caret:${c.key}`;
      live.add(key);
      const el = this.element(key, "caret", "");
      el.style.setProperty("--who", c.person.colour);
      el.style.transform = `translate(${r.x}px, ${r.y}px)`;
      el.style.height = `${r.h}px`;
    }
```

In `web/style.css`, after the `.presence .cursor span { … }` rule, add:

```css
.presence .caret { position: absolute; left: 0; top: 0; width: 2px; background: var(--who); }
```

- [ ] **Step 3: Send live edits, push at the end, and let go**

In `web/library.js`:

- imports: add `import { liveFields, overlaid } from "./sync/overlay.js";`
- in the constructor, change the model hook to:

```js
    app.model.onChange = () => {
      change();
      this.binding?.changed();
      this.gestured();
    };
    app.view.shown = () => (this.live && this.id ? overlaid(app.model.board, this.live.overlay(this.id)) : app.model.board);
    spaces.onRefused = (g) => g === this.group && this.app.refused();
```

- in `open(id)`, after `this.binding = new Binding(…);` add `this.binding.taken = () => this.live?.taken() ?? new Set();`
- in `showPresence()`, pass carets: `this.app.presence.show({ cursors: …, carets: live && id ? live.carets(id) : [], people: … });`
- add:

```js
  /** While a gesture holds items, sends what it changed of them; when it ends, pushes at once, then lets go. */
  gestured() {
    const { live, id } = this;
    const model = this.app.model;
    if (model.inGesture) {
      this.gesturing = true;
      if (live?.mine.size && id) live.sendLive(id, liveFields(model.start, model.board, live.mine, id), this.app.caret());
      return;
    }
    if (!this.gesturing) return;
    this.gesturing = false;
    this.finishGesture();
  }

  async finishGesture() {
    const g = this.group;
    const live = g?.live;
    if (!live?.mine.size) return;
    this.binding?.flush();
    await g.engine.sync();
    // a gesture begun meanwhile keeps the holds until it ends
    if (!this.gesturing) live.release();
  }
```

- [ ] **Step 4: Run the tests**

Run: `node --test web/test/*.test.js`
Expected: PASS.

- [ ] **Step 5: Check it in two browsers**

With the setup of Task 9, Step 8, both windows on the same board:

- Drag a card in one: the other shows it moving as it moves, outlined in the dragger's colour with their name; it lands where it was dropped with no jump back.
- While one drags or edits a card, the other cannot select, drag or edit it.
- Type in a card in one: the text and a coloured caret appear in the other as typed.
- Grab the same card in both at once (as near together as you can): one drag springs back.
- Rename a lane in one: the title changes live in the other.

- [ ] **Step 6: Commit**

```bash
git add web
git commit -m "Hold what a gesture takes on the web, and show others' drags and typing as they happen"
```

---

### Task 11: People on the Mac: names, connections, cursors, who's here

**Files:**
- Create: `Breezy/Canvas/PresenceView.swift`
- Modify: `Breezy/Canvas/CanvasView.swift`, `Breezy/Canvas/CanvasView+Pointer.swift`, `Breezy/Canvas/CardLayer.swift`, `Breezy/Canvas/LaneView.swift`, `Breezy/Window/BoardWindowController.swift`, `Breezy/Library/Library.swift`, `Breezy/Library/BoardsWindowController.swift`, `Breezy/App/AppDelegate.swift`, `Breezy/App/MainMenu.swift`

**Interfaces:**
- Consumes: `Spaces(directory:me:)`, `Spaces.me`, `onLive`, `syncAll(polling:)`, `Group.live` (Task 7); `Live` queries, `Person` (Task 5).
- Produces:
  - `extension Person { var nsColour: NSColor }`
  - `struct CanvasPresence: Equatable` with `taken: [String: Person]`, `seen: [String: Person]`, `overlay: [String: LiveFields]`, `cursors: [Seen]`, `carets: [Typing]`, `people: [Person]`, and `@MainActor init(_ live: Live?, board: String)`
  - `final class PresenceView: NSView` with `struct Mark { key, kind (.cursor, .label, .caret), person, rect }` and `show(_ marks: [Mark], zoom: CGFloat)`
  - `CanvasView`: `presence: CanvasPresence`, `onPointer: ((NSPoint?) -> Void)?`, `onSelection: (() -> Void)?`, `showPresence()`
  - `CardLayer.Ring { colour: CGColor; width: CGFloat }` and `configure(_:size:ring:scale:appearance:)`; `LaneView.ringColour: NSColor?`
  - `BoardWindowController.showPeople(_ people: [Person])`
  - `Library.setName(_:)`, `Library.updateLive()`, `Notification.Name.peopleChanged`
  - `AppDelegate.yourName(_:)`

This task is AppKit work that `swift test` cannot reach; it ends with a check between the Mac and a browser.

- [ ] **Step 1: Draw others' marks**

`Breezy/Canvas/PresenceView.swift`:

```swift
import AppKit
import BreezyKit

extension Person {
  var nsColour: NSColor { NSColor(hex: colour) }
}

/// What others do on one board, as the canvas draws it.
struct CanvasPresence: Equatable {
  struct Seen: Equatable {
    var key: String
    var person: Person
    var x: Double
    var y: Double
  }

  struct Typing: Equatable {
    var key: String
    var person: Person
    var caret: Caret
  }

  var taken: [String: Person] = [:]
  var seen: [String: Person] = [:]
  var overlay: [String: LiveFields] = [:]
  var cursors: [Seen] = []
  var carets: [Typing] = []
  var people: [Person] = []

  init() {}

  @MainActor init(_ live: Live?, board: String) {
    guard let live else { return }
    for id in live.taken { taken[id] = live.holder(of: id) }
    seen = live.selections(on: board)
    overlay = live.overlay(on: board)
    cursors = live.cursors(on: board).map { Seen(key: $0.key, person: $0.person, x: $0.cursor.x, y: $0.cursor.y) }
    carets = live.carets(on: board).map { Typing(key: $0.key, person: $0.person, caret: $0.caret) }
    people = live.people(on: board)
  }
}

/// Others over the board: their cursors with names, the names over what they hold, and their carets. In the canvas's
/// coordinates; cursors and names are scaled by 1 / zoom so that they keep their size.
final class PresenceView: NSView {
  struct Mark {
    enum Kind { case cursor, label, caret }
    var key: String
    var kind: Kind
    var person: Person
    /// A cursor's tip or a label's bottom left as the origin, or a caret's rect.
    var rect: NSRect
  }

  private var marks: [String: CALayer] = [:]

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
  }

  required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  func show(_ shown: [Mark], zoom: CGFloat) {
    var live = Set<String>()
    for m in shown {
      live.insert(m.key)
      let isNew = marks[m.key] == nil
      let l = marks[m.key] ?? make(m)
      marks[m.key] = l
      CATransaction.begin()
      // a cursor glides between updates; everything else jumps
      CATransaction.setDisableActions(isNew || m.kind != .cursor)
      CATransaction.setAnimationDuration(0.06)
      CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .linear))
      switch m.kind {
      case .caret:
        l.frame = m.rect
      case .cursor, .label:
        l.transform = CATransform3DMakeScale(1 / zoom, 1 / zoom, 1)
        l.position = m.rect.origin
      }
      CATransaction.commit()
    }
    for (k, l) in marks where !live.contains(k) {
      l.removeFromSuperlayer()
      marks[k] = nil
    }
  }

  private func make(_ m: Mark) -> CALayer {
    let colour = m.person.nsColour.cgColor
    let l: CALayer
    switch m.kind {
    case .caret:
      l = CALayer()
      l.backgroundColor = colour
    case .cursor:
      l = CALayer()
      l.anchorPoint = .zero
      l.bounds = CGRect(x: 0, y: 0, width: 18, height: 18)
      let arrow = CAShapeLayer()
      let p = CGMutablePath()
      p.addLines(between: [CGPoint(x: 2, y: 1.5), CGPoint(x: 13.5, y: 8), CGPoint(x: 8.2, y: 9.2), CGPoint(x: 5.6, y: 14.5)])
      p.closeSubpath()
      arrow.path = p
      arrow.fillColor = colour
      arrow.strokeColor = .white
      arrow.lineWidth = 1.2
      arrow.lineJoin = .round
      l.addSublayer(arrow)
      let tag = Self.tag(m.person.name, colour)
      tag.frame.origin = CGPoint(x: 14, y: 16)
      l.addSublayer(tag)
    case .label:
      l = Self.tag(m.person.name, colour)
      l.anchorPoint = CGPoint(x: 0, y: 1)
    }
    layer!.addSublayer(l)
    return l
  }

  private static func tag(_ name: String, _ colour: CGColor) -> CATextLayer {
    let s = NSAttributedString(string: name, attributes: [.font: NSFont.systemFont(ofSize: 12, weight: .semibold), .foregroundColor: NSColor.white])
    let t = CATextLayer()
    t.string = s
    t.backgroundColor = colour
    t.cornerRadius = 6
    t.alignmentMode = .center
    t.contentsScale = NSScreen.main?.backingScaleFactor ?? 2
    t.frame = CGRect(x: 0, y: 0, width: ceil(s.size().width) + 12, height: 18)
    return t
  }
}
```

- [ ] **Step 2: Rings in a holder's or selector's colour**

In `CardLayer.swift`, add inside the class:

```swift
  /// The outline around a card: the accent for this Mac's selection, a person's colour for what they hold or select.
  struct Ring: Equatable {
    var colour: CGColor
    var width: CGFloat
  }
```

Change `configure` to take a ring instead of `selected`:

```swift
  func configure(_ look: Look, size: CGSize, ring: Ring?, scale: CGFloat, appearance: NSAppearance) {
    setRing(ring)
    guard look != self.look || size != self.size || scale != contentsScale else { return }
```

delete its line `if look.dark != self.look?.dark { ring?.borderColor = … }` (the canvas resolves the colour for the appearance on every pass), and replace `setRing(_:_:)` with:

```swift
  private func setRing(_ r: Ring?) {
    guard let r else {
      ring?.removeFromSuperlayer()
      ring = nil
      return
    }
    let l = ring ?? CALayer()
    if ring == nil {
      l.cornerRadius = 4
      l.frame = CGRect(origin: .zero, size: size).insetBy(dx: -4, dy: -4)
      addSublayer(l)
      ring = l
    }
    l.borderWidth = r.width
    l.borderColor = r.colour
  }
```

In `CanvasView.layoutCards`, replace the `l.configure(look, size: r.size, selected: selection.contains(c.id), …)` call with:

```swift
      let ring: CardLayer.Ring? = selection.contains(c.id) ? CardLayer.Ring(colour: Theme.cg(Theme.accent, in: effectiveAppearance), width: 2)
        : presence.taken[c.id].map { CardLayer.Ring(colour: $0.nsColour.cgColor, width: 2) }
        ?? presence.seen[c.id].map { CardLayer.Ring(colour: $0.nsColour.cgColor, width: 1) }
      l.configure(look, size: r.size, ring: ring, scale: s, appearance: effectiveAppearance)
```

In `LaneView.swift`, add `var ringColour: NSColor? { didSet { if ringColour != oldValue { needsDisplay = true } } }` and change `updateLayer()`'s border lines to:

```swift
    layer?.borderColor = (selected ? Theme.accent : ringColour ?? Theme.hairline).cgColor
    layer?.borderWidth = selected || ringColour != nil ? 2 : 1
```

In `CanvasView.placeLanes`, after `v.lane = l`, add `v.ringColour = (presence.taken[l.id] ?? presence.seen[l.id])?.nsColour`.

- [ ] **Step 3: Give the canvas others' presence**

In `CanvasView.swift`:

- add properties after `accessibilityElements`:

```swift
  /// What others do on this board.
  var presence = CanvasPresence() { didSet { if presence != oldValue { presenceChanged(from: oldValue) } } }
  let presenceView = PresenceView()
  /// This Mac's pointer over the board, in world points; nil when it left.
  var onPointer: ((NSPoint?) -> Void)?
  /// After the selection changes, for others to see.
  var onSelection: (() -> Void)?
```

- in the `selection` property's `didSet`, after `layoutCards()`, add `onSelection?()`
- in `init`, after `addSubview(marquee)`, add:

```swift
    presenceView.frame = bounds
    addSubview(presenceView)
```

- change the tracking area's options to `[.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect]`
- at the end of `layoutCards(settle:)`, after the `if lagging { … }` block, add `showPresence()`
- add:

```swift
  private func presenceChanged(from old: CanvasPresence) {
    let taken = Set(presence.taken.keys)
    if !selection.isDisjoint(with: taken) { selection.subtract(taken) }
    if presence.taken != old.taken || presence.seen != old.seen {
      placeLanes()
      layoutCards()
    } else {
      showPresence()
    }
  }

  /// Puts others' cursors and the names over what they hold where the board shows them.
  func showPresence() {
    var marks = presence.cursors.map {
      PresenceView.Mark(key: "cursor " + $0.key, kind: .cursor, person: $0.person, rect: NSRect(x: $0.x + Self.origin, y: $0.y + Self.origin, width: 0, height: 0))
    }
    for (id, person) in presence.taken {
      guard let r = board.card(id).map(drawnRect) ?? board.lane(id)?.rect else { continue }
      let d = doc(r)
      marks.append(PresenceView.Mark(key: "label " + id, kind: .label, person: person, rect: NSRect(x: d.minX - 4, y: d.minY - 6, width: 0, height: 0)))
    }
    presenceView.show(marks, zoom: zoom)
  }
```

In `CanvasView+Pointer.swift`:

- `mouseMoved`: after `hovered = …`, add `onPointer?(world(event))`
- `mouseDragged`: at the top, add `onPointer?(world(event))`
- add:

```swift
  override func mouseExited(with event: NSEvent) {
    hovered = nil
    onPointer?(nil)
  }
```

- [ ] **Step 4: Show who's here in the toolbar and the Boards window**

In `BoardWindowController.swift`:

- extend the identifiers: `static let people = Self("people")`
- add a property `private let people = NSStackView()`
- `toolbarDefaultItemIdentifiers` returns `[.flexibleSpace, .people, .newLane]`
- in `toolbar(_:itemForItemIdentifier:willBeInsertedIntoToolbar:)`, add:

```swift
    case .people:
      let item = NSToolbarItem(itemIdentifier: id)
      item.label = "People"
      people.spacing = 4
      item.view = people
      return item
```

- add:

```swift
  /// The initials of the others on this board, in their colours.
  func showPeople(_ list: [Person]) {
    people.setViews(list.map { p in
      let f = NSTextField(labelWithString: p.initials)
      f.font = .systemFont(ofSize: 11, weight: .semibold)
      f.textColor = .white
      f.alignment = .center
      f.wantsLayer = true
      f.layer?.backgroundColor = p.nsColour.cgColor
      f.layer?.cornerRadius = 11
      f.toolTip = p.name
      f.translatesAutoresizingMaskIntoConstraints = false
      NSLayoutConstraint.activate([f.widthAnchor.constraint(equalToConstant: 22), f.heightAnchor.constraint(equalToConstant: 22)])
      return f
    }, in: .leading)
  }
```

In `BoardsWindowController.swift`:

- in `init`, add an observer like the others:

```swift
    NotificationCenter.default.addObserver(forName: .peopleChanged, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.reload() }
    }
```

- in `outlineView(_:viewFor:item:)`, for a board row add a trailing label of initials before the constraints, and pin the title's trailing edge to it:

```swift
    let people = NSTextField(labelWithString: "")
    if let b = row.board {
      let s = NSMutableAttributedString()
      for p in row.group.live?.people(on: b.id) ?? [] {
        s.append(NSAttributedString(string: p.initials + " ", attributes: [.foregroundColor: p.nsColour, .font: NSFont.systemFont(ofSize: 11, weight: .semibold)]))
      }
      people.attributedStringValue = s
    }
    people.translatesAutoresizingMaskIntoConstraints = false
    people.setContentCompressionResistancePriority(.required, for: .horizontal)
    cell.addSubview(people)
```

and replace the constraints with:

```swift
    NSLayoutConstraint.activate([
      field.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 4),
      field.trailingAnchor.constraint(equalTo: people.leadingAnchor, constant: -4),
      people.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -4),
      field.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
      people.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
    ])
```

- [ ] **Step 5: Connect the live layers, and name this Mac**

In `Library.swift`:

- add to the `Notification.Name` extension: `static let peopleChanged = Notification.Name("BreezyPeopleChanged")`
- add properties: `private var liveTimer: Timer?` and `private var peopleSeen = ""`
- in `init`, change the first line to `spaces = try Spaces(directory: directory, me: Self.me())`, add after `spaces.flushLocal = …`:

```swift
    spaces.onLive = { [weak self] g in self?.liveChanged(g) }
    liveTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        for g in spaces.spaces { g.live?.tick() }
        updateLive()
      }
    }
    for name in [NSWindow.didBecomeKeyNotification, NSWindow.didChangeOcclusionStateNotification] {
      NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.updateLive() }
      }
    }
```

- in `poll()`, replace `if shown { syncNow() }` with `if shown { spaces.syncAll(polling: true) }`
- in `open(_:display:)`, after `doc.makeWindowControllers()`, add `wire(doc)`; before `if display { … }`, add `if let g = spaces.group(of: id) { liveChanged(g) }`
- add:

```swift
  /// This Mac as others see it: an id made once, and the macOS account's name until it is changed.
  static func me() -> Person {
    let d = UserDefaults.standard
    let device = d.string(forKey: "BreezyDevice").flatMap { Base64URL.decode($0)?.count == 16 ? $0 : nil } ?? newID()
    d.set(device, forKey: "BreezyDevice")
    return Person(device: device, name: d.string(forKey: "BreezyName") ?? NSFullUserName())
  }

  func setName(_ name: String) {
    UserDefaults.standard.set(name, forKey: "BreezyName")
    spaces.me = Person(device: spaces.me.device, name: name)
  }

  /// Hooks board `doc`'s window to its space's live layer, looked up each time, as the layer may come and go.
  private func wire(_ doc: BoardDocument) {
    let id = doc.boardID
    guard let canvas = doc.windowController?.canvas else { return }
    canvas.onPointer = { [weak self] p in
      self?.spaces.group(of: id)?.live?.sendCursor(board: id, x: p.map { Double($0.x) }, y: p.map { Double($0.y) })
    }
    canvas.onSelection = { [weak self] in self?.updateLive() }
  }

  /// Connects each space's live layer while one of its boards or the Boards window shows, and says which board is in front.
  func updateLive() {
    let visible = NSApp.isHidden ? [] : NSApp.windows.filter { $0.occlusionState.contains(.visible) }
    let listShown = visible.contains { $0.windowController is BoardsWindowController }
    let shown = visible.compactMap { ($0.windowController?.document as? BoardDocument)?.boardID }
    let key = (NSApp.keyWindow?.windowController?.document as? BoardDocument)?.boardID
    for g in spaces.spaces {
      guard let live = g.live else { continue }
      if listShown || shown.contains(where: { g.store.title(of: $0) != nil }) { live.connect() } else { live.close() }
      let board = key.flatMap { g.store.title(of: $0) != nil ? $0 : nil }
      let selection = board.flatMap { b in documents.first { $0.boardID == b }?.windowController?.canvas.selection }
      live.setPresence(board: board, selection: selection.map { $0.sorted() } ?? [])
    }
  }

  /// Something changed in `g`'s live layer: its board windows and the Boards window follow.
  func liveChanged(_ g: Spaces.Group) {
    updateLive()
    for d in documents where g.store.title(of: d.boardID) != nil {
      d.windowController?.canvas.presence = CanvasPresence(g.live, board: d.boardID)
      d.windowController?.showPeople(g.live?.people(on: d.boardID) ?? [])
    }
    // the list reloads only when who is on which board changes, not with every cursor
    let seen = spaces.spaces.flatMap { g in g.store.boards.map { b in b.id + ":" + (g.live?.people(on: b.id) ?? []).map(\.device).joined(separator: ",") } }
      .joined(separator: ";")
    if seen != peopleSeen {
      peopleSeen = seen
      NotificationCenter.default.post(name: .peopleChanged, object: nil)
    }
  }
```

In `AppDelegate.swift`, add:

```swift
  @MainActor @objc func yourName(_ sender: Any?) {
    let input = field("Name")
    input.stringValue = Library.shared.spaces.me.name
    let alert = NSAlert()
    alert.messageText = "Your Name"
    alert.informativeText = "Others in your spaces see it beside your cursor."
    alert.accessoryView = input
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Cancel")
    alert.window.initialFirstResponder = input
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    let name = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    if !name.isEmpty { Library.shared.setName(name) }
  }
```

In `MainMenu.swift`, in the Breezy menu, add `item("Your Name…", #selector(AppDelegate.yourName(_:))),` before `item("New Space…", …)`.

- [ ] **Step 6: Build and run the tests**

Run: `xcodegen generate && xcodebuild -project Breezy.xcodeproj -scheme Breezy -derivedDataPath build test`
Expected: `** TEST SUCCEEDED **`.

- [ ] **Step 7: Check it against a browser**

With the relay, `server/dev.sh` and live-server running (Task 9, Step 8), open the Debug build (`open build/Build/Products/Debug/Breezy.app`), New Space… on `http://127.0.0.1:58566/sync.php`, Share Invite, and Join Space in Safari at http://localhost:58565/.

Expected:
- With both on one board, each shows the other's initials (Mac: toolbar; web: top bar) and cursor; the Mac's cursor label keeps its size at every zoom.
- The Boards window shows the browser's initials beside the board it has open.
- Selecting a card on one outlines it thinly in the selector's colour on the other.
- Breezy → Your Name… renames the Mac's cursor label in the browser.

- [ ] **Step 8: Commit**

```bash
git add Breezy
git commit -m "Show who is where on the Mac: names, cursors, selections and initials"
```

---

### Task 12: Holds and live edits on the Mac

**Files:**
- Modify: `Breezy/Canvas/CanvasView.swift`, `Breezy/Canvas/CanvasView+Pointer.swift`, `Breezy/Canvas/CanvasView+Editing.swift`, `Breezy/Style/Typography.swift`, `Breezy/Library/Library.swift`

**Interfaces:**
- Consumes: `Live.hold`, `release`, `sendLive`, `taken`, `mine` (Task 5); `Spaces.onRefused` (Task 7); `Records.liveFields`, `Board.overlaid`, `BoardModel.cancel`, `gestureStartBoard`, `BoardBinding.taken`, `afterEdit`, `afterGesture` (Task 3); `CanvasPresence`, `PresenceView`, `wire(_:)` (Task 11).
- Produces: `CanvasView.hold: ((Set<String>) -> Void)?`, `CanvasView.refused()`, `CanvasView.cancelEditing()`, `CanvasView.caret() -> Caret?`, `CanvasView.shown: Board`, `TextMetrics.caret(_:width:at:) -> NSRect`.

- [ ] **Step 1: Hold what a gesture takes, and refuse what others hold**

In `CanvasView.swift`, add after `onSelection`:

```swift
  /// Asks the space to hold these ids for the gesture starting.
  var hold: ((Set<String>) -> Void)?
```

In `CanvasView+Pointer.swift`, in `mouseDown(with:)`:

- after `let hit = card(at: p)`, add:

```swift
    // what someone else holds can't be selected, moved or edited
    if let id = hit?.id ?? lane(at: p)?.id, presence.taken[id] != nil { return }
```

- after the cards branch's `model.begin()`, add `hold?(Set(held.map(\.id)))`
- after the resize branch's `model.begin()`, add `hold?([l.id])`
- in the lane-header branch, after `let carried = …`, add `if carried.contains(where: { presence.taken[$0.id] != nil }) { return }`, and after its `model.begin()`, add `hold?(Set([l.id] + carried.map(\.id)))`

In `CanvasView+Editing.swift`:

- in `beginEdit(_:name:)`, change the guard to `guard let c = board.card(id), presence.taken[id] == nil else { return }` and after `model.begin()` add `hold?([id])`
- in `beginRename(_:)`, change the guard to `guard let v = laneViews[id], let l = board.lane(id), presence.taken[id] == nil else { return }` and after `model.begin()` add `hold?([id])`
- add:

```swift
  /// Ends the card edit or lane rename in progress, putting the board back as it began.
  func cancelEditing() {
    if let r = renaming {
      renaming = nil
      r.field.removeFromSuperview()
      laneViews[r.id]?.renaming = false
    }
    if let e = editing {
      editing = nil
      e.view.removeFromSuperview()
    }
    model.cancel()
    layoutCards()
  }

  /// Someone else got there first: the drag or edit under way goes back as it began.
  func refused() {
    guard drag != nil else {
      if editing != nil || renaming != nil { cancelEditing() }
      return
    }
    drag = nil
    dragPoint = nil
    stopEdgeScroll()
    marquee.isHidden = true
    raised = []
    held = Held()
    model.cancel()
    placeLanes()
    layoutCards()
  }

  /// Where the caret is in the card being edited, for others to draw.
  func caret() -> Caret? {
    editing.map { Caret(id: $0.id, back: $0.back, at: $0.view.selectedRange().location) }
  }
```

- [ ] **Step 2: Draw others' live edits**

In `CanvasView.swift`:

- add after `presenceView`:

```swift
  /// Heights of cards whose text others are typing, as drawn.
  var overlayHeights: [String: Double] = [:]
  /// What the canvas draws: the board, with others' live edits over it.
  var shown: Board { board.overlaid(presence.overlay) }
```

- change `frontRect` to `func frontRect(_ c: Card) -> Rect { c.rect(height: overlayHeights[c.id] ?? height(c.id)) }`
- in `placeLanes`, change `for l in board.lanes {` to `for l in shown.lanes {`, and `} else if held.ids.contains(l.id) {` to `} else if held.ids.contains(l.id) || presence.taken[l.id] != nil {`
- in `layoutCards`, change `for (i, c) in board.cards.enumerated() {` to `for (i, c) in shown.cards.enumerated() {`, and `if isHeld {` (before `l.stopMoving()`) to `if isHeld || presence.taken[c.id] != nil {`
- in `presenceChanged(from:)`, replace the `if presence.taken != old.taken || presence.seen != old.seen {` condition and add the heights:

```swift
    if presence.overlay != old.overlay || presence.taken != old.taken || presence.seen != old.seen {
      overlayHeights = [:]
      for c in shown.cards where presence.overlay[c.id]?["text"] != nil || board.card(c.id) == nil {
        overlayHeights[c.id] = Double(TextMetrics.frontHeight(c.text, width: CGFloat(c.w)))
      }
      placeLanes()
      layoutCards()
    } else {
      showPresence()
    }
```

- in `showPresence()`, take the label rects from `shown` (`guard let r = shown.card(id).map(drawnRect) ?? shown.lane(id)?.rect else { continue }`) and add carets before `presenceView.show(…)`:

```swift
    for t in presence.carets {
      guard let c = shown.card(t.caret.id), t.caret.back == (turned == c.id) else { continue }
      let r = doc(drawnRect(c))
      let back = t.caret.back
      let s = back ? Typo.back(text: c.text, notes: c.notes ?? "", placeholder: false) : Typo.front(c.text)
      let inset = back ? NSSize(width: Typo.backPad, height: Typo.backPad) : NSSize(width: Typo.padX, height: Typo.padY)
      // on the back the notes follow the heading line
      let at = back ? (String(c.text.prefix { $0 != "\n" }) as NSString).length + 1 + t.caret.at : t.caret.at
      let k = TextMetrics.caret(s, width: r.width - 2 * inset.width, at: at)
      marks.append(PresenceView.Mark(key: "caret " + t.key, kind: .caret, person: t.person, rect: k.offsetBy(dx: r.minX + inset.width, dy: r.minY + inset.height)))
    }
```

In `Typography.swift`, in `TextMetrics`, add:

```swift
  /// Where offset `at` of `s` falls when laid out `width` wide: a caret's rect, from the text's top left.
  static func caret(_ s: NSAttributedString, width: CGFloat, at: Int) -> NSRect {
    let (storage, manager, container) = layout(s, width: width)
    let n = storage.length
    let i = min(max(0, at), n)
    if n == 0 { return NSRect(x: 0, y: 0, width: 2, height: Typo.line) }
    // after a final newline the caret is on the empty line below
    if i == n, (storage.string as NSString).character(at: n - 1) == 10 {
      return NSRect(x: 0, y: manager.extraLineFragmentRect.minY, width: 2, height: Typo.line)
    }
    let glyph = manager.glyphIndexForCharacter(at: min(i, n - 1))
    let line = manager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
    let x = i == n ? manager.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: container).maxX : line.minX + manager.location(forGlyphAt: glyph).x
    return NSRect(x: x, y: line.minY, width: 2, height: Typo.line)
  }
```

- [ ] **Step 3: Send live edits, push at the end, and let go**

In `Library.swift`:

- in `init`, after `spaces.onLive = …`, add:

```swift
    spaces.onRefused = { [weak self] g, _ in
      for d in self?.documents ?? [] where g.store.title(of: d.boardID) != nil { d.windowController?.canvas.refused() }
    }
```

- in `wire(_:)`, add:

```swift
    canvas.hold = { [weak self] ids in self?.spaces.group(of: id)?.live?.hold(ids) }
    doc.binding.taken = { [weak self] in self?.spaces.group(of: id)?.live?.taken ?? [] }
    doc.binding.afterEdit = { [weak self, weak doc] in
      guard let self, let doc, let live = spaces.group(of: id)?.live, !live.mine.isEmpty, let start = doc.model.gestureStartBoard else { return }
      live.sendLive(board: id, items: Records.liveFields(from: start, to: doc.model.board, ids: live.mine, board: id),
                    caret: doc.windowController?.canvas.caret())
    }
    // at a gesture's end: push at once, then let go, unless another gesture began meanwhile
    doc.binding.afterGesture = { [weak self, weak doc] in
      guard let self, let doc, let g = spaces.group(of: id), let live = g.live, !live.mine.isEmpty else { return }
      doc.binding.flush()
      Task {
        await g.engine.sync()
        if !doc.model.inGesture { live.release() }
      }
    }
```

- [ ] **Step 4: Build and run the tests**

Run: `xcodegen generate && xcodebuild -project Breezy.xcodeproj -scheme Breezy -derivedDataPath build test`
Expected: `** TEST SUCCEEDED **`.

- [ ] **Step 5: Check it against a browser**

With the setup of Task 11, Step 7:

- Drag a card on the Mac: the browser shows it moving as it moves, outlined in the Mac's colour with its name, and it lands with no jump back; the same the other way.
- While one side drags or edits a card, the other cannot select, drag or edit it, and cannot drag a lane holding it.
- Type in a card on either side: the text and a coloured caret appear on the other as typed, front and back.
- Grab the same card on both at once: one drag springs back.

- [ ] **Step 6: Commit**

```bash
git add Breezy
git commit -m "Hold what a gesture takes on the Mac, and show others' drags and typing as they happen"
```

---

### Task 13: Document, deploy and check end to end

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Describe the relay in the README**

In `README.md`'s Sync section, after the paragraph that starts "The server is `server/sync.php`", add:

```markdown
Cursors, who is on which board, held cards and edits as they happen go through a relay, `relay/`: a Cloudflare Worker with a Durable Object per space, which forwards what the devices seal and cannot read it. `sync.php` names it from `config.php`'s `relay`, which the deploy writes from `BREEZY_RELAY` (default `wss://breezy-relay.blissfulbird.workers.dev/`). Deploy the relay by hand: `npx --prefix relay wrangler login` once, then `npm --prefix relay run deploy`. Without a relay, boards sync as before, polling every 5 s.
```

and in the code block after it, add:

```bash
relay/test.sh                  # the relay under wrangler dev, with its tests; first npm install --prefix relay
npm --prefix relay run dev     # serves ws://127.0.0.1:58568/, which server/dev.sh names
```

- [ ] **Step 2: Run every test**

Run: `swift test --package-path BreezyKit && node --test web/test/*.test.js relay/test/holds.test.mjs && relay/test.sh && server/test.sh && xcodebuild -project Breezy.xcodeproj -scheme Breezy -derivedDataPath build test`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Describe the live layer's relay in the README"
```

- [ ] **Step 4: Deploy the relay (ask first)**

Ask the user before deploying: `npm --prefix relay run deploy`. Expected: `Deployed breezy-relay triggers … https://breezy-relay.blissfulbird.workers.dev`. Then ask whether to delete the spike's Worker with `npx --prefix relay wrangler delete --name breezy-realtime`; delete it only on a yes.

- [ ] **Step 5: Check end to end with the real phone (after the user pushes `main`)**

Pushing `main` deploys the web app and a `config.php` naming the relay. Then, with the Mac app (Release build) and the iPhone's installed web app in one space:

- Drag and type at the same time on both; grab the same card together: one springs back.
- Switch the phone from Wi-Fi to mobile data mid-drag: the Mac's outline of the card disappears within 15 s, the phone reconnects within 30 s, and its drag carries on if nobody took the card, or springs back if someone did.
- Quit the Mac app while it holds a card: the phone can take the card within 15 s.
