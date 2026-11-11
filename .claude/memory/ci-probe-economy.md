---
name: ci-probe-economy
description: "Before a CI probe or keeping a session alive, check whether a finished step's own log already answers; cancel to read it"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 4cadd51b-5eb3-442c-9875-c0704eaa29c8
  modified: 2026-11-10T20:38:15.978Z
---

Name the question a probe answers, and check whether output already in hand, or a step that already ran, answers it, before spending macOS runner time. A 10-minute "hammer simctl to reproduce a 1-in-120 race" probe overloaded the runner (load 893) and answered nothing; keeping a probe session up ~10 min just to list pairs was dropped once the boot step's own log line (`unpaired 6 watches`) was the answer.

**Why:** the owner said "be sure to use effective debugging and not waste resources and time" (2026-11-10).

**How to apply:**
- A running job's log is unreadable (`gh run view --log` refuses, `gh api …/jobs/ID/logs` trips on escape codes); `gh run cancel` then `gh run view RUN --job JOB --log` reads it in about a minute.
- Every wait loop gets a deadline, including one waiting on a cancel.
- In zsh, `status` is read-only: name loop variables otherwise.
- Related: [[native-feel-reference-testing]]
