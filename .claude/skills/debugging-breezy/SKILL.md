---
name: debugging-breezy
description: Use when a Breezy bug is reported by hand, a nightly run is red, a test fails for a reason not yet known, or the harness, CI, a device, a tool or a setup step misbehaves (a slow or flaky step, a log that does not read, a probe's surprising number) — before reading code or guessing to explain it
---

# Debugging Breezy

Load the `effective-debugging` skill and follow its loop. This skill says where Breezy keeps what the loop asks for. Design: `docs/superpowers/specs/2026-10-28-breezy-facts-first-design.md`.

The tooling fails like the app does. A tap's 317 ms was idb's companion overrunning its own sleep, found from the companion's log against the page's event times; the iPhone's log failing to compose on CI was a `DYLD_SHARED_CACHE_DIR` pointing at an empty folder, found from `logd_helper`'s own log against a Mac's. A probe once looked for the iPhone's text under a folder no iPhone has, and a HID client listed the touchscreens of the moment it was made; both read as findings.

## Facts

- **The owner's and partner's devices:** the owner uses an iPhone 13 mini on iOS 27 with the Home Screen app, and the Mac app; the partner uses Chrome on a mid-range Android. Their phone and build are in the recording's `context`. A caret bug on CI's iOS 26.5 was no bug of theirs.
- **CI's runner, from 5,700 cases over 30 runs in the week to 2026-11-03:** a job's first case always runs at a load over 100 on 3 CPUs, falling to 65–80 by its sixth, and fails about 12 times as often as its later ones: 3.9 % (95 % CI 1.5–9.7) against 0.3 % (0.2–0.6). On one image, the same code took 0.89 to 1.28 times as long as another run's, job by job, so compare two versions in turns on one runner (`probe-session.yaml`), not across runs.
- **CI's iPhones since 2026-11-05:** the iPhone 13 mini boots slim, without `scripts/ios-services-off.txt`, and the iPhone 17 stock, as its control: a case failing only on the first may be slim's doing. The figures above are from before it.
- **The recordings:**
  - a run's `build/scenarios/<when> <case>/`: `timeline.txt`, `case.json`, and `<who> flight.json` per device;
  - a failing hub case's `build/hub/<test>/`;
  - a nightly's artifacts: `gh run download`, a failing case's `<who> video` among them when the night filmed;
  - a page on the dev server (`npm run dev`): its flight recording, posted every 5 s to `build/flight/<browser> <page>.json`, a new page id on each reload; each wheel stream is one `wheel` entry, deltas and camera per event;
  - a night's `night-report` artifact: its summary as Markdown, and `runner-facts.json`, what ran under its cases job by job (`scripts/runner-facts.ts`);
  - what the owner's or partner's phone sent, on "Report a Problem", an error, or a card out of sight (its `decision sight broken` entry holds the card, caret and board as the app's own sight check read them): `BREEZY_INVITE='<invite link>' node scripts/diag.ts` lists them, and with an id saves and draws one under build/diag. Ask the owner for an invite link once a session, and never keep it in a file or a memory.
- **The next layer:** `docs/layers.md`.
- **Where to probe:** the local simulator for what reproduces there, `.github/workflows/probe-session.yaml` for what only CI's runner shows. Keep each measurement in the job's log or artifact, not only its step summary, which no API returns.

## Controls

| Variable | Control |
|---|---|
| the owner's iPhone report | the same steps on an iPhone 13 mini on iOS 27, Home Screen app (`IPHONE`, `scripts/ios.ts --home`) |
| the partner's Android report | Chrome on the emulator at the partner's phone's size |
| a red nightly case | the same case on a pair that passed, which the night's summary already diffs ("Failures against their controls", `node scripts/controls.ts DIR…` on downloaded runs), or the same pair on the last green night |
| a failing hub case | the same case on the real device of that kind, or with its fake swapped |

## Repros

- A repro's reported signal here is the same decision, transition or geometry in its recording.
- Its test asserts that signal, at the lowest level that shows it (`TESTING.md`).
- If a fake was wrong, teach it, and diff its recording against the real device's; the night's summary lists decisions a fake and its real device did not both take ("Fakes against real devices").

## Decisions

Record the owner's answer in `AGENTS.md` for any change, `TESTING.md` or this skill for testing and debugging, or a comment beside the code it constrains.

## Log the escape

Add a row to `docs/escapes.md` with these columns:
- **Signal:** the fact that pinned the cause, and its layer.
- **Interventions:** messages from the owner after the report.
- **Recorded:** whether the signal was recorded by default.

If it wasn't, record it by default next (`web/flight.ts`).
