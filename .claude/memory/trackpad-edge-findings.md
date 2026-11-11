---
name: trackpad-edge-findings
description: "What the owner's real trackpad streams (Chrome, Firefox on macOS) showed about momentum, slow drags and rebound — the non-obvious facts behind WheelPan's rules"
metadata:
  node_type: memory
  type: project
  originSessionId: a7f3b882-e6ff-4486-a48c-c78deacb57b8
  modified: 2026-11-10T09:54:45.895Z
---

From the owner's MacBook trackpad, 2026-11-10 (Chrome and Firefox 159 on macOS, fixtures in web/test/trackpad-edge.json):

- Events arrive every ~8 ms in both browsers, pixel mode; momentum after a lift is a smooth geometric decay, then a tail of 1–2 pt deltas at 15–70 ms gaps that can last 0.5–2 s.
- Slow drags move 1–8 pt per event and slow down in runs that look like momentum by shape; momentum after a push starts at 10+ pt. A floor of 4 made the stretch collapse under the finger.
- After momentum bounced, the owner often starts a new slow drag the same way before the stream pauses; a "new push" must be a rise over the momentum's lowest delta, not over its hand-off delta (else the drag is ignored: "did nothing").
- A cap on how far the stretch winds up (⅓ window) read as a dead wall on a narrow window.
- "Spring back too slow": a critically damped spring eases in; Chromium's Mac rubber band, (x0 + 0.31·v·t)·e^(−12.5·t), sets off at once.
- Dev pages on localhost:58565 post their flight recording to build/flight/ every 5 s; read those instead of asking the owner to paste console snippets (they found that a "weird workaround").

**Why:** these took several rounds with the owner to find; they explain WheelPan's constants.
**How to apply:** when wheel/trackpad feel is reported off, read build/flight/<browser> <id>.json first; a page reload starts a new id. Related: [[native-feel-reference-testing]].
