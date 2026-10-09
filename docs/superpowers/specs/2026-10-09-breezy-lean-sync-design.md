# Breezy lean sync — design

Fewer round trips between a gesture ending and everyone having it, and fewer bytes for everything that moves. It changes [sync](2026-10-08-breezy-sync-design.md), [multiplayer](2026-10-09-breezy-multiplayer-design.md) and [direct WebRTC](2026-10-09-breezy-webrtc-design.md); records, merge and encryption of records stay as they are.

## Where it stands

Sizes in bytes. Now is what one web app sent while `scripts/direct-e2e.mjs` drove two headless Chromiums: channel messages as handed to `RTCDataChannel.send`, relay frames as seen on the WebSocket (frame byte, sealing and all). Before are earlier measurements, not from this run, of the JSON text protocol with the apps' own sealing; their typing was on a 560-character card.

| Message | Before, channel | Before, relay | Now, channel | Now, relay |
|---|---|---|---|---|
| cursor, a mouse crossing the board | 203 | 260 | 16 | 46 |
| cursor, first body and one a second later (keyframe) | 203 | 260 | 34 | 64 |
| live, dragging 1 card (per mouse move) | 266 | 323 | 32 as the card reaches a grid line, else 21 | 64, else 53 |
| live, a key typed in a new card, first to eleventh | 1027 (560-character card) | 1084 (560-character card) | 37 to 44, 103 for a keyframe | 69 to 76, 135 for a keyframe |

A drag sends one body per move with the cursor inside. The card snaps to the 24-point grid, so its `pos` changes only on about every other move, and then goes as its `group`'s offset. On the relay a `pushed` notice of 374 B follows each durable push, such as a gesture's end, and a `presence` of 250 to 270 B follows a press that changes the selection. A typed key's body grows by a byte per key between keyframes, as the text goes whole until a splice is shorter. The unit tests measure a drag of one card or three with a folded cursor at 32 B direct, and of one card at 62 B from the relay: past a keyframe, a group's body does not grow with its members.

A gesture's end reaches the others after three HTTP round trips in a row: the holder's pull and push, then each receiver's pull. After: one push, then the relay.

## Compatibility

`sync.php` and the relay are always current; only devices lag. So `sync.php` and the relay serve both older devices and current ones. A space may mix them, and an older device keeps working without the savings. The relay is deployed before the apps, as the deploy is by hand.

- A device's `presence` carries `v: 2`. Bodies in the compact format go only to connections known to be `v: 2`. A receiver reads both formats always: compact plaintext begins with a MessagePack array byte (`0x90`–`0x9f`, `0xdc`), JSON with `{`.
- Offers and answers carry `v: 2`. A channel between two `v: 2` ends carries compact bodies unsealed, as binary messages; any other channel keeps sealed JSON text.

## Durable sync

### One request per cycle

`POST sync.php?space=S` takes `{writes, since}`. With `since`, after the writes commit, the response adds what a `GET` from `since` would return, leaving out this request's own accepted writes:

- `records`: those with `version > since`, ordered, at most 500, without the ones just written.
- `cursor`: the version of the last row read when 500 were read, else the space's version after the writes.

Without `since`, as older devices send it, the response is as before.

The `POST` may also carry the device's `epoch`. When it does, and the space is missing or has another epoch, nothing is written and the answer is `{accepted: [], refused: [], epoch}`. Without this, a push that goes before the pull after a restore could be taken on a base whose number now means other contents.

A cycle sends one `POST` with `since` and `epoch` when there is something to push, the store has an epoch and the store is not resyncing. It merges `refused`, then `records`, and advances the cursor. When `records` is full it continues with `GET`s as now. Otherwise a cycle is as before: pull, then push.

Because `records` leaves out the request's own writes and `cursor` covers them, a device no longer pulls back what it pushed.

### `pushed` carries the records

`pushed` gains `epoch` and `records: [{id, version, blob}]`: the accepted writes of that push, sealed as for the server. These are versions `v₁ … vₙ`, consecutive because one transaction numbered them. `records` is left out when the body would pass 60 KB.

A receiver applies them without pulling when:

- the epoch equals its own,
- the versions are consecutive, and
- its cursor is at least `v₁ − 1`.

It then merges them as a pull would, advances its cursor to `vₙ`, and tells `Live` the new cursor, so that the overlay goes. Otherwise it syncs as now. Older receivers ignore the new fields and pull.

### Compression

`sync.php` gzips its responses for clients that accept it (`ob_gzhandler`); browsers and `URLSession` unpack them themselves. A request body over 1 KB goes as raw DEFLATE with `Content-Encoding: deflate`: `CompressionStream("deflate-raw")` on the web, `NSData.compressed(using: .zlib)` on the Mac. `sync.php` inflates it, and refuses one that inflates past 1 MB with 413.

## Live

### Sending

- **Two gates.** Open `v: 2` and older channels get cursors and live edits at most every 8 ms. The relay gets them at most every 50 ms, and only while some recipient has no open channel. One person stuck on the relay no longer slows everyone else to 20 a second.
- **Only to those who see it.** `presence` gains `boards`: every board this device shows, its key board first. The Mac lists its visible board windows; the web sends its one board. A cursor or live body for board `b` goes to the connections whose `boards` include `b`, whose `board` is `b` if they send no `boards`, or whose presence has not arrived yet. The first cursor after this device's cursor moves to another board goes to everyone, so that it disappears from the board it left. Over the relay, a body with one recipient goes with `to`, one with none is not sent, and otherwise it is broadcast. A connection whose presence makes it a new recipient gets this device's cursor, or its hiding, and while holding the live state, as a keyframe, so that it never keeps a cursor or misses an overlay from before it came to the board.
- **One body per frame during a gesture.** While a gesture holds items, compact recipients get the cursor inside the live body (`cursor` below) rather than as a body of its own. A receiver takes it only when its `seq` is above the last cursor's, and then counts it as that cursor. JSON recipients still get cursor bodies.
- **Heartbeat.** A holder that has sent the relay nothing for 5 s sends `{"t":"alive"}`, which the relay takes as a sign of life and forwards to nobody.
- **Trims.** `presence` loses `colour`, which every receiver works out from `device`. In JSON bodies, coordinates are rounded to 0.01 and `at` to 0.1 ms.
- `at` is ms since this `Live` started, in both formats. Only one sender's bodies are ever compared, so the base does not matter.

### Compact bodies

A compact body is a MessagePack array. Integers take their shortest encoding, coordinates are float32, and ids and boards are 16 raw bytes (`bin 8`).

| Body | Array |
|---|---|
| cursor | `[1, seq, at, x, y, board?]`; `x` and `y` nil to hide |
| live | `[2, seq, at, board?, caret, items, group, cursor]` |

- `at` is a whole number of tenths of a ms.
- `board` is present in a cursor's or live body's keyframe, and whenever it changed since the sender's last body of that kind; otherwise a receiver uses the board it last had from that sender.
- `caret` is nil or `[id, back, at]`.
- `cursor` is nil or `[x, y]`, on the live body's board.

**`items`** is a map from id to a map of fields keyed by small integers:

| Key | Field | Value |
|---|---|---|
| 0 | `pos` | `[x, y]` |
| 1 | `size` | `[w, h]` |
| 2 | `w` | float32 |
| 3 | `text` | string, or a splice |
| 4 | `notes` | string, or a splice |
| 5 | `color` | integer |
| 6 | `title` | string, or a splice |
| 7 | `kind` | 0 card, 1 lane |

**Deltas and keyframes.** A live body is a keyframe at the gesture's first send and at least once a second after. A keyframe carries every field the gesture changed since it began, as the JSON body does. Between keyframes, a body carries only the fields whose values changed since the last body sent. A lost delta is put right by the next keyframe.

**Splices.** A text field that changed since the last body is a splice `[hash, at, del, ins]`: at UTF-16 offset `at`, remove `del` code units and insert `ins`. It is sent when the splice is shorter than the text. `hash` is FNV-1a 32 over the UTF-16 code units of the text the splice applies to. A receiver applies a splice only when its overlay text for that field hashes to `hash`, and otherwise keeps what it has until the next keyframe.

**`group`.** When every held item whose `pos` changed moved by the same offset, and there is at least one, their `pos` goes as one offset; a single dragged card goes as a group of one. `group` is nil or `[[dx, dy], ids?, starts?]`:

- `ids` and `starts` (each item's `pos` at the gesture's start, as `[x, y]`) come in keyframes and whenever the set changes.
- A receiver keeps the last `ids` and `starts` per sender and sets each item's `pos` to its start plus the offset. Each item's track plays back as now.

`seq` stays one count per sender for cursor and live, across both formats and both pipes. Receivers drop a body whose `seq` is not above the last one they took.

### Channels

- A `v: 2` link sets `binaryType = "arraybuffer"` and sends compact bodies unsealed. DTLS encrypts the channel, and the DTLS fingerprints sit in the offer and answer, which are sealed with the space key. So only someone who holds the key can be on the far end, and sealing again buys nothing.
- On the Mac, `peer.html` sends and receives bytes on the channel and passes them to Swift as base64url, since script messages carry no `ArrayBuffer`. `PeerTransport` gains `sendBytes` and a message callback that says whether it got text or bytes.
- A message on a `v: 2` link that is not binary, or is binary on another link, is dropped.

### Relay

- Connection ids are short decimal strings from a counter the Durable Object keeps in storage: `"1"`, `"2"`, …. Older devices take them as any other id.
- Binary frames from a device:
  - `0x00` then the sealed body, to everyone else;
  - `0x01`, a LEB128 connection number, then the sealed body, to one connection.
- To a `v: 2` device (its `auth` carries `v: 2`), the relay forwards a body as a binary frame: the sender's LEB128 connection number, then the body. To an older device it goes as `{from, body}`, with the body in base64url. A JSON `{to?, body}` from a device reaches `v: 2` devices as binary too.
- Everything else (auth, holds, refusals, join, leave, ping) stays JSON text.
- A device whose `welcome` id is not decimal is on a relay from before this design, which drops binary frames: it sends every body there as JSON `{to?, body}`, addressing connections by their ids as they are.

## Not done

| Idea | Why not |
|---|---|
| `presence` with name and device only on joining | It goes out every 15 s; the saving is about 25 B/s, and older devices drop a presence without `device` |
| Skipping cursor samples that a straight line predicts | Uneven gaps raise the track's interval, and so its delay |
| Nonces from a counter | A nonce reused after a reconnect breaks AES-GCM; the direct channel now goes unsealed anyway |
| Compact or compressed records | A format bump: older devices would hold every record they cannot read. gzip on the wire gets back most of base64's cost |
| A second, reliable channel for text | Splices with a hash and keyframes cover a lost message at a tenth of the code |

## Testing

- **Shared fixtures** in `BreezyKit/Tests/Fixtures/`:
  - `msgpack.json`: values and their bytes, read by `swift test` and `node --test`.
  - `live2.json`: compact cursor and live bodies, with splices, groups and keyframes, and the state a receiver ends with.
- **`sync.php`:** `POST` with `since` against SQLite. Its records leave out the request's own writes; a full page gives the cursor of the last row read; a request without `since` answers as before. Also gzip responses, deflated requests, and the 1 MB limit after inflating.
- **Engines, both languages:**
  - a cycle with something pending makes one request;
  - its own writes are never pulled back;
  - a full page of `records` goes on with `GET`s;
  - `pushed` with records is applied without a pull only when epoch, consecutiveness and cursor allow;
  - resync never combines.
- **Live, both languages:**
  - format by recipient;
  - two gates;
  - recipients by `boards`, with the first cursor after a board change going to everyone;
  - the cursor folded into live;
  - `alive`;
  - deltas, splices, a splice on a mismatched hash ignored until a keyframe, and groups;
  - unsealed binary on a `v: 2` link only, and text dropped there.
- **Relay:** short ids; binary to `v: 2` devices and JSON to older ones, both ways; `to` in binary; `alive` forwards nothing.
- **`scripts/direct-e2e.mjs`:** the channel and the relay carry binary between two current web apps.
- **By hand:** the Mac and the phone in one space, with direct on and off. Drag a group, type in a long card, then check the frame sizes with the e2e script's counters.
