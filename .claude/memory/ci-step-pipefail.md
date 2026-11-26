---
name: ci-step-pipefail
description: "a workflow run step with no `shell:` runs `bash -e` without pipefail, so `node … | tee | sed` passes when node fails"
metadata:
  node_type: memory
  type: project
  originSessionId: cf147f3a-c1d9-45e7-9901-fda147195e4a
  modified: 2026-11-26T15:27:28.816Z
---

A GitHub Actions `run:` step with no `shell:` (and nightly.yaml sets no `defaults.run.shell`) runs as `bash -e {0}`: no pipefail. A pipeline's status is its last command's, so `(node --test … | tee f | sed …) & wait $!` went green on 2026-11-26 (run 45842606199) with Chromium's and Firefox's strokes red in the log.

**Why:** a step green over a red test hides it, as AGENTS.md's "none merged red" warns.

**How to apply:** any step that pipes a test's output sets `shell: bash` (which adds `-o pipefail`) or `set -o pipefail`; after a nightly, read the step's log or artifact for `ℹ fail`, not only its conclusion. See [[ci-probe-economy]], [[watcher-shell-pitfalls]].
