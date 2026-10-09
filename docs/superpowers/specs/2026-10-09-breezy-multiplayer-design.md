# Breezy multiplayer — design

People in a space see each other on the board as they work: cursors with names, who is on which board, selections, cards moving while someone drags them and text appearing as it is typed. A card someone is dragging or editing is theirs until they let go. This extends [sync](2026-10-08-breezy-sync-design.md) and [spaces](2026-10-09-breezy-spaces-design.md): records, merge and `sync.php` stay as they are, and a relay on Cloudflare carries everything live. The Mac app and the web app get it together.

## Why a relay

A spike (branch `spike/realtime`) measured round trips between the Mac, the iOS simulator and an iPhone 13 mini, through a Durable Object at Cloudflare's Düsseldorf edge and directly over WebRTC:

| Between | Relay p50 / p95 | Direct p50 / p95 |
|---|---|---|
| iPhone on home Wi-Fi ↔ Mac | 52 / 63 ms | 12 / 18 ms |
| iPhone on mobile data ↔ Mac | 91 / 134 ms | 74 / 105 ms |

One way is half: the relay takes about 26 ms on Wi-Fi and 45 ms on mobile data, well under the 100 ms at which a remote cursor starts to lag. Holding cards needs one place that decides who came first, which a direct connection cannot be. Direct WebRTC would save about 20 ms one way on a shared network, and it needs Google's WebRTC framework or a hidden web view on the Mac, so it comes later as a second pipe beside the relay.

## Relay

A Cloudflare Worker with one Durable Object per space (`idFromName(space id)`), using WebSocket hibernation. It forwards sealed messages between a space's connections and keeps the holds. It stores no record and cannot read a message.

- `sync.php` names it: every response gains `relay`, a `wss://` URL from `config.php`'s `relay` key, omitted when the key is absent. Existing invites keep working, and moving the relay to a VPS changes one line of config. Without `relay`, the apps work as today.
- A connection's first message is `{"t": "auth", "token": …}`; browsers cannot set headers on a WebSocket, and a URL could end up in logs. The token is derived from the space secret for the relay (HKDF-SHA256, info `breezy relay`), not `sync.php`'s, so the relay can't act on `sync.php`. The first connection to a space stores the token's SHA-256, as `sync.php` does when a space is created; a later token that does not match closes the socket with code 4001, as does no `auth` within 5 s.
- The relay sees who connects and when, message sizes and timing, and the record ids of held items: no more than `sync.php` sees.

### Messages

JSON text frames, at most 64 KB; the relay drops bigger ones.

| From | Message | Does |
|---|---|---|
| device | `{t: "auth", token}` | first message, as above |
| relay | `{t: "welcome", id, peers, holds}` | after `auth`: this connection's id, the others' ids and every hold |
| relay | `{t: "join", id}`, `{t: "leave", id}` | a connection opened or closed |
| device | `{to?, body}` | relays `body`, sealed, to connection `to` or to everyone else, as `{from, body}` |
| device | `{t: "hold", ids}` | asks for ids, all or none |
| relay | `{t: "refused", ids}` | to the asker, when someone else holds any of them: those ids; when the ids are malformed or the connection would hold more than 500: all it asked for; none are granted |
| device | `{t: "release"}` | lets go of every id this connection holds |
| relay | `{t: "holds", holds}` | to everyone, after any change: `{connection id: [ids]}` |
| device | `ping` | plain text, every 20 s while connected; the relay answers `pong` without waking |

### Sealed bodies

A body is a blob as in sync: a 12-byte nonce and the AES-GCM ciphertext of JSON, with the space key; the additional data is `live` followed by the space id, so a live message can never pass for a record. Its plaintext is one of:

| `t` | Fields | Sent |
|---|---|---|
| `presence` | `device`, `name`, `colour`, `board`, `selection`, `cursor` | on connecting, on any change of its fields but `cursor`, and every 15 s |
| `cursor` | `board`, `x`, `y` | while it moves, at most 20 a second |
| `live` | `board`, `items`: `{id: {fields}}` | during a gesture, at most 20 a second |
| `pushed` | `version` | after every accepted push |

`board` is the board on screen, null on the board list; `selection` is ids; `cursor` and `x`, `y` are in board coordinates, or `cursor` is null when there is none.

## People

- Each device has a random 128-bit id, a name and a colour, the same in every space. The Mac's name starts as the macOS account's full name; the web app asks "Your name" before its first New Space or Join Space. Both change it with **Your Name…** in the menu.
- The colour comes from the device id, from a palette of eight that stand apart from the card colours.
- Stored beside the spaces: Mac `UserDefaults` (`device`, `name`), web IndexedDB key `me`.
- A person is present from their `presence` until their connection leaves, or 30 s without a message. A device keeps one connection per space; on the Mac, `board` is the key window's board and the cursor comes from whichever board window the pointer is over.

## Presence

- **Cursors:** an arrow in the person's colour with their name beside it, where their pointer is on the same board. Receivers glide between updates so it moves smoothly. On a phone, which has no pointer, the cursor is the last touch and fades 3 s after the finger lifts. A cursor that has not moved for 60 s fades too.
- **Selections:** items someone else has selected get a thin outline in their colour.
- **Who's here:** the board's toolbar shows the initials, in their colours, of everyone on the board. The board list shows them on each board's row.

## Holding

- A drag or an edit session sends `hold` with what it moves or edits: the dragged cards and those an ⌥-drag takes along, a lane and its cards, or the card or lane being edited. The gesture starts at once; if the relay refuses, which takes two devices grabbing within about 50 ms, the late gesture is cancelled and springs back. An item already shown as held cannot start a gesture.
- Held items are outlined in the holder's colour with their name. Others cannot select, drag, edit, recolour or delete them; a lane dragged against a held card leaves that card where it is.
- While it holds, a device sends `live` at least every 5 s, even when nothing changed. A hold ends with the gesture (`release`), when the holder's connection closes, or after 10 s without a message from it, so that a crashed device cannot keep a card.
- Without the relay nothing is held, and sync's merge rules apply as now.

## Live edits

- During a gesture, the holder sends the fields of held items that changed since the gesture began: `pos`, `size`, `w`, `text`, `notes`, `color`.
- Receivers draw those values over their board. They never reach the model, the store or undo, so they show even during the receiver's own gesture. Live positions follow the stream directly, without springs.
- Stacking runs only on committed changes, on each device as now: cards a live drag pushes aside move on other screens once the drag is saved, as any remote change does.
- **Typing:** the text appears as it is typed, with the typist's caret in their colour.
- **When the gesture ends,** the holder flushes and pushes at once rather than a second later, sends `pushed`, then releases. A receiver keeps that person's overlay until it has pulled up to `version`, so the item does not jump back meanwhile.

## Sync

- `pushed` from anyone starts a sync cycle at once.
- While the relay is connected, the 5 s poll becomes 30 s; it returns to 5 s when the relay goes.

## Connection

- `Live`, one per space beside its `SyncEngine`: `web/sync/live.js`, and `Live.swift` in BreezyKit on `URLSessionWebSocketTask`. It connects while the app is visible and a board of that space or the board list is open, and closes otherwise.
- It reconnects after a drop or a network change, after 1 s doubling to 30 s; on reconnecting it sends `presence` again, and any gesture under way asks for its holds again. A socket that sends nothing within 10 s of a `ping` counts as dropped. After 4001 it stays closed until the server names another relay or the app starts again.

## Errors

Explain a problem only when the user can do something about it.

| Problem | Behaviour |
|---|---|
| relay unreachable, refused or closed | no presence, holds or live edits; sync as now; nothing shown |
| relay closes with 4001 | as a 401 from `sync.php`: "Not in this space any more" |
| a body fails to decrypt or parse | dropped |
| a message over 64 KB | not sent; a card that long cannot sync anyway |

## Cost

Durable Objects bill WebSocket messages and active time. Before building, the plan checks Cloudflare's current free-plan limits against two to four people sending cursors at 20 a second for a few hours a day, and the rates above change if they do not fit.

## Testing

- **Shared fixture**, in `BreezyKit/Tests/Fixtures/`: a live-message vector with a fixed nonce, read by `swift test` and `node --test`, so each app opens the other's messages.
- **Relay:** a Node script against `wrangler dev`: relaying, `to`, auth and 4001, holds granted, refused, released by `release`, by closing and by the 10 s timeout, and the 64 KB limit.
- **Unit tests in both languages:** the overlay drawn and dropped after `pushed`, cursor gliding, a refused hold cancelling the gesture, held items refusing edits, presence expiry, reconnect backoff.
- **By hand:** the Mac, the simulator and the phone in one space: drag and type at once, grab the same card together, and switch the phone from Wi-Fi to mobile data mid-drag, which must release its hold and reconnect.

## Out of scope

Direct WebRTC (next), following someone or jumping to their cursor, chat, presence history, live previews in the board list.
