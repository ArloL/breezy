import { test } from "node:test";
import assert from "node:assert/strict";
import { pack, unpack, Float32 } from "../sync/msgpack.js";
import { encode, decode } from "../sync/base64.js";
import { fixture } from "./helpers/fixture.js";

const { cases } = fixture("msgpack.json");

const fromJSON = (v) => {
  if (Array.isArray(v)) return v.map(fromJSON);
  if (v !== null && typeof v === "object") {
    if ("f32" in v) return new Float32(v.f32);
    if ("bin" in v) return decode(v.bin);
    return new Map(v.map.map(([k, x]) => [fromJSON(k), fromJSON(x)]));
  }
  return v;
};

const toJSON = (v) => {
  if (Array.isArray(v)) return v.map(toJSON);
  if (v instanceof Uint8Array) return { bin: encode(v) };
  if (v instanceof Map) return { map: [...v].map(([k, x]) => [toJSON(k), toJSON(x)]) };
  return v;
};

const plain = (v) => {
  if (v instanceof Float32) return Math.fround(v.v);
  if (Array.isArray(v)) return v.map(plain);
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [plain(k), plain(x)]));
  return v;
};

const bytes = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
const hex = (b) => Buffer.from(b).toString("hex");

test("pack matches the shared hex", () => {
  for (const c of cases) assert.equal(hex(pack(fromJSON(c.value))), c.hex, c.hex);
});

test("unpack matches the shared values", () => {
  for (const c of cases) {
    assert.deepEqual(toJSON(unpack(bytes(c.hex))), toJSON(plain(fromJSON(c.value))), c.hex);
  }
});

test("unpack rejects malformed input", () => {
  for (const h of ["c1", "da00", "", "00ff", "cd01", "a3616263c0"]) assert.throws(() => unpack(bytes(h)), h);
});

test("unpack rejects types outside the subset", () => {
  for (const h of ["c70100ff", "c8000100ff", "c900000001ff", "d401ff", "d50100ff", "d6000000000", "d7", "d8", "c4"]) assert.throws(() => unpack(bytes(h)), h);
  assert.throws(() => unpack(bytes("c40001")), "bin8 truncated");
});

test("integers beyond the safe range throw", () => {
  assert.throws(() => unpack(bytes("cf0020000000000000")));
  assert.throws(() => unpack(bytes("d3ffdfffffffffffff")));
  assert.throws(() => pack(2 ** 53));
  assert.throws(() => pack(-(2 ** 53)));
  assert.equal(unpack(bytes("cf001fffffffffffff")), 2 ** 53 - 1);
});

test("float32 survives a round trip", () => {
  assert.equal(unpack(pack(new Float32(0.1))), Math.fround(0.1));
});

test("unpack reads from a view into a larger buffer", () => {
  const big = new Uint8Array([9, 9, 0xa1, 0x61, 9]);
  assert.equal(unpack(big.subarray(2, 4)), "a");
});

test("packed values grow the writer past its first buffer", () => {
  const s = "x".repeat(100000);
  assert.equal(unpack(pack([s, s])).join(""), s + s);
});
