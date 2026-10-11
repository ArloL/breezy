import { test } from "node:test";
import assert from "node:assert/strict";
import * as V from "../virtual.mjs";
import { Relay } from "../relay.mjs";

V.install();

const token = "A".repeat(43);
const id = (n) => String.fromCharCode(65 + n).repeat(22);

function setup() {
  const got = new Map();
  const ctx = new V.Context("relay", 1);
  const relay = new Relay(ctx, {
    toClient: (c, d) => got.get(c).push(typeof d === "string" ? JSON.parse(d === "pong" ? '"pong"' : d) : d),
    closeClient: (c, code) => got.get(c).push({ closed: code }),
  });
  const conn = async () => {
    const c = {};
    got.set(c, []);
    await relay.open(c);
    return c;
  };
  return { relay, got, conn, ctx };
}

test("auth, a hold, and a replacement that takes the old connection's holds", async () => {
  const { relay, got, conn } = setup();
  const a = await conn(), b = await conn();
  await relay.message(a, JSON.stringify({ t: "auth", token, v: 2 }));
  await relay.message(b, JSON.stringify({ t: "auth", token, v: 2 }));
  const aid = got.get(a)[0].id;
  await relay.message(a, JSON.stringify({ t: "hold", ids: [id(0)] }));
  assert.deepEqual(relay.holds(), { [aid]: [id(0)] });
  const a2 = await conn();
  await relay.message(a2, JSON.stringify({ t: "auth", token, v: 2, replaces: aid }));
  assert.deepEqual(relay.holds(), {});
  assert.deepEqual(got.get(a).at(-1), { closed: 1000 });
  // the old socket stays until its close comes back
  assert.equal(relay.state.sockets.length, 3);
  await relay.closed(a);
  assert.equal(relay.state.sockets.length, 2);
  assert.ok(got.get(b).some((m) => m.t === "leave" && m.id === aid));
});

test("ping is answered without the object, and holds lapse after 10 s of silence", async () => {
  const { relay, got, conn, ctx } = setup();
  const a = await conn();
  await relay.message(a, JSON.stringify({ t: "auth", token, v: 2 }));
  await relay.message(a, "ping");
  assert.equal(got.get(a).at(-1), "pong");
  await relay.message(a, JSON.stringify({ t: "hold", ids: [id(1)] }));
  assert.equal(Object.keys(relay.holds()).length, 1);
  for (let i = 0; i < 10 && V.next(ctx) !== null; i++) {
    V.setTime(V.next(ctx));
    V.fire(ctx);
    await V.settle();
  }
  assert.deepEqual(relay.holds(), {});
});
