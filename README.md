# Breezy

A whiteboard for work thoughts: sticky-note cards and lanes on an infinite canvas. A native Mac app and a web app, which can share boards through a small server.

## Build

```bash
mise install
xcodegen generate
xcodebuild -project Breezy.xcodeproj -scheme Breezy -configuration Release -derivedDataPath build build
open build/Build/Products/Release/Breezy.app
```

Boards live in `~/Library/Application Support/Breezy/Spaces/` and reopen where they were left after a relaunch.

Releases update themselves with [Sparkle](https://sparkle-project.org): they download a new version in the background and install it on quit. Each release carries an `appcast.xml` that CI signs with the `update-signing` environment's `SPARKLE_PRIVATE_KEY`, which only `main` can read; the app reads it from `releases/latest/download/` and checks it against `BREEZY_UPDATE_KEY` in `project.yml`. Builds without `BREEZY_UPDATE_FEED`, which CI sets only on `main`, never update.

## Use

| Do | How |
|---|---|
| Boards | ⇧⌘B lists them; ⌘N makes one; click a selected title to rename it, ⌫ to delete |
| Spaces | Breezy → New Space…, Join Space…, Share Invite, Rename Space…, Leave Space…; right-click a board in the Boards window to move it to another space |
| Pan / zoom | scroll / pinch or ⌘-scroll; ⌘0 or ⇧0 return to 100 % |
| Select | click; ⇧-click to add; drag on empty space for a box |
| New card | double-click empty space |
| Edit card | double-click it; Esc or ⌘↩ to finish; the first line is the title |
| Card back | Space over a card or its folded corner turns it over; Tab while editing turns it too |
| Stack | cards in a lane float up their column and make room where you drag one in; ⌥-drag takes a card with those below it |
| Colour | `1`–`5` |
| Delete | ⌫ |
| New lane | `L` at the pointer, or New Lane in the toolbar |
| Lane | drag the header to move it with its cards, the corner to resize, double-click the header to rename |
| Find | ⌘F searches fronts, backs and lane titles |
| Undo / redo | ⌘Z / ⇧⌘Z |

## Develop

```bash
swift test --package-path BreezyKit
xcodebuild -project Breezy.xcodeproj -scheme Breezy -derivedDataPath build test
scripts/selftest.sh                    # after a Debug build; for when XCUITest cannot activate the app
scripts/bench.sh LABEL RUNS BOARD...   # after a Release build; then python3 scripts/bench-summary.py
```

## Sync

Each space is a set of boards shared with whoever has its invite; a device can join several and keeps boards of its own under On this device. Everything is encrypted on the devices; the server stores only what it cannot read. See `docs/superpowers/specs/2026-10-08-breezy-sync-design.md` and `docs/superpowers/specs/2026-10-09-breezy-spaces-design.md`.

The server is `server/sync.php` on PHP 8 with MySQL, served with the web app at https://breezy.k5d.de/sync.php. Every push to `main` builds both (`scripts/build-site.sh`) and uploads what changed over FTPS (`scripts/deploy.py`), with the `production` environment's secrets `BREEZY_WEB_USER`, `BREEZY_WEB_PASSWORD`, `BREEZY_DATABASE_USER` and `BREEZY_DATABASE_PASSWORD`; the deploy writes the database's details to `config.php` next to `sync.php`, which `.htaccess` keeps from browsers. Run `schema.sql` once on the database. It must be served over HTTPS, and `.htaccess` needs `AllowOverride AuthConfig` for `CGIPassAuth`. The server has been smoke-tested against MySQL 8.4. Then New Space on one device with the address of `sync.php`, Share Invite from its menu, and Join Space on the others with the link.

Cursors, who is on which board, held cards and edits as they happen go through a relay, `relay/`: a Cloudflare Worker with a Durable Object per space, which forwards what the devices seal and cannot read it. `sync.php` names it from `config.php`'s `relay`, which the deploy writes from `BREEZY_RELAY` (default `wss://breezy-relay.blissfulbird.workers.dev/`). Every push to `main` deploys the relay too, with the `production` environment's `CLOUDFLARE_API_TOKEN` (a token with the Workers Scripts and Durable Objects edit permissions) and `CLOUDFLARE_ACCOUNT_ID`; without them it says so and skips the deploy. By hand: `npx --prefix relay wrangler login` once, then `npm --prefix relay run deploy`. Between two current devices, a direct channel carries compact unsealed binary bodies, and the relay sealed bodies as binary frames; older devices get JSON. Without a relay, boards sync as before, polling every 5 s.

After restoring a backup of the database, run `UPDATE spaces SET epoch = RANDOM_BYTES(16);` so that devices pull everything again and push what the backup lacks.

```bash
server/test.sh   # sync.php against SQLite, then the Mac's HTTP client against it; needs php (brew install php)
server/dev.sh    # serves http://127.0.0.1:58566/sync.php from build/ for trying sync on this Mac
scripts/build-site.sh build/site local-$(git rev-parse --short HEAD) && mise exec -- scripts/deploy.py build/site   # deploys from here as CI does, with mise.local.toml's secrets
relay/test.sh                  # the relay under wrangler dev, with its tests; first npm install --prefix relay
npm --prefix relay run dev     # serves ws://127.0.0.1:58568/, which server/dev.sh names
node scripts/direct-e2e.mjs    # starts wrangler, server/dev.sh and a web server on 58568, 58566, 58565; two headless Chromiums open a direct channel, fall back to the relay while it goes silent and come back, then fall back when it closes, checking that both carry binary, compact bodies, one body a move. Needs Node 24, php, npm install --prefix relay, and Playwright's Chromium (or BREEZY_CHROMIUM; not ungoogled-chromium)
node scripts/feel.mjs [--direct] [--only cursor,drag,colour,outage,silent,passive]   # the same setup with each browser behind a proxy that delays the relay 25 ms and the server 40 ms each way: how far a cursor and a drag trail, how long a recolour takes, and how long both take after a network change; 95 % CIs over --runs
node scripts/fuzz.mjs --seeds 1-50 [--profile mixed|lan|office|train|tether|blocked-ws] [--web 2 --swift 2] [--shrink]   # web and Swift devices edit one board against sync.php, the relay's Durable Object and simulated direct channels, over simulated networks with faults, on virtual time; then all must end the same. A failure goes to build/fuzz/, replayable with --replay. Needs php and swift build --package-path BreezyKit --product breezy-sim; see the convergence fuzzing design
```

## Touch prototype

`web/` is a touch version for trying Breezy's interaction on a phone. It keeps its boards in the browser and opens on a list of them; `?stress` loads 500 cards into a board it does not keep. Every push to `main` publishes it at https://breezy.k5d.de/: on iPhone, Safari's Share → Add to Home Screen; on Android, Chrome's ⋮ → Install app. In a desktop browser it takes a mouse, trackpad and keyboard as the Mac app does. Once installed it launches from a local copy of one version, without the network; `web/sw.js` downloads a new version in the background and switches to it on the next launch, or on coming back after five minutes away. Version in the ⋯ menu says when one is ready.

```bash
npx --yes live-server@1.2.2 web --port=58565 --no-browser
```

It reloads the page on every save. On the iPhone, on the same Wi-Fi, open `http://<the Mac's address>:58565` in Safari and Add to Home Screen. `node --test web/test/*.test.js` runs its tests; `swift scripts/make-web-icons.swift web` redraws its icons and `scripts/make-web-launch.py web` its launch images, whose `<link>` tags it prints for `index.html`.

In the iOS simulator, which Xcode 27 shows in DeviceHub rather than a Simulator app, open it with `xcrun simctl openurl booted http://localhost:58565/`. `scripts/sim-touch.py` replays touches as one timed stream; gestures that start with a double tap need it, because the window is 300 ms and `idb ui tap` or AXe take at least 0.7 s per touch. A screenshot rarely lands mid-gesture, so record with `xcrun simctl io booted recordVideo` to catch something brief like iOS's magnifier.

To compare with Apple's apps on a real iPhone, run Appium's WebDriverAgent on it from Xcode (scheme WebDriverAgentRunner, Product → Test; signing needs Apple's WWDR G3 intermediate in the login keychain): `scripts/wda.py` then drives it, with timed touches, pinches and the accessibility tree for positions, and refuses to touch while a call is on screen. `scripts/phone-record.swift` records the phone's screen over USB. Freeform measured this way set the coast, edge scrolling and button presses.
