import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { leb } from "../src/frames.js";

// relay/test.sh runs these against wrangler dev
const RELAY = process.env.BREEZY_RELAY;
const rand = (n) => randomBytes(n).toString("base64url");
const bin = (m) => m instanceof Uint8Array;
const cat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]));
const type = (t) => (m) => m?.t === t;

/** A connection to `space`, authenticated with `token` unless `auth` is false. */
async function connect(space, token, { auth = true, v, replaces } = {}) {
  const url = new URL(RELAY);
  url.searchParams.set("space", space);
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const inbox = [];
  const waiters = [];
  let closed = null;
  const wake = () => waiters.splice(0).forEach((w) => w());
  ws.onmessage = (e) => {
    inbox.push(e.data === "pong" ? e.data : typeof e.data === "string" ? JSON.parse(e.data) : new Uint8Array(e.data));
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
    send: (m) => ws.send(typeof m === "string" || m instanceof Uint8Array ? m : JSON.stringify(m)),
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
    c.send({ t: "auth", token, ...(v && { v }), ...(replaces && { replaces }) });
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

// Local workerd does not complete a server close to a client that never sent a frame, so this checks for no welcome instead.
test("a socket that never authenticates is closed", { timeout: 30_000 }, async () => {
  const token = rand(32);
  const c = await connect(rand(16), token, { auth: false });
  await new Promise((r) => setTimeout(r, 7000));
  try {
    c.send({ t: "auth", token });
  } catch {}
  assert.equal(await c.next(type("welcome"), 2000), null);
});

test("a ping gets a pong, before auth too", async () => {
  const space = rand(16), token = rand(32);
  const c = await connect(space, token, { auth: false });
  c.send("ping");
  assert.equal(await c.next((m) => m === "pong"), "pong");
  c.send({ t: "auth", token });
  assert.ok(await c.next(type("welcome")));
  c.send("ping");
  assert.equal(await c.next((m) => m === "pong"), "pong");
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

test("a hold of more than 500 ids, or of malformed ids, is refused", async () => {
  const space = rand(16), token = rand(32);
  const a = await connect(space, token), b = await connect(space, token);
  const ids = Array.from({ length: 500 }, () => rand(16));
  a.send({ t: "hold", ids });
  assert.equal((await b.next(type("holds"))).holds[a.welcome.id].length, 500);
  const more = rand(16);
  a.send({ t: "hold", ids: [more] });
  assert.deepEqual(await a.next(type("refused")), { t: "refused", ids: [more] });
  a.send({ t: "hold", ids: ["short"] });
  assert.deepEqual(await a.next(type("refused")), { t: "refused", ids: ["short"] });
  a.send({ t: "hold", ids: 7 });
  assert.deepEqual(await a.next(type("refused")), { t: "refused", ids: [] });
  assert.equal(await b.next(type("holds"), 300), null);
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

test("connection ids are short decimal strings in order", async () => {
  const space = rand(16), token = rand(32);
  const a = await connect(space, token), b = await connect(space, token);
  assert.equal(a.welcome.id, "1");
  assert.equal(b.welcome.id, "2");
  assert.deepEqual(b.welcome.peers, ["1"]);
});

test("a v2 broadcast reaches v2 devices as binary and older ones as JSON", async () => {
  const space = rand(16), token = rand(32);
  const a = await connect(space, token, { v: 2 }), b = await connect(space, token, { v: 2 }), c = await connect(space, token);
  const body = Uint8Array.of(0, 1, 250, 251, 252);
  a.send(cat([0], body));
  assert.deepEqual([...await b.next(bin)], [...leb(1), ...body]);
  assert.deepEqual(await c.next((m) => "body" in m), { from: "1", body: Buffer.from(body).toString("base64url") });
  assert.equal(await a.next((m) => bin(m) || "body" in m, 300), null);
});

test("a binary frame with a number goes to that connection only", async () => {
  const space = rand(16), token = rand(32);
  const a = await connect(space, token, { v: 2 }), b = await connect(space, token, { v: 2 }), c = await connect(space, token, { v: 2 });
  const d = await connect(space, token);
  a.send(cat([1], leb(Number(c.welcome.id)), [9, 9]));
  assert.deepEqual([...await c.next(bin)], [...leb(1), 9, 9]);
  assert.equal(await b.next((m) => bin(m) || "body" in m, 300), null);
  assert.equal(await d.next((m) => bin(m) || "body" in m, 300), null);
  a.send(cat([1], leb(Number(d.welcome.id)), [8]));
  assert.deepEqual(await d.next((m) => "body" in m), { from: "1", body: "CA" });
});

test("an older device's JSON reaches v2 devices as binary", async () => {
  const space = rand(16), token = rand(32);
  const old = await connect(space, token), v2 = await connect(space, token, { v: 2 }), other = await connect(space, token, { v: 2 });
  old.send({ body: Buffer.from([1, 2, 3]).toString("base64url") });
  assert.deepEqual([...await v2.next(bin)], [...leb(1), 1, 2, 3]);
  assert.ok(await other.next(bin));
  old.send({ to: v2.welcome.id, body: "BA" });
  assert.deepEqual([...await v2.next(bin)], [...leb(1), 4]);
  assert.equal(await other.next(bin, 300), null);
});

test("malformed or oversized binary frames are dropped", async () => {
  const space = rand(16), token = rand(32);
  const a = await connect(space, token, { v: 2 }), b = await connect(space, token, { v: 2 });
  a.send(Uint8Array.of(2, 1, 2));
  a.send(Uint8Array.of(1, 0x80));
  a.send(new Uint8Array(0));
  a.send(cat([0], new Uint8Array(70_000)));
  assert.equal(await b.next((m) => bin(m) || "body" in m, 800), null);
  a.send(cat([0], [5]));
  assert.deepEqual([...await b.next(bin)], [...leb(1), 5]);
});

// Binary before auth is a failed auth, as any non-auth text is.
test("binary before auth closes the socket", async () => {
  const c = await connect(rand(16), rand(32), { auth: false });
  c.send(cat([0], [1]));
  assert.equal(await c.closedWith(), 4001);
});

test("alive forwards nothing", async () => {
  const space = rand(16), token = rand(32);
  const a = await connect(space, token, { v: 2 }), b = await connect(space, token, { v: 2 }), c = await connect(space, token);
  a.send({ t: "alive" });
  assert.equal(await b.next((m) => bin(m) || m.t === "alive" || "body" in m, 400), null);
  assert.equal(await c.next((m) => m.t === "alive" || "body" in m, 100), null);
});

test("alive every 5 s keeps holds past 10 s", { timeout: 30_000 }, async () => {
  const space = rand(16), token = rand(32);
  const a = await connect(space, token, { v: 2 }), b = await connect(space, token);
  a.send({ t: "hold", ids: [rand(16)] });
  assert.ok(await b.next((m) => m.t === "holds" && m.holds[a.welcome.id]));
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    a.send({ t: "alive" });
  }
  assert.equal(await b.next((m) => m.t === "holds" && !Object.keys(m.holds).length, 100), null);
  a.send({ t: "hold", ids: [rand(16)] });
  assert.ok(await b.next((m) => m.t === "holds" && m.holds[a.welcome.id]?.length === 2));
});

test("a connection that names the one it replaces closes it, with its holds", async () => {
  const space = rand(16), token = rand(32), id = rand(16);
  const a = await connect(space, token, { v: 2 });
  const b = await connect(space, token, { v: 2 });
  a.send({ t: "hold", ids: [id] });
  assert.ok(await b.next((m) => m?.t === "holds" && m.holds[a.welcome.id]));
  const again = await connect(space, token, { v: 2, replaces: a.welcome.id });
  assert.deepEqual(again.welcome.peers, [b.welcome.id]);
  assert.deepEqual(again.welcome.holds, {});
  assert.deepEqual(await b.next(type("leave")), { t: "leave", id: a.welcome.id });
  assert.ok(await a.closedWith());
  again.send({ t: "hold", ids: [id] });
  assert.deepEqual((await b.next((m) => m?.t === "holds" && m.holds[again.welcome.id])).holds, { [again.welcome.id]: [id] });
  // a stranger's id, or its own, closes nothing
  const c = await connect(space, token, { v: 2, replaces: "999" });
  assert.deepEqual(c.welcome.peers.sort(), [b.welcome.id, again.welcome.id].sort());
});
