# Breezy facts first — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Breezy records what it saw, decided and drew wherever it runs, and agents debug from those recordings.

**Architecture:** Each `App` owns a `Flight`, a bounded ring of entries that holds numbers, ids and enums, never words. The app notes its decisions, transitions, input as seen, geometry and errors in it. The scenario harness reads each device's recording and keeps it beside `timeline.txt`, interleaving its entries into the timeline. The hub's fakes run the same `App` code, so they record the same entries.

**Tech Stack:** TypeScript on Node 24 (`node --test`, type stripping), Playwright, the hub on virtual time (`scripts/fuzz/virtual.ts`).

**Spec:** `docs/superpowers/specs/2026-10-28-breezy-facts-first-design.md`

## Global Constraints

- **No words:** titles, notes and names never go into a recording. Only ids, numbers, booleans and enum strings do.
- **Main stays within ten minutes**, every job required. Nothing here adds a real-device job or a retry to it.
- **Never break the app:** a note can never throw into the app.
- **Bounded:** the ring keeps the newest 4000 entries. Every harness read of a recording is bounded by the 5 s `answer` that `RealWorld.record` already uses.
- **Small PRs off main**, green before merge. Part A is one PR; Part B is another, opened once A has merged.
- Comments follow the repo's style: one short line saying why, written in prose.

## Review Focus

1. **Words in a recording.** A card's text, back, lane title or a person's name must not appear in `JSON.stringify(recording)` after an edit session. Test: A2 step 1.
2. **A recording that throws.** `geometry()` while the edited card has just been deleted under it (a remote delete) must return without throwing. Test: A2 step 1.
3. **A long session.** 10,000 notes must keep only the newest 4000, in order. Test: A1 step 1.
4. **Floods.** Pointer moves and pinch frames must not be noted each frame; viewport changes must be coalesced to one entry per animation frame. Test: A3 step 1.
5. **A page without a recorder.** An old build served by the service worker, or the Mac app, must give the record "no flight recording" and fail nothing. Test: A5 step 1.

---

## Part A — the web recorder, kept by every run (spec piece 1)

### Task A1: `Flight`

**Files:**
- Create: `web/flight.ts`
- Test: `web/test/flight.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Kind = "context" | "geometry" | "decision" | "transition" | "input" | "sync" | "life" | "timing" | "error";
  export type Value = number | boolean | string | null | Value[] | { [k: string]: Value };
  export type Entry = [t: number, kind: Kind, what: string, data?: { [k: string]: Value }];
  export interface Recording { schema: 1; origin: number; dropped: number; entries: Entry[] }
  export class Flight {
    constructor(o?: { now?: () => number; wall?: () => number; size?: number });
    note(kind: Kind, what: string, data?: { [k: string]: Value }): void;
    recording(): Recording;
  }
  export const box: (r: { x: number; y: number; w: number; h: number } | null | undefined) => Value;
  ```
  - `t` is ms on `now`, rounded to 0.1; `origin` is the wall time at `t = 0`, so `origin + t` is wall time.
  - `dropped` counts entries the ring overwrote.
  - `box` rounds a rect to 0.1 as `[x, y, w, h]`, or `null`.

- [ ] **Step 1: Write the failing tests** in `web/test/flight.test.ts`:
  - `"keeps the newest entries, in order, and counts what it dropped"`: `size: 4000`, 10,000 notes `note("input", "tap", { n: i })`; `entries.length === 4000`, the first `data.n === 6000`, the last `9999`, `dropped === 6000`.
  - `"stamps entries on its clock and its origin on the wall"`: `now` returns 100 then 250.04; `wall` returns 1,000,000 at construction. `origin === 1_000_000 - 100`, and the entry's `t === 250`.
  - `"never throws"`: a `data` object with a getter that throws is noted as `[t, kind, what, { unreadable: true }]`.
  - `"rounds boxes"`: `box({ x: 1.234, y: 2, w: 3.06, h: 4 })` deep-equals `[1.2, 2, 3.1, 4]`, and `box(null) === null`.
- [ ] **Step 2: Run** `node --test web/test/flight.test.ts`. Expected: FAIL, as `web/flight.ts` does not exist.
- [ ] **Step 3: Implement `web/flight.ts`.**
  - A fixed-size array with a write index.
  - `note` copies `data` through `JSON.parse(JSON.stringify(data))` inside a `try`, so later mutation of the caller's object cannot change it, and a throw becomes `{ unreadable: true }`.
- [ ] **Step 4: Run** `node --test web/test/flight.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** with a message saying what the recorder keeps and why.

### Task A2: the app notes its edits, turns and reveals

**Files:**
- Modify: `web/app.ts`: the constructor, `turn`, `beginEdit`, `endEditing`, `cancelEditing`, `beginRename`, `refused`, `revealEditing`, and a new `geometry()`.
- Test: `web/test/flight-app.test.ts`

**Interfaces:**
- Consumes: `Flight`, `box` (A1).
- Produces:
  - `App.flight: Flight`, created in the constructor;
  - `App.geometry(): { [k: string]: Value }` with these keys:
    - `area: [top, bottom]` from `this.view.area()`;
    - `cam: [x, y, zoom]`;
    - `editing: null | { id, back, card: box(screen rect), caret: box | null, top: number | null }`.

  Notes:

  | Kind | What | Data |
  |---|---|---|
  | `transition` | `turn` | `{ from, to }` |
  | `transition` | `edit` | `{ id, back }` |
  | `transition` | `edit end` | `{ id, back }` |
  | `transition` | `edit cancel` | `{ id }` |
  | `transition` | `rename` | `{ id }` |
  | `transition` | `rename end` | `{ id }` |
  | `transition` | `refused` | `{ ids: n }` |
  | `decision` | `reveal` | `{ path: "card" \| "caret", why: "fits" \| "no caret" \| "no top" \| "too tall", ...geometry() }` |

- [ ] **Step 1: Write the failing tests** in `web/test/flight-app.test.ts`, building the app as `web/test/turn.test.ts` does (`new App(board, fakePorts)`, a board as short as a mini's):
  - `"notes why a turned card's reveal kept its bottom"`:
    - begin an edit, type a title, `switchSide()` to the empty back;
    - the last `decision`/`reveal` entry has `path === "caret"` and `why === "too tall"`, and its `editing.caret` is a box.
    - There is no plant for #129, so the `"no caret"` path is checked by a `FakeView` whose `caretRect` returns null, which is what main did before #129.
  - `"notes edits and turns as transitions"`: the `transition` entries' `what`s are `["edit", "turn", "edit end"]` in order.
  - `"keeps no words"`: give the card the text `"WORDS-q7 title"`, notes `"WORDS-q7 back"` and a lane `"WORDS-q7 lane"`, through edits and a rename. `JSON.stringify(app.flight.recording())` does not contain `"WORDS-q7"`.
  - `"geometry survives the edited card's removal"`: begin an edit, remove the card from the model as a remote delete does (`model.replace` without it), then call `geometry()`. It does not throw, and `editing` is `null`.
- [ ] **Step 2: Run** `node --test web/test/flight-app.test.ts`. Expected: FAIL, as `app.flight` is undefined.
- [ ] **Step 3: Implement the notes.**
  - `revealEditing` notes one `reveal` per call, with the branch it takes. `why` is:
    - `"fits"` when not too tall;
    - `"no caret"` when too tall and `caretRect` gave null;
    - `"no top"` when `topOf` gave null;
    - `"too tall"` when it reveals the caret's line.
- [ ] **Step 4: Run** `node --test web/test/flight-app.test.ts web/test/*.test.ts`. Expected: PASS, and no other web test changed.
- [ ] **Step 5: Commit.**

### Task A3: input as the app saw it, and floods kept out

**Files:**
- Modify: `web/input.ts`: the `GestureHandler` methods (`tap`, `doubleTap`, `hold`, `holdEnd`, `holdCancel`, `dragStart`, `dragEnd`, `dragCancel`, `pinchStart`, `pinchEnd`, `pinchCancel`, `zoomDragStart`, `zoomDragEnd`, `zoomDragCancel`) and `beginDrag`.
- Test: `web/test/flight-app.test.ts`

**Interfaces:**
- Consumes: `App.flight` (A2).
- Produces: `input` entries named as the method, in words (`"double tap"`, `"drag start"`, …), with `{ x, y }` rounded, and `{ held }` for `dragStart`.
  - `beginDrag` notes a `transition` `drag` with `{ action, ids: n }`.
  - `dragMove`, `pinch` and `zoomDrag` are not noted.

- [ ] **Step 1: Write the failing test** `"notes gestures, not their frames"`: drive `app.input` through a tap, a double tap and a drag of 20 moves (as `web/test/input.test.ts` does). The `input` entries are exactly `["tap", "double tap", "drag start", "drag end"]`, and one `transition` `drag` follows `drag start`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run** `node --test web/test/*.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task A4: the page's context, lifecycle, viewport and errors

**Files:**
- Modify: `web/main.ts`

**Interfaces:**
- Consumes: `App.flight`, `App.geometry()`.
- Produces:
  - `globalThis.breezyFlight = app.flight`, which the harness reads;
  - one `context` `page` entry at start: `{ ua, screen: [w, h], dpr, standalone, version }`. `version` is `[data-act="version"]`'s `data-version`, and `standalone` is `matchMedia("(display-mode: standalone)").matches || navigator.standalone === true`;
  - `life` entries: `visible`, `hidden`, `pagehide`, `pageshow { persisted }`;
  - `geometry` `viewport` entries: `{ inner: [w, h], visual: [offsetTop, h, w], ...app.geometry() }`, coalesced to one per animation frame across `resize` and `visualViewport` `resize` and `scroll`;
  - `error` entries: `uncaught { message hash, where }` and `rejected { message hash }`. A message can quote card text, so only a hash of it (`String#length` plus a 32-bit FNV-1a, as hex) and the error's top stack frame's file:line are kept.

There is no unit test, as `main.ts` runs only in a page. Task A5's e2e step checks these entries.

- [ ] **Step 1: Implement it**, then run `npm run check`. Expected: no errors.
- [ ] **Step 2: Commit.**

### Task A5: the harness keeps every device's recording

**Files:**
- Modify:
  - `scenarios/record.ts`: add `flightLines`;
  - `scenarios/device.ts`: add `Device.flight()`;
  - `scenarios/browser.ts`: `readFlight`, overrides in `BrowserDevice` and `IosDevice`, and `RealWorld.record`;
  - `scripts/fuzz/hub.ts`: the `Command` union gets `{ cmd: "flight" }`;
  - `scripts/fuzz/web-device.ts`: the `"flight"` command;
  - `scenarios/world.ts`: the hub device's `flight()`;
  - `scenarios/cases.test.ts`;
  - `TESTING.md`: the levels' records, one sentence.
- Test: `scenarios/record.test.ts`

**Interfaces:**
- Consumes: `Recording` (A1), `globalThis.breezyFlight` (A4).
- Produces:
  - `flightLines(r: Recording | null, who: string): Line[]`. Each entry becomes `[r.origin + t, `${who} app`, `${kind} ${what}${data ? ` ${brief(data)}` : ""}`]`. A null recording gives `[]`.
  - `Device.flight(): Promise<Recording | null>`, which returns `null` by default (the Mac app until piece 7).
  - On `BrowserDevice` and `IosDevice`, `this.page.evaluate(readFlight)`, where `readFlight` returns `breezyFlight?.recording() ?? null`.
  - `RealWorld.record`, per device:
    - writes `${who} flight.json`;
    - pushes `flightLines` into `lines`;
    - adds `"${who}: no flight recording"` to the summary when the recording is null or unread.
  - The hub: the `"flight"` command returns `this.open?.app.flight.recording() ?? null`. `cases.test.ts`, on a failing case, writes each device's recording to `build/hub/<test>/d<i> flight.json` and names the folder in the failure.

- [ ] **Step 1: Write the failing tests** in `scenarios/record.test.ts`:
  - `"a recording's entries become timeline lines on the wall clock"`: a recording with `origin: 1000` and entries `[[5, "decision", "reveal", { path: "card" }]]` gives `[[1005, "d0 webkit app", "decision reveal {\"path\":\"card\"}"]]`.
  - `"no recording gives no lines"`: `flightLines(null, "d0") ` deep-equals `[]`.
- [ ] **Step 2: Run** `node --test scenarios/record.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement A5's interfaces.**
- [ ] **Step 4: Run** `node --test scenarios/record.test.ts` and `npm run check`. Expected: PASS.
- [ ] **Step 5: Run the hub's cases** with `node --test scenarios/cases.test.ts`. Expected: PASS, as before.
- [ ] **Step 6: Run one real case end to end.** Run one smoke case in Chromium, as `.github/workflows/main.yaml`'s desktop job does (`SCENARIO_SMOKE=1`, filtered to one case by `--test-name-pattern`). In its `build/scenarios/<when> <case>/`, check that:
  - `d0 chromium flight.json` exists;
  - `timeline.txt` has `d0 chromium app` lines with `context page`, `transition edit` and `decision reveal`.
- [ ] **Step 7: Commit, push, and open PR A** (spec, plan, A1–A5). Merge it once Main is green.

---

## Part B — how agents debug (spec piece 2)

Opened off main once Part A has merged, as its procedure reads the recordings.

### Task B1: the procedure as a repo skill

**Files:**
- Create: `.claude/skills/debugging-breezy/SKILL.md`
- Modify:
  - `TESTING.md` ("When a bug escapes": step 0, follow the skill);
  - `CLAUDE.md` (one line: debug through `.claude/skills/debugging-breezy`).

The skill's frontmatter `description` reads: "Use when a Breezy bug is reported by hand, a nightly run is red, or a test fails for a reason not yet known — before reading code to explain it".

Its body is the spec's six steps ("How agents debug"), each one imperative line plus the Breezy specifics:
- where recordings live: `build/scenarios/<when> <case>/<who> flight.json`, `build/hub/<test>/`, and the uploads once piece 3 lands;
- which control to choose per platform: the owner's report against a 13 mini on iOS 27; the partner's against the Android emulator at the partner's phone's size; a nightly failure against the same case on a passing pair or on the last green night;
- the hypotheses-by-fact matrix as a markdown table in the investigation's notes;
- the five tactics, in order;
- repro parity: the fix's test asserts the reported signal;
- reviews that eliminate, briefed with the facts but not the conclusion;
- the escape row's three new columns.

The body stays under 80 lines.

- [ ] **Step 1: Write the skill**, then run `npm test`. `scripts/test/docs.test.ts` checks the paths `TESTING.md` names. Expected: PASS.
- [ ] **Step 2: Commit.**

### Task B2: the layer map

**Files:**
- Create: `docs/layers.md`
- Modify: `TESTING.md`, linking it next to `docs/platform-expectations.md`.

The map has one table per platform: Safari on iOS and the Home Screen app, Chrome and Firefox on Android, the desktop browsers, the Mac app, sync.php, and the relay.
- The rows are the article's layers: application, network, storage, runtime, engine or OS, device.
- The columns are: what an agent can read; how, by exact command or file; and whether it is recorded by default.

Fill each cell from what the repo already does: `scenarios/browser.ts`'s page watcher, `scripts/android-capture.sh`, `adb logcat`, `simctl`, `scenarios/agent.ts`, `wrangler tail`, and the deploy check. Mark a cell "not reachable" where nothing reaches it.

- [ ] **Step 1: Write it**, then run `npm test`. Expected: PASS.
- [ ] **Step 2: Commit.**

### Task B3: the escapes' new columns

**Files:**
- Modify: `docs/escapes.md` (header, rows and the opening paragraph), `scripts/test/docs.test.ts`.

The new columns are Signal, Interventions and Recorded, after Test.
- **Seeded rows** (before 2026-10-25) take `—` in all three.
- **Rows since 2026-10-25** carry them where the history shows. For #129:
  - Signal: `caret at 52 under the bar to 58, board 250 pt (L6, by hand)`;
  - Interventions: `3`;
  - Recorded: `no`.
- **Rows the history can't fill** take `unstated`.
- **The test checks** that:
  - the header is the new one;
  - Interventions is a number, `—` or `unstated`;
  - Recorded is `yes`, `no`, `—` or `unstated`;
  - rows since 2026-10-28 fill all three.

- [ ] **Step 1: Change the test first** to the new header and rules, and run `node --test scripts/test/docs.test.ts`. Expected: FAIL on the header.
- [ ] **Step 2: Change `docs/escapes.md`**, then run `node --test scripts/test/docs.test.ts`. Expected: PASS.
- [ ] **Step 3: Commit, push, and open PR B.** Merge it once Main is green.

---

## Later parts, each planned when reached

Each gets its own section here, written with the code as it stands then, and its own PR or PRs off main.

| Part | Spec piece | What it delivers | Decision to make when planning |
|---|---|---|---|
| C | 3 | sync.php's diagnostics endpoint (bounded, space-scoped writes, owner-read); the app uploads on "something's wrong", on errors, and on its own sight check (moving `readSight` into the app, against `FakeView.sight()`) and convergence checks; `scripts/diag.ts`; the wireframe | the upload's rate and size bounds, and its retention |
| D | 4 | the app's idle signal, and the cases' `still` waits on it | which pending things count as busy |
| E | 5 | a nightly failure diffed against its control; fake parity with its allow-list, as a report | the diff's alignment of two recordings |
| F | 6 | waits and setup across nights in the nightly summary | where the nights' history is kept |
| G | 7 | BreezyKit's `Flight` in the same format; conformance compares both | |
| H | 8 | video on CI failures, after the A/B night | frame rate per platform |
| I | 9 | behaviour counts gated against the last green night | which counts |
