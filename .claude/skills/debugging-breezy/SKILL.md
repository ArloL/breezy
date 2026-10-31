---
name: debugging-breezy
description: Use when a Breezy bug is reported by hand, a nightly run is red, a test fails for a reason not yet known, or the harness, CI, a device, a tool or a setup step misbehaves (a slow or flaky step, a log that does not read, a probe's surprising number) — before reading code or guessing to explain it
---

# Debugging Breezy

Code says what can happen; recordings say what did. Start from facts, find the signal a control lacks, and keep only
the hypothesis every fact allows. Design: `docs/superpowers/specs/2026-10-28-breezy-facts-first-design.md`.

This holds for everything that fails, not only the app: a driver's tap, a CI step, the simulator's log, a probe of your
own. A tap's 317 ms was idb's companion overrunning its own sleep, found from the companion's log against the page's
event times; the iPhone's log failing to compose on CI was a `DYLD_SHARED_CACHE_DIR` pointing at an empty folder, found
from `logd_helper`'s own log against a Mac's. Neither was a guess that came true.

- **Your own probes are facts gathered by you:** check the path, the clock and the instrument before reading the
  number. A probe looked for the iPhone's text under a folder no iPhone has, and a HID client listed the touchscreens of
  the moment it was made; both read as findings.
- **Keep each measurement where it can be read back:** in the job's log or artifact, not only its step summary, which
  no API returns.
- **Iterate where a cycle is short:** the local simulator for what reproduces there, `.github/workflows/probe-session.yaml`
  for what only CI's runner shows. One question per run, its control alongside.

## 1. Gather facts before reading code

- **The report**, word for word. **Don't ask the owner for anything a recording or the repo holds.** Their phone and build are in the recording's `context`. The owner uses an iPhone 13 mini on iOS 27 with the Home Screen app, and the Mac app; the partner uses Chrome on a mid-range Android.
- **The recordings:**
  - a run's `build/scenarios/<when> <case>/`: `timeline.txt`, `case.json`, and `<who> flight.json` per device;
  - a failing hub case's `build/hub/<test>/`;
  - a nightly's artifacts: `gh run download`, a failing case's `<who> video` among them when the night filmed;
  - what the owner's or partner's phone sent, on "Report a Problem", an error, or a card out of sight (its `decision sight broken` entry holds the card, caret and board as the app's own sight check read them): `BREEZY_INVITE='<invite link>' node scripts/diag.ts` lists them, and with an id saves and draws one under build/diag. Ask the owner for an invite link once a session, and never keep it in a file or a memory.
- **Versions and devices.** Ask which OS version before chasing a finding seen only on one the owner and partner don't run: a caret bug on CI's iOS 26.5 was no bug of theirs. Read code only to explain a fact you hold.

## 2. Find the high-fidelity signals with a control

Pick the control first:

| Variable | Control |
|---|---|
| the owner's iPhone report | the same steps on an iPhone 13 mini on iOS 27, Home Screen app (`IPHONE`, `scripts/ios.ts --home`) |
| the partner's Android report | Chrome on the emulator at the partner's phone's size |
| a red nightly case | the same case on a pair that passed, which the night's summary already diffs ("Failures against their controls", `node scripts/controls.ts DIR…` on downloaded runs), or the same pair on the last green night |
| a failing hub case | the same case on the real device of that kind, or with its fake swapped |

Diff the two recordings. What only the variable has is a high-fidelity signal. What both have is noise: it can rule a hypothesis out, but it never points to one.

Check that the control is not broken the same way.

## 3. Write the hypotheses-by-fact matrix

- **Write it in your notes:** one row per hypothesis, one column per fact, ✓ or ✗ in each cell.
- **Read the columns.** A fact few rows fit is a strong signal; follow the row it points to.
- **If no row is all ✓**, work through these in order, rebuilding the matrix after each:
  1. Re-verify how each fact was gathered: host, time, build.
  2. Split a hypothesis that bundles two ideas.
  3. Merge fine-grained ones into what they share.
  4. Combine complementary ones; each must still be needed.
  5. Only then form a new hypothesis, from the facts you have.
- **If every signal is weak, descend one layer** (`docs/layers.md`) for more facts, not more hypotheses. Stop at the first strong signal.

## 4. Repro parity

- A repro is a hypothesis until it reproduces the reported signal: the same decision, transition or geometry in its recording.
- Its test asserts that signal, at the lowest level that shows it (`TESTING.md`).
- If a fake was wrong, teach it, and diff its recording against the real device's; the night's summary lists decisions a fake and its real device did not both take ("Fakes against real devices").

## 5. Reviews eliminate

- Brief a reviewer with the facts and the matrix, not your conclusion.
- Ask it to find one fact the hypothesis fails, and to cite a recorded fact for every claim.
- For a combined hypothesis, ask it to remove each cause in turn and see whether a fact goes unexplained.
- Agreement proves nothing. A contradiction ends the hypothesis.

## 6. Decide, then make it policy

- Choices a fix forces that only the owner can make go to them as options, each with its trade-off.
- Record their answer where agents read it next time: `CLAUDE.md` for any change, `TESTING.md` or this skill for testing and debugging, a comment beside the code it constrains.

## Log the escape

Add a row to `docs/escapes.md` with these columns:
- **Signal:** the fact that pinned the cause, and its layer.
- **Interventions:** messages from the owner after the report.
- **Recorded:** whether the signal was recorded by default.

If it wasn't, record it by default next (`web/flight.ts`).
