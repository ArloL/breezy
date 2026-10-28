# Layers

Where to look for the next fact, by platform and layer, from the application down. Start at the top and descend one layer only when every signal so far is weak (`.claude/skills/debugging-breezy`).

**Recorded** says whether a run already holds the fact:
- **yes:** every scenario run keeps it;
- **on failure:** only a failing run does;
- **no:** someone must gather it.

## Web app in a browser: Chromium, WebKit, Firefox, and Chrome and Firefox on Android

| Layer | Fact | How | Recorded |
|---|---|---|---|
| Application | decisions, transitions, gestures as taken, geometry, errors, version | `<who> flight.json`, and the `app` lines in `timeline.txt` | yes |
| Application | the board each device shows, its sync status | the end of `timeline.txt` | yes |
| Network | pulls, pushes and their bodies, relay messages, failed requests | the page's lines in `timeline.txt` (`scenarios/browser.ts`, `logSync`) | yes |
| Storage | snapshot, IndexedDB, service worker version | `life` and `context` entries; otherwise a page script through `page.evaluate` | partly |
| Runtime | frames per second, long tasks (Chromium), timers running late | the page's `frames` and `long task` lines (`logPage`) | yes |
| Runtime | input as the page got it, and its lag from what was sent | the page's `page down`/`up` lines, and `down/up lags` in the summary | yes |
| Engine | layout, paint, compositing | Playwright's `page.screenshot()`; Chromium's tracing by hand | on failure |
| Device, Android | the keyboard, windows, the input method, SurfaceFlinger, memory | `logcat` lines in `timeline.txt`; `<who> windows.txt`, `ime.txt`, `screen.png`; `scripts/android-capture.sh` on CI | partly; on failure |
| Device, runner | load, free memory, Node's timers running late | the `runner` lines | yes |

## Safari on the iPhone, in a tab and as the Home Screen app

| Layer | Fact | How | Recorded |
|---|---|---|---|
| Application | as for the web app: `flight.json`, `app` lines | through the page agent (`scenarios/agent.ts`) | yes |
| Network | requests to sync.php, the relay's socket, edits waiting to be pushed | `<who> page` lines (`IosDevice.syncLog`) | yes |
| Engine | what is painted | `<who> screen.png` | on failure |
| Device | the simulator's own log | `xcrun simctl spawn <udid> log show --last 5m` | no |
| Device | the model and iOS version | `context page`'s `ua`; `IPHONE` and the runtime `scripts/ios.ts` boots | yes |

## The Mac app

| Layer | Fact | How | Recorded |
|---|---|---|---|
| Application | its board, as the scenarios read it | `scenarios/mac.ts`, the end of `timeline.txt` | yes |
| Application | decisions, geometry | none yet: BreezyKit has no recorder (part G) | no |
| OS | its process | `log show --predicate 'process == "Breezy"' --last 5m`, `sample Breezy` | no |

## sync.php

| Layer | Fact | How | Recorded |
|---|---|---|---|
| Application | its errors | PHP's error log (`error_log` in `server/sync.php`); in production, the host's log | no |
| Application | that a deploy serves what was built | `scripts/deploy.py`'s verify, after each deploy; `scripts/deploy-check.ts` weekly | each deploy |
| Network | what devices sent and got | the devices' network lines above | yes |

## The relay

| Layer | Fact | How | Recorded |
|---|---|---|---|
| Application | that it takes a connection | `scripts/relay-check.ts`, after each deploy | each deploy |
| Application | its log in a scenario run | `relay` lines in `timeline.txt` (wrangler dev) | yes |
| Application | its log in production | `npx wrangler tail` in `relay/` | no |
