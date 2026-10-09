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
