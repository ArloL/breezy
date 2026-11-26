---
name: ci-probe-economy
description: "Before a CI probe or run, name its question and check a finished step's log; cancel to read it; ask one step's question with the smallest job on that step's own runner"
metadata:
  type: feedback
  originSessionId: 4cadd51b-5eb3-442c-9875-c0704eaa29c8
  modified: 2026-11-26T19:45:00.000Z
---

Name the question a probe answers, and check whether output already in hand, or a step that already ran, answers it, before spending macOS runner time. A 10-minute "hammer simctl to reproduce a 1-in-120 race" probe overloaded the runner (load 893) and answered nothing; keeping a probe session up ~10 min just to list pairs was dropped once the boot step's own log line (`unpaired 6 watches`) was the answer.

Ask a question of one step with the smallest vehicle on that step's own runner. `probe-session.yaml` is the iOS runner (`xcode-27`, an iPhone booting), not `macos-latest`, so it can't answer what the desktop job's runner does. On 2026-11-26 four whole desktop runs (~40 min each, 25 of them device scenarios) were dispatched for questions only the 9-minute strokes step answered; the fix was the nightly's own `strokes` job (`only=strokes`, ~12 min).

**Why:** the owner said "be sure to use effective debugging and not waste resources and time" (2026-11-10), and asked "are we doing this effectively?" after the fourth desktop run (2026-11-26).

**How to apply:**
- Before dispatching a whole job for one step's answer, look for a job or `only=` that runs that step alone on the same runner; if none, adding one is usually cheaper than a second full run.
- A running job's log is unreadable (`gh run view --log` refuses, `gh api …/jobs/ID/logs` trips on escape codes); `gh run cancel` then `gh run view RUN --job JOB --log` reads it in about a minute.
- Every wait loop gets a deadline, including one waiting on a cancel.
- In zsh, `status` is read-only: name loop variables otherwise.
- Related: [[native-feel-reference-testing]], [[ci-headless-frame-rates]]
