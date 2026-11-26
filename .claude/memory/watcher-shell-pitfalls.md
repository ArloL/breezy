---
name: watcher-shell-pitfalls
description: Background watchers here run in zsh and parse gh JSON: list items literally, keep gh's stderr out of the parse
metadata:
  type: feedback
---

Background watcher loops run in the session's zsh, not bash: `for r in $runs` does not split a string into words, so a list of run ids became one id and every poll 404'd. List items literally (`for r in 111 222`) or use an array. `gh` prints hints on stderr: merged into the output (`2>&1`) they break `jq`, and the loop read every run as finished. Capture stderr apart (`2>$tmp`) and treat an unparsed poll as a failed poll, never as done.

**Why:** 2026-11-26, three watchers on two nightly runs failed this way in a row; one claimed both runs done at once.

The same bit again on 2026-11-26: `set -- $r` left `$2` empty, and a watcher reported a PR's head moved when it had merged; read fields with `jq` one by one instead.

**How to apply:** before leaving a watcher running, read its first poll's output once. Related: [[ci-probe-economy]].
