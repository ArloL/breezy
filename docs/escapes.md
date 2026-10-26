# Escapes

Every bug found by hand, or by a nightly or soak run rather than the checks on each push, gets a row here with its fix: the platform it showed on, its class and the level that should have caught it (`TESTING.md`), and the test that now does. Escapes per class per month say whether the levels work.

Rows before 2026-10-25 are seeded from commit messages; "unstated" means the message does not say who found the bug, and their tests were not traced. A fix logged with its pull request names the pull request, as a rebase merge gives its commits new hashes.

| Date | Platform | Class | Found by | Should have caught | Test | Commit |
|---|---|---|---|---|---|---|
| 2026-10-07 | firefox | B2 | unstated | L5 | — | 332ff3a |
| 2026-10-07 | firefox | B2 | unstated | L5 | — | f0b3b89 |
| 2026-10-07 | web | B3 | unstated | L1 | — | b3003b1 |
| 2026-10-07 | ios | B1 | unstated | L3 | — | 4546a46 |
| 2026-10-07 | ios | B1 | unstated | L3 | — | 628cbf9 |
| 2026-10-07 | ios | B3 | unstated | L1 | — | 73ba916 |
| 2026-10-07 | ios | B3 | unstated | L6 | — | 0f64f98 |
| 2026-10-07 | ios | B3 | unstated | L6 | — | c4c5871 |
| 2026-10-07 | ios | B3 | unstated | L1 | — | bdcf43e |
| 2026-10-07 | ios | B3 | unstated | L1 | — | f3687d9 |
| 2026-10-07 | mac | B3 | unstated | L1 | — | ae9ad29 |
| 2026-10-07 | mac | B8 | unstated | L7 | — | 5d78bca |
| 2026-10-07 | mac | B8 | unstated | L7 | — | 1ba97a6 |
| 2026-10-08 | mac | B8 | unstated | L7 | — | 5c41379 |
| 2026-10-08 | web | B5 | unstated | L1 | — | 758a839 |
| 2026-10-08 | web | B5 | unstated | L6 | — | fa2e532 |
| 2026-10-08 | ios | B5 | unstated | L7 | — | cd9d942 |
| 2026-10-09 | web | B4 | unstated | L4 | — | dbada5d |
| 2026-10-10 | web | B4 | unstated | L4 | — | 169b077 |
| 2026-10-10 | web | B4 | unstated | L3 | — | c54a5e4 |
| 2026-10-10 | web | B4 | unstated | L1 | — | f6215a6 |
| 2026-10-10 | web | B4 | unstated | L6 | — | 6475073 |
| 2026-10-10 | web | B4 | unstated | L4 | — | 888d73a |
| 2026-10-11 | web | B3 | unstated | L3 | — | c14e5a8 |
| 2026-10-11 | web | B3 | unstated | L3 | — | fb49fff |
| 2026-10-11 | web | B2 | unstated | L6 | — | c087059 |
| 2026-10-11 | web | B3 | unstated | L3 | — | 036aa93 |
| 2026-10-11 | web | B8 | unstated | L6 | — | 08a38da |
| 2026-10-11 | mac | B5 | unstated | L1 | — | 6bfa998 |
| 2026-10-13 | ios | B3 | unstated | L1 | — | 830a708 |
| 2026-10-14 | android | B3 | unstated | L3 | — | 424d4ca |
| 2026-10-14 | web | B4 | unstated | L4 | — | 8375434 |
| 2026-10-14 | android | B3 | unstated | L1 | — | 90d22f2 |
| 2026-10-14 | web | B4 | unstated | L4 | — | 6dfbafd |
| 2026-10-15 | mac | B1 | unstated | L6 | — | 8f23365 |
| 2026-10-15 | web | B1 | unstated | L3 | — | a3ddf48 |
| 2026-10-15 | android | B2 | unstated | L5 | — | 6cc419a |
| 2026-10-19 | chromium | B2 | platform rows | L5 | — | d0b2795 |
| 2026-10-19 | firefox | B2 | platform rows | L6 | — | c160eb8 |
| 2026-10-19 | web | B4 | unstated | L3 | — | 441d88d |
| 2026-10-20 | ios | B8 | unstated | L7 | — | 1dd075e |
| 2026-10-22 | firefox | B3 | soak | L1 | — | 665b03d |
| 2026-10-22 | firefox | B3 | soak | L1 | — | ebc0280 |
| 2026-10-22 | web | B7 | hand | L8 | — | 025afc5 |
| 2026-10-24 | ios | B5 | iOS chaos | L7 | — | f942f51 |
| 2026-10-25 | ios | B1 | hand | L3 | `scenarios/sight.test.ts` | 76e010e |
| 2026-10-26 | ios | B8 | the iPhone here | L6 | `scenarios/cases.ts` | #116 |

2026-10-25: in the Home Screen app, a double tap on the board at 25 % zoom made a card and zoomed to 100 %, but the caret stayed off screen until the first key brought it into view: the reveal measured from the camera as it was, not where its zoom was going.

2026-10-26: in Safari on iOS 27, a card made low on the screen sent the top bar off it: as the keyboard came, iOS scrolled the page to show the card, and the fixed top bar with it. The bars at the top of the screen now go where iOS moves the visual viewport, and the board measures what shows in its own frame.
