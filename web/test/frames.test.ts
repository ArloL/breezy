import { test } from "node:test";
import assert from "node:assert/strict";
import * as web from "../sync/frames.js";
import * as relay from "../../relay/src/frames.js";

const numbers = [0, 1, 127, 128, 300, 16383, 16384, 2 ** 31, 2 ** 32 - 1, 2 ** 32];

test("leb and readLeb match the relay's byte for byte", () => {
  for (const n of numbers) {
    assert.deepEqual(web.leb(n), relay.leb(n));
    assert.deepEqual(web.readLeb(relay.leb(n), 0), relay.readLeb(relay.leb(n), 0));
  }
  for (const bad of [[0x80], [], [0x80, 0x80, 0x80, 0x80, 0x80, 1], [0xff, 0xff, 0xff, 0xff, 0x7f]]) assert.equal(web.readLeb(Uint8Array.from(bad), 0), null);
});

test("the relay reads the frames a device sends, and a device reads the frames the relay forwards", () => {
  const body = Uint8Array.of(7, 8, 9);
  assert.deepEqual(relay.parseFrame(web.relayFrame(null, body)), { to: null, body });
  for (const n of numbers.slice(0, -1)) {
    assert.deepEqual(relay.parseFrame(web.relayFrame(n, body)), { to: n, body });
    assert.deepEqual(web.parseRelayFrame(relay.outFrame(n, body)), { from: n, body });
  }
  assert.deepEqual([...web.relayFrame(300, body)], [1, 0xac, 0x02, 7, 8, 9]);
  assert.deepEqual(web.parseRelayFrame(Uint8Array.of(5)), { from: 5, body: new Uint8Array(0) });
  assert.equal(web.parseRelayFrame(new Uint8Array(0)), null);
  assert.equal(web.parseRelayFrame(Uint8Array.of(0x80)), null);
});
