# Breezy direct WebRTC — design

Two screens side by side show each other's cursor and drags with no visible lag or stepping. Devices in a space open a direct WebRTC data channel beside the relay, send cursors and live edits over it at display rate, and every receiver draws remote positions each frame through a small adaptive buffer. This is the "next" in [multiplayer](2026-10-09-breezy-multiplayer-design.md)'s Out of scope; the relay, `sync.php` and every message the relay reads stay as they are, so nothing is deployed.

## Why

Round trips from the spike (branch `spike/realtime`, since deleted), 100 ms pings, AES-GCM on every message:

| Between | Relay p50 / p95 | Direct p50 / p95 |
|---|---|---|
| Two iOS simulators on one Mac | 50 / 65 ms | 3 / 9 ms |
| iPhone on Wi-Fi ↔ Mac, same LAN | 52 / 63 ms | 12 / 18 ms |
| iPhone on mobile data ↔ Mac | 91 / 134 ms | 74 / 105 ms |

The gain is large only on a shared network, which is the side-by-side case. Latency alone is not enough: today a cursor waits up to 50 ms for the send gate, then glides over a fixed 60 ms, and live overlays jump to each new position. The rendering half of this design helps the relay path too.

## Pipes

The relay keeps holds, `pushed`, presence, signalling, the holder's heartbeat and every fallback. The direct pipe carries only `cursor` and `live`. Holds need one arbiter, and the relay keeps a hold alive only while it hears from the holder.

No TURN: when a direct connection fails, the relay is the fallback. STUN is `stun:stun.cloudflare.com:3478`. A direct connection shows each side the other's IP addresses, which the people in a space already trust each other with.

### Signalling

New sealed bodies, sent through the relay with `to`:

| `t` | Fields | Sent |
|---|---|---|
| `offer` | `sdp` | by the newcomer, to each connection in `welcome`'s `peers` |
| `answer` | `sdp` | in reply to `offer` |
| `ice` | `candidate`, `mid`, `index`; all null at the end of gathering | as each candidate is gathered |

- The newcomer offers, so two sides never offer at once.
- The data channel is negotiated on both sides (`negotiated: true, id: 0, ordered: false, maxRetransmits: 0`), so neither waits for `ondatachannel`.
- Candidates that arrive before the remote description are queued and added after it.
- Relay sends already go through one chain, so an offer never overtakes its own candidates.
- Clients without this design drop the unknown types and stay on the relay.

### Routing

- When every peer's channel is open, `cursor` and `live` go only over the channels, and the relay sees none of them.
- Otherwise they go to the relay as a broadcast, as now, and over each open channel as well.
- `cursor` and `live` gain `seq`, counting per sender. A receiver drops a body whose `seq` is not above the last it took from that sender for that `t`, which removes duplicates and late arrivals on the unordered channel.
- While holding, the 5 s `live` heartbeat always goes to the relay, even when every channel is open.
- A channel message is the bare sealed body, as the relay would carry it; the channel says who sent it.

### Failure

- A channel that does not open within 10 s of the offer leaves that peer on the relay.
- On `failed`, the offerer calls `restartIce()` and sends a new `offer`, up to 3 times, 2 s apart. `disconnected` waits for `failed`.
- A version 2 channel beats every tick, with the single byte `0`, which devices from before the beat drop as not compact. A network that goes under a channel closes nothing for about 30 s, so once the other side has beaten, 2.5 s without hearing anything over the channel moves that peer to the relay, and the offerer restarts ICE at once. Anything heard over it again moves the peer back.
- A network change also drops the relay socket. Reconnecting gives the device a new connection id, the others see `leave` and `join`, and the newcomer offers afresh. `leave` closes that peer's connection.
- Nothing is shown to the user: a browser that gathers no candidates, such as ungoogled-chromium without `--webrtc-ip-handling-policy=default`, cannot be fixed from the app. Each space's sync status lines gain a passive "Direct with 1 of 2 people" while someone is present, for debugging.

## Timing

- `cursor` and `live` gain `at`, the sender's monotonic clock in ms: `performance.now()` on the web, `ProcessInfo.systemUptime` on the Mac. Only one sender's messages are ever compared, so the clocks need not agree.
- The send gate's interval is 8 ms while every peer's channel is open, and 50 ms otherwise. Input events already arrive at display rate, so 8 ms sends every frame at 60 and 120 Hz, while relay traffic, which Cloudflare bills, stays as now.

## Track

A pure unit in both languages, `web/sync/track.js` and `BreezyKit/Track.swift`: one sender's samples of one value, a cursor or one overlay item. Each sample is `at`, its arrival on the receiver's monotonic clock, and the value.

| Quantity | Definition |
|---|---|
| offset | minimum of arrival − `at` over the last 2 s: the fastest trip plus the clocks' difference |
| jitter | 90th percentile of arrival − `at` − offset over the last 2 s |
| interval | median gap between consecutive `at` over the last 2 s |
| delay | interval + jitter, clamped to 8–150 ms |

- **Sampling** at receiver time `now` plays back sender time `now − offset − delay`, interpolating linearly between the samples either side. Before the first sample it holds the first; after the last it holds the last. It never extrapolates.
- **After a pause:** a sample arriving more than 250 ms after the previous one first adds a copy of the previous value at the new `at` minus interval, so a cursor that sat still does not drift slowly to where it went.
- **Interpolated:** cursor `x`, `y`; overlay `pos`, `size`, `w`. **Applied on arrival:** `text`, `notes`, `color`, `title`, `kind`, the caret. A cursor that hides or changes board jumps.
- A body without `at`, from a client before this design, uses its arrival instead.
- Expected delay: about 10–20 ms direct on a LAN, 55–70 ms over the relay.

`Live` keeps a peer's cursor and overlay as tracks. `cursors(board)` and `overlay(board)` return sampled values at the current time, and `animating` says whether any track is still playing back. An overlay still stays until its holder's pushed version is pulled.

## Drawing every frame

- **Web:** a `requestAnimationFrame` loop runs while `live.animating`. Each frame places cursors by transform and calls `view.invalidate()` when an overlay moved. `.presence .cursor` loses its 60 ms transition. Cursors are placed on every render, camera moves included, so they no longer trail a pan.
- **Mac:** `CanvasView` runs `displayLink(target:selector:)` while `live.animating`. `PresenceView` sets positions with actions disabled and loses its 0.06 s animation. Overlay changes that move or resize but change no `text` or `w` skip the text-height pass in `presenceChanged`.

## The Mac bridge

macOS gives native apps no `RTCPeerConnection`. A hidden WKWebView runs the peer connections and passes sealed bodies over a script message handler; both apps keep one protocol and BreezyKit takes no WebKit.

- `PeerTransport`, a protocol in BreezyKit: create and close a peer, make an offer, take an offer and make an answer, take an answer, add a candidate, restart ICE, send a string; callbacks for an outgoing candidate, open, closed or failed, and a received string. `Live` uses it; tests use a fake.
- `WebPeerTransport` in the app target (`Breezy/Live/`): one WKWebView for the app, every call keyed by space and peer. It loads a bundled `peer.html` with inline JS. Swift calls in with `callAsyncJavaScript` and its arguments; JS calls out through a `WKScriptMessageHandler` named `peer`. `inactiveSchedulingPolicy = .none` keeps it unthrottled while Breezy is not the active app.
- Sealing and opening stay in Swift; the web view sees only sealed strings and SDP.

### Spike first

A throwaway spike, branch `spike/mac-webrtc`, settles before phase 3:

1. Which load gives the page a secure context with `RTCPeerConnection`: a custom URL scheme, `loadHTMLString` with an `https` base URL, or `loadFileURL`.
2. That it gathers mDNS host and server-reflexive candidates without camera or microphone permission.
3. That it runs unthrottled with no window and with Breezy inactive.
4. **Budget:** 1000 pings from Swift through the page over a loopback pair of peer connections and back, against the same pings timed inside the page. The bridge may add at most 1 ms at p95. The page is WebKit, as Safari is, so the network part needs no phone.

If it fails, Google's WebRTC framework goes behind the same `PeerTransport` in the app target.

## Testing

- **Shared fixture** `BreezyKit/Tests/Fixtures/track.json`: samples, arrivals and expected values, read by `swift test` and `node --test`.
- **Unit tests in both languages:** `seq` dropping duplicates and late bodies; routing, direct only when every channel is open and broadcast plus direct otherwise; the heartbeat staying on the relay; the gate switching between 8 and 50 ms; signalling over a fake transport: the newcomer offers, early candidates queue, the 10 s fallback, `restartIce` on `failed` up to 3 times, `leave` closing the peer.
- **Web integration:** two headless Chromiums with their own `--user-data-dir` and `--webrtc-ip-handling-policy=default`, driven over the DevTools protocol against `wrangler dev`: a channel opens, cursors stop reaching the relay, and closing a channel falls back to the relay. Seed each `me` through `/sync/idb.js` and load the `#join=` link from `about:blank`.
- **By hand**, Mac and phone on one Wi-Fi: film both screens at 240 fps and count frames between a real cursor and its remote copy. Success is a median of 50 ms or less and no repeated frames during steady motion. Switching the phone from Wi-Fi to mobile data mid-drag releases its hold and reconnects, direct or over the relay.

## Phases

One PR each.

1. `Track`, `at`, `seq` and drawing every frame in both apps, over the relay only.
2. The direct pipe on the web, and the transport-neutral signalling and routing in `Live.swift`, tested with the fake transport.
3. The spike, then `WebPeerTransport`.

## Out of scope

TURN, a direct pipe for holds or `pushed`, explaining connection problems to the user, raw UDP between Macs.
