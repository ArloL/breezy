import { test } from "node:test";
import assert from "node:assert/strict";
import { leb, readLeb, parseFrame, outFrame } from "../src/frames.js";

test("leb round-trips and uses the shortest form", () => {
  const sizes = { 0: 1, 127: 1, 128: 2, 16383: 2, 16384: 3, 4294967295: 5, 4294967296: 5 };
  for (const [n, size] of Object.entries(sizes)) {
    const b = leb(Number(n));
    assert.equal(b.length, size);
    assert.deepEqual(readLeb(b, 0), { value: Number(n), next: size });
  }
  assert.deepEqual([...leb(300)], [0xac, 0x02]);
});

test("readLeb reads at an offset and stops at the end of the number", () => {
  assert.deepEqual(readLeb(Uint8Array.of(9, 0xac, 0x02, 7), 1), { value: 300, next: 3 });
});

test("malformed LEB is null", () => {
  assert.equal(readLeb(Uint8Array.of(0x80), 0), null);
  assert.equal(readLeb(new Uint8Array(0), 0), null);
  assert.equal(readLeb(Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x80, 0x01), 0), null);
  assert.equal(readLeb(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0x7f), 0), null);
});

test("parseFrame reads broadcast and directed frames", () => {
  assert.deepEqual(parseFrame(Uint8Array.of(0, 5, 6)), { to: null, body: Uint8Array.of(5, 6) });
  assert.deepEqual(parseFrame(Uint8Array.of(0)), { to: null, body: new Uint8Array(0) });
  assert.deepEqual(parseFrame(Uint8Array.of(1, 0xac, 0x02, 5)), { to: 300, body: Uint8Array.of(5) });
});

test("malformed frames are null", () => {
  assert.equal(parseFrame(new Uint8Array(0)), null);
  assert.equal(parseFrame(Uint8Array.of(2, 1)), null);
  assert.equal(parseFrame(Uint8Array.of(1)), null);
  assert.equal(parseFrame(Uint8Array.of(1, 0x80)), null);
});

test("outFrame puts the sender's number before the body", () => {
  assert.deepEqual([...outFrame(300, Uint8Array.of(7, 8))], [0xac, 0x02, 7, 8]);
  assert.deepEqual([...outFrame(1, new Uint8Array(0))], [1]);
});
