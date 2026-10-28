# Breezy facts first — design

Debugging Breezy starts from guesses. Agents read the code, and the owner, who does not, supplies the facts by hand. This design makes Breezy record its own facts everywhere it runs, on CI and on the owner's and partner's phones. An agent can then start every investigation from what happened rather than from what the code says could happen. It is drawn from Cindy Sridharan's "How to effectively debug when you no longer understand the code" (2026-10-10), applied to Breezy.

## Why

The turned-card caret escape (#129, 2026-10-26) took 66 minutes from report to merge:

- **Code first.** Claude formed two hypotheses from code before any fact.
- **A confident wrong cause.** From one screenshot it declared "found the cause" (iOS not repainting the caret), and needed six more screenshots and a throwaway PNG decoder to disprove it.
- **The wrong device.** It reproduced on an iPhone 17, not the owner's 13 mini.

Three of the owner's five messages before the fix were facts only the owner could read: "i typed a title too", "almost off screen… barely visible under the ios menu bar", and "iPhone 13 Mini as home screen app. 2610.0.195". One reading on the mini pinned the cause: card top at 4, caret at 52, top bar to 58, board 250 pt tall. The app's own decision, to keep the card's bottom in sight because the caret had no rect, was never recorded anywhere. The run's `timeline.txt` and `case.json` sat unread while Claude wrote ad hoc probes.

The owner does not understand the code and should not have to. Every message the owner sends after a report is a fact or a control that Breezy should have gathered itself.

## Terms (from the article)

| Term | Meaning |
|---|---|
| Variable | the run, device or build where the bug shows |
| Control | the same thing without the bug: another device, the last green night, a passing pair. It can also be a run that fails in a different, louder way |
| Signal | a recorded fact that may explain the bug. It is high-fidelity when it is in the variable but not the control, and strong when few hypotheses fit it |
| Factual tier | what was recorded. Agents read it and never alter it |
| Derivative tier | hypotheses, and repros too, since a repro is a hypothesis until it reproduces the reported signal |

## Goals

1. **Facts by default.** Every Breezy run, on CI and in production, keeps a recording that answers "what did the app see, decide and draw" without a rerun.
2. **The owner stops being the factual tier.** After reporting a bug, the owner sends nothing more for the agent to find its cause.
3. **Tests get stabler and faster from the same data.** Waits, setup and runner load are facts, not guesses.
4. **Fakes are held honest by comparison, not by reading.** The hub's fakes and real devices record the same signals for the same steps.
5. **Agents follow a procedure:** facts first, a control, a hypotheses-by-fact matrix, repro parity, and reviews that eliminate rather than confirm.

## Non-goals

- Pixel video from the owner's or partner's phones. A web page cannot record its own screen; the geometry stands in for it, drawn as a wireframe.
- A hosted observability product, dashboards, or third-party telemetry.
- Replacing any level in `TESTING.md`. This feeds them.

## Anti-goals

The design has failed, even if it works, if any of these happens:

- **Words leave a device.** Titles, notes and names never go into an upload. Uploads are plaintext, a decision the owner made on 2026-10-28. The server therefore sees board layout (positions, sizes, colours, the camera), which `docs/superpowers/specs/2026-10-08-breezy-sync-design.md` otherwise hides; it never sees words.
- **The gate gets slower or less stable.** Main stays within ten minutes, every job required. Nothing here adds a real-device job or a retry to it.
- **The recorder changes what it records.** No measurable cost to feel (quality goals 2a–2c), and no new flakes from the load it adds.
- **Recordings nobody reads.** If an investigation can skip them, the procedure has failed.

## Constraints

- **Platforms** (from `.claude/memory/owner-platforms.md` and `docs/quality-goals.md`):
  - owner: iOS 27 on an iPhone 13 mini (Home Screen web app), and the Mac app;
  - partner: Chrome on a mid-range Android.
- **Consent.** The owner agreed on 2026-10-28 that Breezy may send diagnostics from both people's devices to the owner's server without either of them doing anything.
- **The shared board.** The production board is shared with the partner. Agents never act on breezy.k5d.de through the owner's browser profile (`CLAUDE.md`).
- **No hangs.** Every upload, wait and recording is bounded (`.claude/memory/no-hangs.md`).
- **Small PRs off main**, each green before it merges (`CLAUDE.md`, `.claude/memory/green-before-merge.md`).

## The recorder

There is one recorder in one format, built into the app: in the web app, and in BreezyKit for the Mac app. It is on by default wherever Breezy runs: production, every scenario run on every CI platform, the hub's fake devices (`scripts/fuzz/hub.ts`) and unit runs that construct an app.

**What it records**, each entry on a monotonic clock plus wall time:

| Kind | Examples | Why |
|---|---|---|
| Context | device model, OS and browser version, app version, screen size, DPR, standalone or tab, text size, zoom, orientation | answers "which phone, which build" without asking |
| Geometry | layout and visual viewport, keyboard area, bars, camera, the edited card's rect and side, caret rect, board area | a wireframe of what was on screen at any moment |
| Decisions | a branch the app took and why, e.g. `reveal: bottom (caret had no rect)` | the strong signal at the top layer: the article's DNS-lookup count |
| Transitions | gesture recognizer, edit, turn, sheets, update flow: from, to and the event | which state the app was in when it went wrong |
| Input as seen | pointer, touch, key, composition and focus events as the app received them, with the time they arrived | input lag and mangling (B2, B3) |
| Sync | pushes, pulls, seqs, merges and who won, the unpushed count, the relay socket's state, request timings | edits lost across devices (B4) |
| Lifecycle and storage | snapshot loaded, service worker version, visibility, freeze and resume, reloads and why | boards that won't open (B5) |
| Timing | frame gaps, long tasks, key to glyph | feel (B6), and whether a runner was slow |
| Errors | uncaught errors and rejected promises, with the entries before them | crashes nobody saw |
| Idle | when no spring, animation, layout, pending save or push is left | tests wait on this instead of polling (below) |

**Shape.**

- A bounded ring buffer of entries as JSON-serialisable objects, with a schema version.
- Card and lane ids are kept, as they are random. Text is never kept; only its length and the caret's offset are.
- The web app and BreezyKit write the same kinds under the same names, so a web recording and a Mac recording diff directly. `scenarios/conformance.test.ts` extends to require this.

**Cost.** Recording stays within the noise of the existing measures. A nightly turn runs `scripts/launch.ts` and `scripts/feel.ts` with the recorder on and off and fails on a difference beyond their noise.

## Where the recordings go

### On CI

- Every scenario run keeps each device's recording next to `timeline.txt` and `case.json`, passing or failing.
- `timeline.txt` interleaves the recordings with the harness's own lines on the wall clock, replacing what `scenarios/agent.ts` and `scenarios/record.ts` read out of pages by hand where the recording already has it.
- Hub runs keep the recordings of their fake devices too.
- The harness also records its own side: each wait (what it waited for, how many polls, how long against its bound), each setup phase (simulator and emulator boot, install, world start), and the runner's load, which it partly records already.

### Video on CI

Recorded outside the app at a low frame rate. A run keeps the video only when it fails.

| Platform | Tool |
|---|---|
| iPhone simulators | `simctl io recordVideo` |
| Android emulator | `adb screenrecord`, chained, as it stops at 3 minutes |
| Chromium, WebKit, Firefox | Playwright's video |
| Mac app | `screencapture -v` or ScreenCaptureKit |

Video ships only once one night with video and one without show no difference in the frame gaps and waits the recordings log.

### From the owner's and partner's devices

The recording is uploaded:

- **by hand:** a "something's wrong" action in the app, with no text; the owner says what was wrong in words, as now (my call: typed text could name a card);
- **on an uncaught error;**
- **on a broken production invariant:**
  - the sight check (`scenarios/sight.ts`, B1) run by the app itself once the board stands still after an edit;
  - both devices' boards still differing once both are quiet and connected;
  - a board that fails to open.

Uploads are bounded in size and rate, kept for a bounded time, writable only by devices of the space and readable only by the owner and agents the owner runs. A script fetches them for an agent (`scripts/diag.ts` or similar).

### The wireframe

A tool draws any recording as a wireframe of the screen over time: screen, bars, keyboard, cards, the edited card and its caret, the camera, and touches as dots. No text. Agents read the numbers; the owner and the agent's report show the wireframe.

## Tests: stabler and faster from the same data

- **Wait on the app's idle signal.** Cases wait for "idle" rather than polling `still` or the sight check until nothing moves. `scripts/test/discipline.test.ts` already holds cases to conditions; idle becomes the condition.
- **Waits over nights.** A summary in the nightly lists each wait's duration against its bound across nights. Waits near their bound are flakes about to happen; waits always far below it are slack to cut.
- **Setup over nights.** The same for boots, installs, world starts and each job's phases.
- **Behaviour counts gated.** Per case: syncs per edit, relay messages, reveals, renders, decisions taken. Counts are compared with the last green night by `scripts/gate.ts`'s rule (no worse than baseline beyond noise), so behaviour that drifts fails before anything breaks.

## Controls, automatically

- **A nightly failure comes with its control.** The same case on a pair that passed, or the same pair on the last green night. The summary names the first entry where the two recordings diverge, and the signals only the failure has.
- **A production report comes with one too.** Following the procedure, the agent writes the reported steps as a case and runs it on the matching CI device: a 13 mini for the owner, the Android emulator at the partner's phone's size for the partner. It records and diffs against the upload. Replaying production recordings automatically is further out.
- **Fake parity.** The same case on the hub's fake and on a real device records the same signals. A difference is a fake that lies. For example, the fake drew a turned card at 240×48 where the iPhone drew 370×288, and a diff would have shown it without anyone reading code. This answers the open question in `.claude/memory/bug-discovery-ideas.md` and gives L2 a proof by plant.
  - The fakes cannot lay out text as a phone does, so exact geometry never matches. Parity therefore compares:
    - the decisions and transitions taken;
    - the geometry the fakes claim to model: a card's size per side, whether it fits the board, and which edge is kept in sight.
  - Known differences go on a list in the repo, each with its reason (my call).
  - Parity starts as a report in the nightly summary. It turns a night red only once a plant proves it: the turned card at its front's size, put back (my call). It starts red on nothing.

## How agents debug

A procedure, kept as a skill in the repo and referenced from `TESTING.md`, that every investigation follows:

1. **Gather facts before reading code.** The report, the recordings (the owner's, the failing run's), the control's recordings, versions and devices. Code is read only to explain a fact.
2. **Find the high-fidelity signals:** what the variable has and the control lacks. What both have is noise; it eliminates hypotheses but never points.
3. **Write the hypotheses-by-fact matrix.** Count how many hypotheses each signal fits; follow the strongest.
   - If no hypothesis fits every fact, apply the article's tactics in order: re-verify how a fact was gathered, split, merge, combine, and only then form a new hypothesis.
   - If every signal is weak, descend one layer (the layer map below) for more facts rather than more hypotheses.
4. **Repro parity.** A repro counts only once it reproduces the reported signal, e.g. the same decision and geometry. Its test asserts that signal.
5. **Reviews eliminate.** A reviewer, given the facts but not the conclusion, tries to find one fact the hypothesis fails, demands citations to recorded facts, and removes each cause of a combined hypothesis to see whether a fact goes unexplained.
6. **Decisions go to the owner, framed.** When a fix has real choices, the owner gets the options with their trade-offs. Each decision the owner makes is recorded as policy agents apply next time.

**The layer map.** For each platform, what an agent can read at each layer and which of it is recorded by default. The platforms are Safari on iOS, the Home Screen app, Chrome and Firefox on Android, the desktop browsers, the Mac app, sync.php and the relay. The layers follow the article's tables: application, network, storage, runtime, engine or OS, device.

**`docs/escapes.md` gains three columns:**

- **Signal:** the fact that pinned the cause, and the layer it came from.
- **Interventions:** messages from the owner after the report.
- **Recorded by default:** whether that signal was recorded by default.

Interventions per escape is the measure of this design.

## Further out

Each of these builds on the recorder and is worth its own design when it is reached:

- **Real-user feel.** Frame times and key to glyph from the partner's Android, closing quality goals 2a and 2b's "Android" gap.
- **Replay real sessions.** Production recordings' input and viewport, replayed against each new build, as `scenarios/platform/` replays keyboard traces.
- **A canary.** A new build reaches the owner's phone first, and the partner's only once its production invariants hold for a while.
- **Develop against production.** Agents run cases against the deployed server and relay in a space of their own, rather than the full stack on the runner, which the article calls an anti-pattern for the facts it cannot reproduce.

## Order, by impact

| # | Piece | Why here |
|---|---|---|
| 1 | Web recorder, kept by every scenario and hub run on CI, interleaved into `timeline.txt` | every later piece reads it; it alone would have given #129's decision and geometry |
| 2 | The debugging procedure, the layer map and the escapes columns | costs little, and changes every investigation from the next one on |
| 3 | Uploads from the owner's and partner's devices, production invariants, the wireframe | removes the owner as the factual tier |
| 4 | Idle signal; cases wait on it | the biggest lever on flakes and on gate time |
| 5 | Automatic controls and diffs for nightly failures; fake parity | nightly reds explain themselves; fakes stop lying silently |
| 6 | Waits and setup over nights | finds slow and nearly-flaky waits before they fail |
| 7 | BreezyKit's recorder in the same format | the Mac app gets the same facts, and conformance diffs both |
| 8 | Video on CI failures, after its cost is shown | for what geometry cannot show: paint, flicker (B8) |
| 9 | Behaviour counts gated | drift caught before failure |
| 10 | Further out, each in its own design | |

## Success

- After a report, the owner sends nothing more before the cause is found. Measured as interventions per escape.
- A nightly red is explained from its recordings and its control, without a rerun.
- Time from report to cause falls. #129 took 15 minutes with three facts from the owner.
- Main stays within ten minutes; feel and launch stay at their baselines.

## Left to the builder

- The recording's exact schema, ring-buffer size and serialisation.
- How uploads are stored and authorised on the server, within the bounds above.
- How the wireframe is drawn (SVG frames, an HTML page) and where it is published for the owner.
- Which decisions and transitions to log first: those the escapes in `docs/escapes.md` turned on.
- The procedure's exact wording and the skill's name.
