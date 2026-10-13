# Quality goals

Breezy is for two people: me on the Mac, my partner in the web app on a mid-range Android phone. We mostly use shared boards apart: one changes cards, the other sees them later. Each of the four goals below would make one of us stop using it if missed. When they conflict, the higher one wins.

| # | Goal | In short |
|---|---|---|
| 1 | Ease for the partner | Obvious on Android from the first session |
| 2 | Feel | Drag, zoom and typing feel instant |
| 3 | Convergence | No edit is lost; devices end up the same |
| 4 | Availability | Boards open, with the other's latest changes, whenever needed |

Constraints, not goals: boards stay end-to-end encrypted, and hosting stays cheap (PHP and MySQL, a Cloudflare Worker).

## Scenarios

### 1. Ease for the partner

The partner judges Breezy on the first sessions; one confusing moment costs trust.

| | Scenario | Measure |
|---|---|---|
| 1a | First use: from the invite link, install, join the space, open my board | ≤ 3 min, no help, no question she can't answer |
| 1b | Touch: one finger on a card drags it, on empty space pans; pinch zooms | 10 min untutored session: no accidental move or pan, no undo of a gesture she didn't mean |
| 1c | Writing: make a card, type with Android's keyboard, finish | Works on the first try; the keyboard never covers the line being typed |
| 1d | Finding: open the app, find the card I added since her last visit | ≤ 10 s |
| 1e | Updates: a new version is ready | Never interrupts an edit; never stuck on "open in another tab" |

### 2. Feel

| | Scenario | Measure |
|---|---|---|
| 2a | Drag a card on a 100-card board, mid-range Android | Card stays under the finger; p95 frame ≤ 16.7 ms |
| 2b | Type into a card, mid-range Android | p95 key to glyph ≤ 50 ms |
| 2c | Launch from the Home Screen | ≤ 1.5 s to an interactive board |
| 2d | Any change, on the Mac and in the browsers | No `bench.sh` or `feel.ts` measure worse than its baselines (`scripts/gate.ts`) |

### 3. Convergence

| | Scenario | Measure |
|---|---|---|
| 3a | I edit a board offline on the Mac while she edits it on Android | ≤ 10 s after both are online, both show both changes |
| 3b | We both edit the same card | Both edits survive |
| 3c | Any release | Fuzzer seeds and `scenarios/` pass, no failures |

### 4. Availability

| | Scenario | Measure |
|---|---|---|
| 4a | I add a card; an hour later she opens the app | My card shows ≤ 5 s after launch |
| 4b | She opens the app without network | Boards open and stay editable; edits sync once online |
| 4c | `sync.php` or the relay is down | Both apps keep working, lose nothing, show they are offline unobtrusively |

## Gaps

Chrome on an Android emulator runs the touch scenarios nightly, so 1b's gestures work on Android; nothing judges whether they surprise. Its keys come through DevTools, not Android's keyboard (1c). Nothing measures 1a, 1d, 1e, 2a–c or 4 on Android: `feel.ts` times desktop Chromium, and an emulator's timings do not stand for a mid-range phone. No scenario opens a board offline (4b). Live collaboration (relay, direct channel, cursors) serves none of these goals beyond 3a.
