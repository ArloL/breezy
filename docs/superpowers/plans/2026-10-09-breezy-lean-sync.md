# Breezy lean sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A gesture's end reaches the others in one push and one relay hop, and every live body carries a tenth of today's bytes, without breaking older devices in the same space.

**Architecture:** `sync.php` merges pull into push, and gzips/inflates. The engines make one request per cycle and apply records that ride in `pushed`. A MessagePack codec (both languages) and a pure `compact` module turn cursor and live bodies into delta-encoded arrays with splices and groups. `Live` picks the format and pipe per recipient: compact unsealed binary on `v: 2` channels, compact sealed over a binary relay frame when every relay recipient is `v: 2`, JSON otherwise. The relay gets short ids and binary frames, transcoding for older devices.

**Tech Stack:** Plain ES modules and `node --test`, Swift 6 / Swift Testing, PHP 8 / PDO, a Cloudflare Worker with Durable Objects, WebRTC data channels, WKWebView on the Mac.

**Spec:** `docs/superpowers/specs/2026-10-09-breezy-lean-sync-design.md`. Background: the sync, multiplayer and WebRTC designs in the same folder.

## Global Constraints

- `sync.php` and the relay are always current; only devices lag. Both serve older devices exactly as before.
- Older devices: no `since` on POST, no `Content-Encoding`, JSON text relay frames, JSON sealed bodies, sealed text on channels, `presence` without `v`/`boards`, `pushed` without `records`.
- `presence`, `pushed`, `offer`, `answer`, `ice` stay sealed JSON. Only `cursor` and `live` have a compact form.
- `seq` is one counter per `Live` for cursor and live, across formats and pipes. `at` is ms since the `Live` started (JSON: rounded to 0.1; compact: integer tenths of a ms).
- Gates: 8 ms for channels, 50 ms for the relay. Keyframe at least every 1000 ms. Heartbeat `{"t":"alive"}` after 5 s of relay silence while holding. `records` in `pushed` only when the sealed body stays ≤ 60 000 bytes. Request bodies over 1024 bytes are deflated.
- BreezyKit takes Apple frameworks only; `WebPeerTransport` stays in the app target.
- Code matches its surroundings: two-space indent, short doc comments only where the code does not say it, no new dependencies.
- Commit messages: one plain sentence saying what changed, in the repo's style, no session links.
- After every task: `node --test web/test/*.test.js` and `swift test --package-path BreezyKit` pass; tasks touching `server/` also pass `server/test.sh`, those touching `relay/` also pass `relay/test.sh`.

## Review Focus

- A space where one device is older: it still sees everyone's cursors, drags and typing (JSON to it), and the others see its (Tasks 9, 11).
- A receiver whose cursor lags `pushed`'s first version, or with another epoch, pulls instead of applying (Tasks 3, 4).
- A splice whose base the receiver lacks (lost delta, joined mid-gesture) is ignored, and the next keyframe puts the text right (Tasks 7, 8).
- A peer that switches board, or a Mac with two board windows, keeps seeing and losing cursors correctly under recipient filtering (Tasks 9, 11).
- A text frame arriving on a `v: 2` channel, or binary on an older one, is dropped (Tasks 10, 12).

---

## File structure

| File | Responsibility |
|---|---|
| `server/sync.php`, `server/test/sync.test.mjs` | `since` on POST, gzip, inflate |
| `web/sync/engine.js`, `BreezyKit/.../Sync.swift` | One request per cycle, compressed requests, `receivePushed` |
| `web/sync/msgpack.js`, `BreezyKit/.../MessagePack.swift`, `Fixtures/msgpack.json` | MessagePack subset |
| `web/sync/compact.js`, `BreezyKit/.../Compact.swift`, `Fixtures/live2.json` | Compact cursor/live bodies: encoder with deltas, keyframes, splices, groups; decoder state |
| `web/sync/live.js`, `BreezyKit/.../Live.swift` | Versions, formats, gates, recipients, alive, binary relay frames |
| `web/sync/direct.js`, `web/sync/rtc.js`, `BreezyKit/.../Direct.swift`, `Breezy/Live/peer.html`, `Breezy/Live/WebPeerTransport.swift` | `v` in offer/answer, binary channel messages |
| `relay/src/worker.js`, `relay/src/frames.js`, `relay/test/*` | Short ids, binary frames, transcoding, `alive` |
| `web/sync/spaces.js`, `web/library.js`, `BreezyKit/.../Spaces.swift`, `Breezy/Library/Library.swift` | Wiring: `pushed` records, `boards`, starts |

Work stays on branch `lean-sync`. Ask the user before pushing (a push to `main` deploys `sync.php`) and before `npm --prefix relay run deploy`.

---

# Phase 1: durable sync

### Task 1: `sync.php` answers a push with what changed since, gzips, and inflates

**Files:** Modify `server/sync.php`; Test `server/test/sync.test.mjs`.

**Interfaces — produces:** `POST ?space=S` body `{writes, since?}`. With integer `since ≥ 0`: response gains `records: [{id, version, blob, stale?}]` and `cursor`. Request with `Content-Encoding: deflate` is raw DEFLATE.

- [ ] **Step 1: Failing tests** in `server/test/sync.test.mjs` (extend `client` with `pushSince(writes, since)` and a `raw` option for headers/body):
  - push with `since: 0` into a space that has records 1–2 from another client: `records` holds 1–2, not the request's own write (version 3); `cursor` is 3.
  - push with `since` after 600 others' writes: `records.length === 500`, `cursor === records[499].version`.
  - push with `since` whose own write is refused: `records` holds the stored record once (it is also in `refused`; that is fine) — assert `cursor` equals the space version.
  - push without `since`: body has exactly `accepted`, `refused`, `epoch` keys (plus `relay` when configured).
  - `since: -1` or `"x"` → 400 `{error: "since"}`.
  - `Accept-Encoding: gzip` on GET → `content-encoding: gzip` and the same JSON (Node's fetch unpacks it).
  - POST with `Content-Encoding: deflate` and `zlib.deflateRawSync(JSON)` body → 200 as uncompressed; a deflated body that inflates past 1 048 576 bytes → 413; garbage → 400.
- [ ] **Step 2:** `server/test.sh` → the new tests fail.
- [ ] **Step 3: Implement.** After the CORS block and the OPTIONS reply: `ob_start('ob_gzhandler');` (it gzips only for clients that send `Accept-Encoding: gzip`; `exit` flushes it). Add `Content-Encoding` to `Access-Control-Allow-Headers`. Reading the body:

```php
$body = file_get_contents('php://input', false, null, 0, MAX_REQUEST + 1);
if (strlen($body) > MAX_REQUEST) reply(413);
if (strtolower($_SERVER['HTTP_CONTENT_ENCODING'] ?? '') === 'deflate') $body = inflated($body);
```

```php
/** Raw DEFLATE `$data` inflated; 413 past MAX_REQUEST, 400 when it is not DEFLATE. */
function inflated(string $data): string {
  $z = inflate_init(ZLIB_ENCODING_RAW);
  $out = '';
  foreach (str_split($data, 65536) as $chunk) {
    $part = @inflate_add($z, $chunk, ZLIB_SYNC_FLUSH);
    if ($part === false) reply(400, ['error' => 'encoding']);
    $out .= $part;
    if (strlen($out) > MAX_REQUEST) reply(413);
  }
  $rest = @inflate_add($z, '', ZLIB_FINISH);
  if ($rest === false || inflate_get_status($z) !== ZLIB_STREAM_END) reply(400, ['error' => 'encoding']);
  $out .= $rest;
  if (strlen($out) > MAX_REQUEST) reply(413);
  return $out;
}
```

  `since`: `$since = is_array($request) && array_key_exists('since', $request) ? $request['since'] : null; if ($since !== null && (!is_int($since) || $since < 0)) reply(400, ['error' => 'since']);`. After the transaction, when `$since !== null`:

```php
$own = array_column($accepted, 'version');
$rows = query($db, 'SELECT id, version, data, epoch FROM records WHERE space = ? AND version > ? ORDER BY version LIMIT ' . PAGE, [$space, $since])->fetchAll(PDO::FETCH_ASSOC);
$last = $rows ? (int)$rows[count($rows) - 1]['version'] : 0;
$out['cursor'] = count($rows) === PAGE ? $last : max($version, $last, $since);
$out['records'] = array_values(array_map(fn($r) => pulled($r, $epoch), array_filter($rows, fn($r) => !in_array((int)$r['version'], $own, true))));
```

  Rows read after the commit may include others' later writes; they are returned and covered by `cursor`, so nothing is skipped. `$accepted` must keep versions as ints (it does).
- [ ] **Step 4:** `server/test.sh` passes (it also runs `HTTPTransportTests`).
- [ ] **Step 5:** Commit "Answer a push with what changed since the device's cursor, gzip answers and take deflated requests".

### Task 2: The web engine makes one request per cycle and deflates big requests

**Files:** Modify `web/sync/engine.js`, `web/test/helpers/fake-server.js`; Test `web/test/engine.test.js`.

**Interfaces — produces:** `transport.push(writes, since)` (since may be `undefined`); `FakeServer.push(writes, since)` mirrors Task 1 (records minus own, cursor rule); `FakeTransport.calls` counts requests.

- [ ] **Step 1: Failing tests:**
  - "an edit syncs in one request": pair `a`,`b`; `a` edits; `a.transport.calls = 0`; `await a.engine.sync()`; `calls === 1`; then `b` syncs and sees it.
  - "a device never pulls back what it pushed": `a` edits and syncs; spy on `server.pull`/`push` results returned to `a`: no record `a` wrote appears in any later `records`/pull for `a` (wrap `a.transport` to collect ids).
  - "a combined push that brings a full page goes on pulling": 600 records by another device, then `a` edits and syncs: `a` has all 600 and its cursor equals the server's version.
  - "a resync does not combine": after `server.restore`, `a`'s next cycle calls `pull` first (record call order in the fake).
  - `HttpTransport` test with a stubbed `fetch`: a body over 1024 B goes with `Content-Encoding: deflate` and inflates (via `node:zlib.inflateRawSync`) to the JSON; a small one goes plain.
- [ ] **Step 2:** fail.
- [ ] **Step 3: Implement.** In `HttpTransport.send`, when the JSON is longer than 1024: `body = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer()` and header `Content-Encoding: deflate`. `push(writes, since)` sends `{writes, ...(since === undefined ? {} : {since})}`. In `cycle()`: before the pull loop, `if (!this.store.state.resync && pending writes exist)` skip straight to the push loop with `since = this.store.state.cursor` for every push round; after each push result with `records`, run the same epoch/decode/apply/advance as a pull page, and if `records.length === PAGE_SIZE` run the pull loop from the new cursor before the next round. Factor the page handling into `async takePage(page, keys, same)` returning `"again" | "stop" | "done" | "more"` so pull and push share it. `onPulled(cursor)` after the push loop when any records were taken. Keep the existing pull-then-push path for everything else.
- [ ] **Step 4:** `node --test web/test/*.test.js` passes.
- [ ] **Step 5:** Commit "Push and pull in one request, and deflate big requests, on the web".

### Task 3: `pushed` carries the records on the web

**Files:** Modify `web/sync/engine.js`, `web/sync/live.js`, `web/sync/spaces.js`; Test `web/test/engine.test.js`, `web/test/live.test.js`, `web/test/spaces.test.js`.

**Interfaces — produces:** `engine.onPushed({version, epoch, records})` (was `version`); `live.sendPushed({version, epoch, records})` drops `records` when the sealed body would pass 60 000 B; `live.onPushed(version, {epoch, records} | null)`; `engine.receivePushed({epoch, records}): Promise<boolean>` — true when applied without a pull.

- [ ] **Step 1: Failing tests:**
  - engine: `b.engine.receivePushed(...)` with `a`'s just-pushed records applies them, advances `b`'s cursor to the last version, makes no transport call, calls `onPulled`.
  - returns false and changes nothing when: the epoch differs; versions are not consecutive; `b.store.state.cursor < v₁ − 1`; `records` empty or absent.
  - a record that cannot be decoded is counted unreadable as in a pull (same `decodeAll` path).
  - live: `pushed` with records reaches the other side with them; one whose records would be too big goes without `records` but with `version`.
  - spaces: after `a` pushes, `b` shows the change with zero HTTP calls (fake transport `calls` unchanged); with a gap it syncs.
- [ ] **Step 2:** fail.
- [ ] **Step 3: Implement.** In `cycle`, collect the accepted writes' `{id, version, blob}` per round (`sent` gains blobs) and call `onPushed({version: max, epoch: result.epoch, records})`. `receivePushed`: check `epoch === store.state.epoch`, sort by version, consecutive, `cursor >= v₁ - 1`; `flushLocal()`; `decodeAll`; `apply`; `store.advance(vₙ)`; `onPulled(cursor)`; return true. Runs inside the engine's queue: if `this.running`, await it first. `Live.sendPushed`: seal `{t: "pushed", version, epoch, records}`; if over 60 000, seal again without `records`. Receiving: pass `b.records`/`b.epoch` when `records` is an array of objects with string `id`, `blob` and integral `version`. `spaces.js`: `live.onPushed = async (v, extra) => { if (!(extra && await g.engine.receivePushed(extra))) g.engine.sync(); }`.
- [ ] **Step 4:** pass.
- [ ] **Step 5:** Commit "Send the pushed records in pushed, so that the others take them without pulling, on the web".

### Task 4: The same in BreezyKit

**Files:** Modify `BreezyKit/Sources/BreezyKit/Sync.swift`, `Live.swift`, `Spaces.swift`; Tests `SyncFakes.swift`, `SyncTests.swift`, `LiveTests.swift`, `HTTPTransportTests.swift`.

**Interfaces — produces:** `Transport.push(_ writes: [Write], since: Int?)`; `PushResult.records: [Pulled]?`, `PushResult.cursor: Int?`; `SyncEngine.onPushed: ((Pushed) -> Void)?` with `public struct Pushed: Equatable, Sendable { version: Int; epoch: String?; records: [Pulled] }`; `SyncEngine.receivePushed(_ p: Pushed) async -> Bool`; `Live.sendPushed(_ p: Pushed)`; `Live.onPushed: ((Int, Pushed?) -> Void)?`.

- [ ] **Step 1:** Port every test from Tasks 2 and 3 to Swift Testing with the Swift fakes; `HTTPTransportTests` gains a combined push against the real server and a deflated request (body > 1024 B).
- [ ] **Step 2:** fail.
- [ ] **Step 3: Implement** as on the web. Deflate: `try (json as NSData).compressed(using: .zlib) as Data` (raw DEFLATE), header `Content-Encoding: deflate`.
- [ ] **Step 4:** `swift test --package-path BreezyKit` and `server/test.sh` pass.
- [ ] **Step 5:** Commit "Push and pull in one request, deflate big requests and take records from pushed in BreezyKit".

# Phase 2: compact bodies

### Task 5: MessagePack in JS with a shared fixture

**Files:** Create `web/sync/msgpack.js`, `BreezyKit/Tests/Fixtures/msgpack.json`; Test `web/test/msgpack.test.js`.

**Interfaces — produces:** `pack(value): Uint8Array`, `unpack(bytes): value` (throws on malformed or trailing bytes). Values: `null`, booleans, integers (safe range) and `Float32(n)` / plain non-integer numbers (float64), strings, `Uint8Array` (bin), arrays, `Map` (keys of any supported type). `export class Float32 { constructor(v) }` marks float32. `unpack` returns float32 and float64 as numbers, maps as `Map`.

- [ ] **Step 1:** Fixture `msgpack.json`: `{"cases": [{"value": V, "hex": "…"}]}` where V is JSON with tags: `{"f32": 1.5}`, `{"bin": "base64url"}`, `{"map": [[k, v], …]}`. Cases: 0, 127, 128, 255, 256, 65535, 65536, 2^32, −1, −32, −33, −128, −129, −32768, −32769, −2^31−1, `""`, a 31-byte string, a 32-byte string, a 300-byte string, `"é→😀"`, bin 16 bytes, bin 300 bytes, `[]`, a 15-element array, a 16-element array, `{"map": []}`, a 16-entry map with int keys, `{"f32": 0.1}` (hex `ca3dcccccd`), `1.1` (float64 `cb3ff199999999999a`), true, false, null. Test: `pack(fromJSON(v))` equals hex; `toJSON(unpack(hex))` equals v; `unpack` throws on `"c1"`, a truncated `"da00"` and trailing bytes.
- [ ] **Step 2:** fail. **Step 3:** implement with a growable `Uint8Array` writer and `DataView`; integers pick fixint/uint8/16/32/64 or negative fixint/int8/16/32/64; strings via `TextEncoder`. **Step 4:** pass. **Step 5:** Commit "Add a MessagePack subset on the web, held to a shared fixture".

### Task 6: MessagePack in BreezyKit

**Files:** Create `BreezyKit/Sources/BreezyKit/MessagePack.swift`; Test `BreezyKit/Tests/BreezyKitTests/MessagePackTests.swift`.

**Interfaces — produces:** `public indirect enum Pack: Equatable, Sendable { case null, bool(Bool), int(Int64), float32(Float), float64(Double), string(String), bin(Data), array([Pack]), map([(Pack, Pack)]) }` (Equatable by hand for `map`); `func packed() -> Data`; `static func unpack(_ d: Data) throws -> Pack`; helpers `var int: Int64?`, `var number: Double?` (int, f32 or f64), `var string`, `var bin`, `var array`, `var map`.

- [ ] Steps as Task 5, reading the same fixture. Commit "Add the MessagePack subset to BreezyKit".

### Task 7: Compact cursor and live bodies in JS

**Files:** Create `web/sync/compact.js`, `BreezyKit/Tests/Fixtures/live2.json`; Test `web/test/compact.test.js`.

**Interfaces — produces:**

```js
export const KEYFRAME_MS = 1000;
export const FIELDS = ["pos", "size", "w", "text", "notes", "color", "title", "kind"]; // index = key
export function fnv1a(text) // FNV-1a 32 over UTF-16 code units, unsigned
export function splice(before, after) // [at, del, ins] for the shortest common prefix/suffix split, in UTF-16 units
export function encodeCursor({ seq, at, x, y, board }) // board: base64url id or null to leave out
/** One pipe's encoder: remembers what it last sent. */
export class LiveEncoder {
  /** Forces the next body to be a keyframe. */
  reset()
  /** { board, items: {id: fields since start}, starts: {id: [x, y]}, caret, cursor: [x,y]|null } → bytes */
  encode(body, { seq, at, now })
}
/** Turns compact bytes into the JSON-shaped bodies Live already handles, keeping per-sender state. */
export class LiveDecoder {
  /** → {t:"cursor", seq, at, board, x, y} | {t:"live", seq, at, board, items, caret, cursor} | null */
  decode(bytes, overlay /* Map id → fields this receiver shows for this sender */)
}
export const isCompact = (bytes) => bytes.length > 0 && ((bytes[0] & 0xf0) === 0x90 || bytes[0] === 0xdc);
```

Encoder rules (spec, Compact bodies):
- keyframe when `reset()` was called, it is the first body, or `now - lastKeyframe >= KEYFRAME_MS`; a keyframe carries `board`, every field of `items`, and `group` with `ids` and `starts`.
- otherwise fields whose value differs (deep equality) from the last sent value for that id; `board` only when it changed.
- text fields (`text`, `notes`, `title`) that differ: `[fnv1a(lastSent), ...splice(lastSent, now)]` when that encodes shorter than the string, else the string.
- group: ids whose `pos` is in `items` and in `starts`, at least two, all with the same `pos − start` (exactly equal numbers): they leave `items`' `pos` and go as `[[dx, dy], ids?, starts?]`; `ids`/`starts` when keyframe or the id list changed. Ids in a group still send their other fields in `items`.
- coordinates, `w` and group values as `Float32`; ids and board as 16-byte bins; `kind` 0/1; `at` as `Math.round(at * 10)`.

Decoder rules: keeps `board` (last seen per kind), group `ids`/`starts`; maps keys back to names, bins to base64url, splices to strings using `overlay.get(id)?.[name]`: apply only when `fnv1a(current) === hash`, else omit that field; `kind` back to `"card"`/`"lane"`; returns `at` in ms (`/10`); returns null on anything malformed (wrong types, unknown type code, missing board with none remembered).

- [ ] **Step 1:** `live2.json` cases, each a sequence of `{ "now", "body" (encoder input), "hex" (expected bytes), "decoded" (expected decode output given the overlay so far) }`, covering: cursor with and without board, hide; a first live body (keyframe) with one card's `pos`; a delta with only `pos`; text typed: keyframe with full text, then a splice, then a splice applied to a receiver whose text differs (field omitted); a group of three cards moving, keyframe then deltas with only the offset; a new card with `kind`; a keyframe after 1000 ms resending everything; caret and folded cursor. Tests: encoder bytes equal `hex` in order; decoder outputs equal `decoded`; `fnv1a("")` is 2166136261 and `fnv1a("a")` is 3826002220; `splice("abc", "abXc")` is `[2, 0, "X"]`; `splice("😀", "")` is `[0, 2, ""]`.
- [ ] **Steps 2–4** as usual. **Step 5:** Commit "Add compact cursor and live bodies with deltas, splices and groups on the web".

### Task 8: Compact bodies in BreezyKit

**Files:** Create `BreezyKit/Sources/BreezyKit/Compact.swift`; Test `CompactTests.swift`.

**Interfaces — produces:** `enum Compact { static let keyframe: TimeInterval = 1; static func fnv1a(_ s: String) -> UInt32; static func splice(_ a: String, _ b: String) -> (at: Int, del: Int, ins: String); static func encodeCursor(seq:at:x:y:board:) -> Data; static func isCompact(_ d: Data) -> Bool }`; `final class LiveEncoder { func reset(); func encode(_ body: LiveBody, seq: Int, at: Double, now: Date) -> Data }` with `public struct LiveBody { board: String; items: [String: LiveFields]; starts: [String: [Double]]; caret: Caret?; cursor: [Double]? }`; `final class LiveDecoder { func decode(_ d: Data, overlay: [String: LiveFields]) -> [String: JSONValue]? }` returning the same JSON-shaped dictionary `heard` takes. UTF-16 throughout (`Array(s.utf16)`).

- [ ] Steps as Task 7 against `live2.json`. Commit "Add compact cursor and live bodies to BreezyKit".

# Phase 3: relay

### Task 9 (relay): short ids, binary frames, transcoding and `alive`

**Files:** Create `relay/src/frames.js` (pure: `leb(n)`, `readLeb(bytes, i)`, `parseFrame(bytes)`, `outFrame(from, body)`); Modify `relay/src/worker.js`; Test `relay/test/frames.test.mjs` (run by `relay/test.sh` beside holds), `relay/test/relay.test.mjs`.

**Interfaces — produces:**
- Connection ids: `String(n)` from `n = (await storage.get("next") ?? 0) + 1`, stored before `welcome`.
- `auth` may carry `v: 2`; the attachment keeps `v`.
- Device → relay binary: `0x00 body…` broadcast; `0x01 leb(to) body…` to one. Relay → `v: 2` device binary: `leb(from) body…`. Relay → older device: JSON `{from, body: base64url}`. JSON `{to?, body}` from an older device reaches `v: 2` devices as binary.
- `{"t":"alive"}` updates `last` and forwards nothing (it already does, as it has no `body`; keep a test).

- [ ] **Step 1: Failing tests:** frames unit tests (round trip `leb` for 0, 127, 128, 16384, 2^32; malformed frames → null); relay: ids are `"1"`, `"2"` in order; a v2 sender's binary broadcast reaches a v2 receiver as binary with the sender's number and an older receiver as JSON with the same bytes in base64url; an older sender's JSON reaches a v2 receiver as binary; `0x01` with `to` reaches only that one; `alive` reaches nobody and keeps holds past 10 s when repeated every 5 s.
- [ ] **Step 2–4.** In `webSocketMessage`, branch on `typeof message !== "string"` for binary from an authed connection. **Step 5:** Commit "Give relay connections short ids and carry bodies as binary frames to devices that ask, translating for older ones".

# Phase 4: live

### Task 10: Channels say their version and carry bytes

**Files:** Modify `web/sync/direct.js`, `web/sync/rtc.js`, `web/test/helpers/fake-transport.js`, `BreezyKit/.../Direct.swift`, `Breezy/Live/peer.html`, `Breezy/Live/WebPeerTransport.swift`, `LiveFakes.swift`; Tests `web/test/direct.test.js`, `web/test/rtc.test.js`, `DirectTests.swift`.

**Interfaces — produces:**
- `offer`/`answer` bodies carry `v: 2`. `Direct.version(id) → 1 | 2` (2 when the other side's offer/answer said so). `Direct.sendBytes(id, Uint8Array)`; `Direct.send(id, text)` stays.
- `transport.sendBytes(id, bytes)`; `transport.onMessage(id, data)` where `data` is a string or a `Uint8Array`. `rtc.js` sets `ch.binaryType = "arraybuffer"` and wraps `ArrayBuffer` in `Uint8Array`.
- `Direct`'s `message(from, data)` is called only for strings on version-1 links and bytes on version-2 links; anything else is dropped.
- Swift: `PeerTransport.sendBytes(_ peer: String, _ data: Data) -> Bool`; `onMessage: ((String, PeerMessage) -> Void)?` with `public enum PeerMessage: Equatable, Sendable { case text(String), bytes(Data) }`. `peer.html` gains `sendBytes(id, b64)` (base64url → `Uint8Array` → `ch.send`) and posts `{kind: "message", bytes: base64url}` for binary messages.

- [ ] **Step 1: Failing tests:** offerer's and answerer's `version` is 2 after the exchange with a new peer and 1 when the other side's offer/answer has no `v`; text on a v2 link and bytes on a v1 link are dropped; Swift mirrors.
- [ ] **Steps 2–4.** **Step 5:** Commit "Say the protocol version in offers and answers, and carry bytes on direct channels".

### Task 11: `Live` on the web picks format and pipe per recipient

**Files:** Modify `web/sync/live.js`, `web/library.js`, `web/sync/overlay.js` (add `startPositions(start, ids, board) → {id: [x,y]}`), `web/test/helpers/fake-relay.js` (v2: short ids, binary frames, transcoding, as Task 9); Test `web/test/live.test.js`.

**Interfaces:**
- `setPresence({board, boards, selection})` (`boards` defaults to `[board]` when board set); presence body `{t, v: 2, device, name, board, boards, selection, cursor}` without `colour`.
- `sendLive(board, items, caret, starts)`; the cursor sent while `this.mine.size` and the latest `sendLive` is for `cursorBoard` rides in compact live bodies.
- Peers keep `v` (from presence) and `boards`.
- Each pipe — channels and relay — has its own `Gate` (8 ms / 50 ms), `LiveEncoder` per format (one for compact channel bodies, one for compact relay bodies; `reset()` whenever that pipe's recipient set changes), and sends the latest cursor/live when it fires.
- Recipients for board `b`: roster peers whose `boards` include `b`, or whose `board` is `b` when they sent no `boards`, or with no presence yet. The first cursor after `cursorBoard` changes goes to the whole roster.
- Channel recipients with open v2 links get compact bytes unsealed (`direct.sendBytes`); open v1 links get sealed JSON text (`direct.send`). Relay recipients (no open link): none → nothing; if every one is v2, sealed compact, else sealed JSON; one recipient → `to`. Relay frames are binary (`0x00`/`0x01 leb(to)` + sealed bytes); the socket has `binaryType = "arraybuffer"`.
- Received: binary relay frames → `leb(from)` + sealed bytes; JSON `{from, body}` still handled. Opened plaintext: `isCompact` → `LiveDecoder` per peer (with `p.overlay`), else JSON. Direct v2 bytes → `LiveDecoder` without opening.
- A live body's `cursor` updates the cursor (track push) only when its `seq` is above `p.seqs.cursor`; it then sets `p.seqs.cursor`.
- Heartbeat: `this.frame({t: "alive"})` instead of resending live.
- JSON bodies: `x`, `y`, `pos`, `size`, `w` rounded to 0.01 (`Math.round(v * 100) / 100`), `at` to 0.1; `at = clock() - this.started`.
- `library.js`: passes `startPositions(model.start, live.mine, id)` to `sendLive`.

- [ ] **Step 1: Failing tests** (update existing ones that count frames or read `colour`, `at`):
  - an older peer (simulate with a `Live` whose presence lacks `v`: add a test-only `legacy: true` option that sends JSON and presence without `v`/`boards`) gets JSON cursor and live and sees them; a current peer gets compact from the same sender; both see the same positions.
  - relay frames are binary and a compact cursor over the relay is ≤ 60 B; over a v2 channel ≤ 24 B (assert on `ts[0].sent` byte lengths).
  - with one peer on a channel and one on the relay, the channel peer gets a body every 8 ms and the relay every 50 ms.
  - a peer on board B2 gets no cursor for B1; moving the cursor from B1 to B2 sends one body to everyone, then only to B2 peers; a Mac-like peer with `boards: ["B1","B2"]` gets both.
  - nobody on the board: no relay frame at all; one recipient: frame uses `to`.
  - during a gesture over a v2 channel, one body per frame carries both live and cursor, and the receiver's cursor follows.
  - typing 20 characters into a 560-character card: channel bytes per body after the keyframe ≤ 40; a lost body (skip one `onMessage`) leaves the text unchanged until the next keyframe, then it is right.
  - dragging three cards: bodies after the keyframe carry the offset only (≤ 30 B) and the receiver's overlay has all three positions.
  - heartbeat is `{"t":"alive"}`.
  - presence has no `colour`; `people()` still has the right colour.
- [ ] **Steps 2–4.** **Step 5:** Commit "Send cursors and live edits compact and only to those on the board, with a gate per pipe, on the web".

### Task 12: `Live` in BreezyKit and the Mac app

**Files:** Modify `BreezyKit/.../Live.swift` (`LiveSocket` gains `sendData(_:)` and `onData`; `WebSocketTaskSocket` sends `.data` and stops turning data into strings), `Overlay.swift` (`Records.startPositions`), `Breezy/Library/Library.swift` (`setPresence(board:boards:selection:)` with the space's visible board windows, key first; `sendLive(..., starts:)`), `LiveFakes.swift` (binary relay, as the web fake); Tests `LiveTests.swift`.

- [ ] **Step 1:** Port every test from Task 11; add one with two board windows on the Mac side (`boards: [B1, B2]`).
- [ ] **Steps 2–4.** Build the app: `xcodebuild -project Breezy.xcodeproj -scheme Breezy -derivedDataPath build build`. **Step 5:** Commit "Send cursors and live edits compact and only to those on the board, with a gate per pipe, in BreezyKit and the Mac app".

# Phase 5: end to end and docs

### Task 13: Two browsers, binary all the way

**Files:** Modify `scripts/direct-e2e.mjs`, `README.md`.

- [ ] **Step 1:** In the e2e script, count relay frames by kind (binary vs text) and channel message sizes (wrap `RTCDataChannel.prototype.send` in the page); assert channel messages are binary and cursor bodies ≤ 24 B, relay body frames are binary, and the fallback phase still shows the cursor. Run `node scripts/direct-e2e.mjs`.
- [ ] **Step 2:** README: the relay is deployed before the apps; one line on what goes where (compact on channels, binary relay frames, JSON for older devices).
- [ ] **Step 3:** Commit "Check that two current web apps send binary over the channel and the relay".
