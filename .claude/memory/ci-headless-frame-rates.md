---
name: ci-headless-frame-rates
description: "on CI's macOS runner headless Firefox and WebKit draw at 60 Hz, Chromium ~21 fps with input up to 7.5× late; the owner's Mac draws at 120 Hz"
metadata:
  node_type: memory
  type: project
  originSessionId: cf147f3a-c1d9-45e7-9901-fda147195e4a
  modified: 2026-11-26T17:03:24.689Z
---

Measured from nightly run 45859414569's `strokes` artifact frames (2026-11-26), the three browsers replaying side by side:

| | CI frame median | input span vs capture |
|---|---|---|
| Firefox | 17 ms (p90 22) | ≤ 1.00 |
| WebKit | 17 ms | ≤ 1.00 |
| Chromium | 46.6 ms | median 1.21, max 7.48, 24 of 41 over 1.1 |

The owner's Mac: 8 ms (p90 10) for Firefox. So a level-3 finding or tolerance taken on the Mac does not carry to CI: a fast pinch's zoom read a frame later reads as 0.12–0.16 of zoom.

**Why:** CI's level-3 ratchets failed on different strokes each run until this was seen.

**How to apply:** size any timing slack in frames of the run's own browser, not ms; don't hold a CI run to a ratchet written on the Mac. Whether Chromium's starvation is the three browsers in parallel on 3 CPUs is unverified. See [[ci-step-pipefail]].
