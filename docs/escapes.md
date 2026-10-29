# Escapes

Every bug found by hand, or by a nightly or soak run rather than the checks on each push, gets a row here with its fix: the platform it showed on, its class and the level that should have caught it (`TESTING.md`), and the test that now does. Escapes per class per month say whether the levels work.

Rows before 2026-10-25 are seeded from commit messages; "unstated" means the message does not say who found the bug, and their tests were not traced. A fix logged with its pull request names the pull request, as a rebase merge gives its commits new hashes.

Since 2026-10-28 a row also says what pinned the cause and the layer it came from (`docs/layers.md`), how many messages the owner sent after the report, and whether the run or the app had recorded that signal by default. Interventions per escape should fall to zero; a signal that was not recorded is the next thing to record (`.claude/skills/debugging-breezy/SKILL.md`). Rows from 2026-10-25 to 2026-10-27 are filled in only where the history says.

| Date | Platform | Class | Found by | Should have caught | Test | Signal | Interventions | Recorded | Commit |
|---|---|---|---|---|---|---|---|---|---|
| 2026-10-07 | firefox | B2 | unstated | L5 | — | — | — | — | 332ff3a |
| 2026-10-07 | firefox | B2 | unstated | L5 | — | — | — | — | f0b3b89 |
| 2026-10-07 | web | B3 | unstated | L1 | — | — | — | — | b3003b1 |
| 2026-10-07 | ios | B1 | unstated | L3 | — | — | — | — | 4546a46 |
| 2026-10-07 | ios | B1 | unstated | L3 | — | — | — | — | 628cbf9 |
| 2026-10-07 | ios | B3 | unstated | L1 | — | — | — | — | 73ba916 |
| 2026-10-07 | ios | B3 | unstated | L6 | — | — | — | — | 0f64f98 |
| 2026-10-07 | ios | B3 | unstated | L6 | — | — | — | — | c4c5871 |
| 2026-10-07 | ios | B3 | unstated | L1 | — | — | — | — | bdcf43e |
| 2026-10-07 | ios | B3 | unstated | L1 | — | — | — | — | f3687d9 |
| 2026-10-07 | mac | B3 | unstated | L1 | — | — | — | — | ae9ad29 |
| 2026-10-07 | mac | B8 | unstated | L7 | — | — | — | — | 5d78bca |
| 2026-10-07 | mac | B8 | unstated | L7 | — | — | — | — | 1ba97a6 |
| 2026-10-08 | mac | B8 | unstated | L7 | — | — | — | — | 5c41379 |
| 2026-10-08 | web | B5 | unstated | L1 | — | — | — | — | 758a839 |
| 2026-10-08 | web | B5 | unstated | L6 | — | — | — | — | fa2e532 |
| 2026-10-08 | ios | B5 | unstated | L7 | — | — | — | — | cd9d942 |
| 2026-10-09 | web | B4 | unstated | L4 | — | — | — | — | dbada5d |
| 2026-10-10 | web | B4 | unstated | L4 | — | — | — | — | 169b077 |
| 2026-10-10 | web | B4 | unstated | L3 | — | — | — | — | c54a5e4 |
| 2026-10-10 | web | B4 | unstated | L1 | — | — | — | — | f6215a6 |
| 2026-10-10 | web | B4 | unstated | L6 | — | — | — | — | 6475073 |
| 2026-10-10 | web | B4 | unstated | L4 | — | — | — | — | 888d73a |
| 2026-10-11 | web | B3 | unstated | L3 | — | — | — | — | c14e5a8 |
| 2026-10-11 | web | B3 | unstated | L3 | — | — | — | — | fb49fff |
| 2026-10-11 | web | B2 | unstated | L6 | — | — | — | — | c087059 |
| 2026-10-11 | web | B3 | unstated | L3 | — | — | — | — | 036aa93 |
| 2026-10-11 | web | B8 | unstated | L6 | — | — | — | — | 08a38da |
| 2026-10-11 | mac | B5 | unstated | L1 | — | — | — | — | 6bfa998 |
| 2026-10-13 | ios | B3 | unstated | L1 | — | — | — | — | 830a708 |
| 2026-10-14 | android | B3 | unstated | L3 | — | — | — | — | 424d4ca |
| 2026-10-14 | web | B4 | unstated | L4 | — | — | — | — | 8375434 |
| 2026-10-14 | android | B3 | unstated | L1 | — | — | — | — | 90d22f2 |
| 2026-10-14 | web | B4 | unstated | L4 | — | — | — | — | 6dfbafd |
| 2026-10-15 | mac | B1 | unstated | L6 | — | — | — | — | 8f23365 |
| 2026-10-15 | web | B1 | unstated | L3 | — | — | — | — | a3ddf48 |
| 2026-10-15 | android | B2 | unstated | L5 | — | — | — | — | 6cc419a |
| 2026-10-19 | chromium | B2 | platform rows | L5 | — | — | — | — | d0b2795 |
| 2026-10-19 | firefox | B2 | platform rows | L6 | — | — | — | — | c160eb8 |
| 2026-10-19 | web | B4 | unstated | L3 | — | — | — | — | 441d88d |
| 2026-10-20 | ios | B8 | unstated | L7 | — | — | — | — | 1dd075e |
| 2026-10-22 | firefox | B3 | soak | L1 | — | — | — | — | 665b03d |
| 2026-10-22 | firefox | B3 | soak | L1 | — | — | — | — | ebc0280 |
| 2026-10-22 | web | B7 | hand | L8 | — | — | — | — | 025afc5 |
| 2026-10-24 | ios | B5 | iOS chaos | L7 | — | — | — | — | f942f51 |
| 2026-10-25 | ios | B1 | hand | L3 | `scenarios/sight.test.ts` | unstated | unstated | unstated | 76e010e |
| 2026-10-25 | android | B1 | soak | L6 | `scenarios/cases.ts` | unstated | unstated | unstated | #124 |
| 2026-10-26 | ios | B8 | the iPhone here | L6 | `scenarios/cases.ts` | unstated | unstated | unstated | #116 |
| 2026-10-26 | ios | B1 | hand | L1 | `web/test/turn.test.ts` | the back's top at 4 and its caret at 52 under the bar ending at 58, the board 250 pt tall, on an iPhone 13 mini (L6, by hand) | 3 | no | #129 |
| 2026-10-27 | webkit | B3 | nightly | L2 | `scenarios/chord.test.ts` | the ⌘Z step's keydown Control in `timeline.txt`, and Playwright's WebKit user agent (application, engine) | 0 | no | #145 |
| 2026-10-27 | ios | B3 | nightly | L6 | `scenarios/taps.test.ts` | the page's pointer lines and "taps reached the page 314 ms apart" in `timeline.txt` (runtime) | 0 | yes | #146 |
| 2026-10-28 | ios | B3 | nightly | L3 | `scenarios/touch.test.ts` | no pointer line in `timeline.txt` after the double tap, and the camera in its `◀` line (runtime, application) | 0 | yes | #148 |
| 2026-10-28 | android | B3 | nightly | L6 | `scenarios/prompts.test.ts` | Take Survey and No Thanks among the screen texts in the error (device) | 0 | yes | #160 |
| 2026-10-28 | ios | B5 | nightly | L1 | `scenarios/open.test.ts` | simctl's own "Operation timed out" in the launch step, at a runner load of 149 on 3 CPUs in `timeline.txt` (device, runner) | 0 | yes | #162 |
| 2026-10-28 | android | B5 | nightly | L1 | `scripts/test/android-snapshot.test.ts` | `adb: device unauthorized` through a cold boot that completed, and a different `qemu.adb.pubkey` on each run, in `android-emulator.log` (host) | 0 | yes | #173 |
| 2026-10-28 | web | B3 | review | L2 | `web/test/live.test.ts` | the relay's `refusal` (over 500 ids, or ids not 22 characters) missing from both FakeRelays, beside `relay/test/relay.test.mjs` refusing it under `wrangler dev` (relay) | 0 | yes | #177 |
| 2026-10-29 | ios | B5 | iOS chaos | L1 | `web/test/owner.test.ts` | `pageshow persisted`, then the app's own `pagehide` some 200 ms later, with `navigator.locks.query()` holding nothing in the restored page, in `build/ios-chaos/SEED.jsonl` (application, storage) | 0 | yes | #181 |
| 2026-10-29 | ios | B5 | iOS chaos | L7 | `web/test/saver.test.ts` | every lost edit made 2–530 ms before the page left, in `ios-chaos.ts`'s summary, and none of the boards lost with the Saver's delay at 0 on the same seed (storage) | 0 | yes | #182 |
| 2026-10-29 | web | B3 | nightly | L1 | `web/test/policy.test.ts` | the Swift core's `press` at y 48 on a lane snapped to y 0, its header's end, which the drawn steps' clamp to 48 pt in from the board's edge reaches; the web core noted no mouse press, and now does (application) | 0 | yes | #189 |

2026-10-25: in the Home Screen app, a double tap on the board at 25 % zoom made a card and zoomed to 100 %, but the caret stayed off screen until the first key brought it into view: the reveal measured from the camera as it was, not where its zoom was going.

2026-10-25: on Android, the sheet asking her name, centred in the layout, kept its OK under Chrome's keyboard whenever Chrome did not scroll, as the field already showed: the partner's first step from an invite. The sheet now fits what shows above the keyboard.


2026-10-26: in Safari on iOS 27, a card made low on the screen sent the top bar off it: as the keyboard came, iOS scrolled the page to show the card, and the fixed top bar with it. The bars at the top of the screen now go where iOS moves the visual viewport, and the board measures what shows in its own frame.

2026-10-26: on an iPhone 13 mini, a card made with a double tap, given a title and turned showed its back with its top and its caret under the top bar: the back, too tall for the board above the keyboard, is kept in sight by its caret, but an empty back had no text for the caret to be measured from, and the board kept the card's bottom in sight. The hub never saw it, as its fake drew a turned card at its front's size and could not say where a card's top was drawn.

2026-10-27: on the nightly's Linux runner, ⌘Z in WebKit put back nothing two nights running. The app was right: Playwright's WebKit says it is on a Mac on every OS, so the board waits for ⌘, but the scenarios' driver sent Ctrl for ⌘ in any desktop browser off the Mac. It now sends the board's commands as the page takes them, and only the OS's own editing keys (the caret's moves, a field's select-all) as Ctrl.

2026-10-27: on the nightly's iPhone 17, as the Home Screen app, a double tap that had made a card was tapped again, onto the keyboard, and the page stopped answering. The board had taken the two taps as one by their events' own times; the scenarios' driver judged them by when its listener ran, 314 ms apart on a runner at a load of 33 on 3 CPUs, and tried again. It now reads the events' times as the board does. `scenarios/taps.test.ts` holds its rule to the board's; the clock itself shows only on a loaded runner.

2026-10-28: in Safari on the nightly's iPhone 17, a case double tapped at a point it placed by the lane, after a card made low had left the camera with the lane above the screen: the point was in the status bar, which took both taps, and the case typed into nothing. A tap aimed off the screen now fails at once, and on the iPhone a touch the page never hears of; the hub then found a second case tapping "on nothing" off its screen, where a real phone's tap did nothing and its check passed anyway. One case aims onto the screen's board, the other taps where nothing is.

2026-10-28: on the emulator, Firefox for Android showed a survey over the page as a case began, and the touches the scenarios send to find where the page starts reached the survey, not the page. The touch probe now sends away what a browser shows over the page by its No Thanks or Not now, as a person would, and tries again.

2026-10-28: in Safari on the nightly's iPhone 13 mini, the first case failed as Safari launched: the simulator, still busy after its boot at a load of 149 on 3 CPUs, gave up on opening the first URL, and the launch ended there. It opens a URL that went nowhere again, up to four times, but took an open that failed as the end. A failed open now counts as one more try. The boot's settling leaves the phone at a load of 170 to 180, where the job runs at 40 to 60.

2026-10-28: after #170 cached the emulator's AVD with its snapshot, every Android job but the one that packed it failed to boot, the merge gate's too: each runner's adb makes its own key, and the AVD trusted only the packing runner's, from its snapshot and from cold alike. The key now goes into the cache with the AVD. Restoring on a fresh runner had been left to check after the merge.

2026-10-28: dragging a selection of more than 500 cards, as ⌘A then a drag on a big board, was cancelled as it began, on the web and the Mac: the relay refuses a hold past 500 ids whole, and the app took the refusal as someone else's hold. The relay's fakes granted it, and their tests held ids the relay refuses as malformed. The fakes now refuse as the relay does, and a gesture past 500 asks the relay to hold nothing: it goes unguarded, and live all the same.

2026-10-29: in Safari on iOS 27, Back to Breezy showed it reloading some 200 ms after it reappeared, and an edit made in between was lost: Safari lets a tab's Web Lock go while the tab sits in the back-forward cache, and the restored tab's lock request failed, which the app took for a handover. The owner tests' Device kept a frozen tab's lock. It now lets it go as Safari does, and the app starts again on `pageshow` with `persisted`, before a touch can reach it.

2026-10-29: in Safari on iOS, edits made up to half a second before the page left were lost: the Saver wrote 300 ms after the last change, and typing reached the store only at a pause, while a write issued from `pagehide` never lands there, and a kill fires nothing. A save now goes as the action that made it ends, and typing every 300 ms (#110).

2026-10-29: drawn steps, seed 377747, parted the cores on a click on the line below a lane's header: the web's pointer took a lane's header and its resize corner to include the lines they end on, where the Mac leaves them to the board, so the web kept the lane selected and the Mac cleared it. The web now hits them as the Mac does, held to it by two cases in `scenarios/conformance.test.ts`, and notes each mouse press, as the Mac does (#189).
