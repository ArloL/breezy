---
name: frames-ratchet-all-rules
description: "Before adding a build's findings to mac-pinch-known.json, compare every rule against main's build, not only the owner's four reports"
metadata:
  node_type: memory
  type: feedback
  originSessionId: cf147f3a-c1d9-45e7-9901-fda147195e4a
  modified: 2026-11-26T09:38:01.877Z
---

Before writing a fixed build's findings into scripts/test/mac-pinch-known.json, count strokes per rule (coverage, flicker, scrollers, curve, continuity, follow) for main's build and the fix, side by side. A rule that rises is a regression, not "known".

**Why:** 2026-11-26, #309 fixed the pinch's grey and flicker (reports 22→3, 24→0) but made the board slip 2–15 pt from under the fingers on 24 strokes (follow 0→24); I compared only the four reports, ratcheted the slip in as known, and the owner turned on auto-merge on that summary. Caught only while working the next fix; auto-merge was turned off.

**How to apply:** fixtures of main's build may live only in the scratchpad; replay main's build first if none is at hand. Related: [[native-feel-reference-testing]].
