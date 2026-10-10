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
      else if ("receive" in s) wire = bytes(s.receive);
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

const B1 = "YGFiY2RlZmdoaWprbG1ubw", A = "AQEBAQEBAQEBAQEBAQEBAQ";
const valid = (now) => ({ board: B1, items: { [A]: { pos: [now, 0], kind: "card" } }, starts: {}, caret: { id: A, back: false, at: 0 }, cursor: null });

test("an encoder that throws on a bad input is left as it was", () => {
  const bad = [
    { ...valid(1), board: "short" },
    { ...valid(1), items: { short: { pos: [1, 0] } } },
    { ...valid(1), items: { [A]: { kind: "note" } } },
    { ...valid(1), caret: { id: "short", back: false, at: 0 } },
  ];
  for (const b of bad) {
    const enc = new LiveEncoder(), ref = new LiveEncoder();
    for (const e of [enc, ref]) e.encode(valid(0), { seq: 1, at: 0, now: 0 });
    assert.throws(() => enc.encode(b, { seq: 2, at: 1, now: 1000 }), RangeError);
    assert.equal(hex(enc.encode(valid(1), { seq: 2, at: 1, now: 1000 })), hex(ref.encode(valid(1), { seq: 2, at: 1, now: 1000 })));
  }
  const enc = new CursorEncoder(), ref = new CursorEncoder();
  for (const e of [enc, ref]) e.encode({ x: 1, y: 1, board: B1 }, { seq: 1, at: 0, now: 0 });
  assert.throws(() => enc.encode({ x: 1, y: 1, board: "short" }, { seq: 2, at: 1, now: 1000 }), RangeError);
  assert.equal(hex(enc.encode({ x: 1, y: 1, board: B1 }, { seq: 2, at: 1, now: 1000 })), hex(ref.encode({ x: 1, y: 1, board: B1 }, { seq: 2, at: 1, now: 1000 })));
});

test("isCompact tells arrays from other bytes", () => {
  assert.ok(isCompact(bytes("9101")));
  assert.ok(isCompact(bytes("dc0000")));
  assert.ok(!isCompact(bytes("7b")));
  assert.ok(!isCompact(new Uint8Array()));
});

test("fields are keyed by their index", () => {
  assert.deepEqual(FIELDS, ["pos", "size", "w", "text", "notes", "color", "title", "kind", "gone"]);
  assert.equal(KEYFRAME_MS, 1000);
});
