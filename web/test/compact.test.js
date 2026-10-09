import { test } from "node:test";
import assert from "node:assert/strict";
import { CursorEncoder, LiveEncoder, LiveDecoder, fnv1a, splice, isCompact, FIELDS, KEYFRAME_MS } from "../sync/compact.js";
import { fixture } from "./helpers/fixture.js";

const data = fixture("live2.json");
const bytes = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
const hex = (b) => Buffer.from(b).toString("hex");

test("fnv1a hashes UTF-16 code units", () => {
  for (const [text, hash] of data.fnv1a) assert.equal(fnv1a(text), hash, text);
});

test("splice keeps the common prefix and suffix whole", () => {
  for (const [before, after, want] of data.splice) assert.deepEqual(splice(before, after), want, `${before} → ${after}`);
});

for (const c of data.cases) {
  test(`live2: ${c.name}`, () => {
    const cursor = new CursorEncoder(), live = new LiveEncoder(), decoder = new LiveDecoder();
    let overlay = new Map();
    c.steps.forEach((s, i) => {
      const at = `${c.name} step ${i}`;
      let wire;
      if ("redeliver" in s) wire = bytes(c.steps[s.redeliver].hex);
      else {
        const enc = s.cursor ? cursor : live;
        if (s.reset) enc.reset();
        wire = enc.encode(s.cursor ?? s.live, { seq: s.seq, at: s.at, now: s.now });
        assert.equal(hex(wire), s.hex, at);
        assert.ok(isCompact(wire), at);
      }
      if (s.lost) return;
      if (s.overlay) overlay = new Map(Object.entries(s.overlay));
      const got = decoder.decode(wire, overlay);
      assert.deepEqual(got, s.decoded, at);
      for (const [id, f] of Object.entries(got?.items ?? {})) overlay.set(id, { ...overlay.get(id), ...f });
    });
  });
}

test("malformed bodies decode to null", () => {
  for (const m of data.malformed) assert.equal(new LiveDecoder().decode(bytes(m.hex), new Map()), null, m.name);
});

test("isCompact tells arrays from other bytes", () => {
  assert.ok(isCompact(bytes("9101")));
  assert.ok(isCompact(bytes("dc0000")));
  assert.ok(!isCompact(bytes("7b")));
  assert.ok(!isCompact(new Uint8Array()));
});

test("fields are keyed by their index", () => {
  assert.deepEqual(FIELDS, ["pos", "size", "w", "text", "notes", "color", "title", "kind"]);
  assert.equal(KEYFRAME_MS, 1000);
});
