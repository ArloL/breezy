# Breezy network feel — design

Edits reach the other screens as fast as cursors do, and a network change costs seconds rather than minutes. It changes [multiplayer](2026-10-09-breezy-multiplayer-design.md), [direct WebRTC](2026-10-09-breezy-webrtc-design.md) and [lean sync](2026-10-09-breezy-lean-sync-design.md); every client is current, so nothing keeps an older one working.

## Where it stands

`scripts/feel.mjs` puts each of two headless Chromiums behind a proxy that delays the relay 25 ms and the server 40 ms each way, so a body takes 50 ms from one browser to the other over the relay. Means with 95 % CIs over 5 runs, 2026-10-10:

| | Relay, before | Relay, after | Direct, before | Direct, after |
|---|---|---|---|---|
| cursor lag | 127 ± 1 ms | 103 ± 1 ms | 28 ± 0 ms | 28 ± 0 ms |
| drag lag | 126 ± 2 ms | 103 ± 1 ms | 63 ± 1 ms | 34 ± 0 ms |
| drag frames standing still | 12 ± 2 % | 0 ± 0 % | 2 ± 0 % | 0 ± 0 % |
| recolour shows | 1474 ± 5 ms | 85 ± 3 ms | 1470 ± 10 ms | 23 ± 2 ms |
| new card shows | 1476 ± 9 ms | 104 ± 11 ms | 1469 ± 9 ms | 35 ± 7 ms |
| deleted card goes | 1475 ± 8 ms | 81 ± 5 ms | 1471 ± 8 ms | 26 ± 6 ms |
| typed key shows | 98 ± 2 ms | 80 ± 2 ms | 45 ± 1 ms | 27 ± 2 ms |
| a started app shows the others | 374 ± 13 ms | 277 ± 3 ms | not measured | not measured |
| cursor back after the network changes, with an online event | 13 to over 60 s | 248 ± 29 ms | not applicable | not applicable |
| the same without one | over 60 s | 3229 ± 9 ms | not applicable | not applicable |

Before is `main` at 6475073, with feel.mjs run against it. In 5 of 5 runs of 20 s in which both edit at random at once, both screens end the same.

With 0 to 40 ms of jitter a hop, drags trail by 162 ± 3 ms over the relay and settle 178 ± 6 ms after the drop.

## Edits

- An edit outside a gesture pushes at once. When that push goes now, rather than after a back-off or a gesture's end, the edit also goes to the live layer as one keyframe that holds nothing. Receivers draw it as an overlay until a push that holds it is in, then drop it at once rather than after `HOLD_GRACE_MS`, so that it cannot hide their own edit to that item. `pushed` carries `seq`, the sender's last `seq` when that push began; it holds every edit body up to it, so a push already under way does not drop a later edit's overlay.
- A gesture's end is told apart from such an edit by a gesture having been under way, not by holds: a press asks for holds before any gesture starts.
- Live fields gain `gone`, compact key 8, for a deleted item. Overlays take such items off the board, and put new lanes on it as they did new cards.
- Asking for holds sends the gesture's live state, so a new card shows before its first key.
- While a gesture others follow is under way, nothing is pushed: the binding still writes to the store, and the end pushes. Intermediate pushes made the others restack around positions the overlay hid.
- The web app sends a dragged item where it floats under the pointer, as it draws it; the Mac snaps while dragging, so it sends the grid.

## Relay

- The relay gets bodies at most every 25 ms. One person moving without pause makes about 7,200 Durable Object requests an hour, at the 20:1 rate for incoming WebSocket messages, against 100,000 a day free. At 50 ms the relay lag was 127 ms, at 33 ms 112, at 16 ms 95.
- `auth` may carry `replaces`, the connection this layer had before. The relay closes that one with its holds, so the others stop showing a frozen cursor for 30 s and a drag under way can hold its cards again. A socket the relay closes stays among the object's until its far end answers, which a dead one never does, so leaving marks it `left`: it no longer counts as a connection, and no alarm comes back for it.

- The store keeps the relay the server last named, so that the live layer connects at launch alongside the first sync rather than after it.

## Liveness

A socket a network change left dead says nothing, so the app asks:

| When | Then |
|---|---|
| the relay has said nothing for 5 s | ping |
| sending after the relay said nothing for 2 s | ping |
| another holds something and the relay has said nothing for 1 s | ping, dropping it if unanswered for 1.5 s |
| a ping unanswered for 3 s, or a socket not welcomed 5 s after opening | drop it |
| a connection that worked at least 5 s drops | open again at once; else the back-off as before |
| an online event, or the Mac wakes or its network's interfaces or gateways change | replace the socket at once |
| the app shows again or becomes active | ping, and open at once if waiting to retry |

After each welcome a device repeats `pushed` with the highest version it has, as one sent on a dead socket reached nobody; a receiver at that version already does not pull. It also syncs. A network change cancels a request that has run over a second. A web request whose answer has not begun after 5 s, plus a ms per 20 bytes sent, goes again at once, twice at most.

## Not done

| Idea | Why not |
|---|---|
| Extrapolating cursors past the last sample | Saves the 25 ms interval, but at every stop overshoots by what one interval covers, 15 px at 600 px/s |
| Dropping the binding's writes during a gesture | They keep a long edit on the device if the app dies mid-gesture |
