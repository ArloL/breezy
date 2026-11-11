---
name: ios-native-scroll-quirks
description: What iOS WebKit does to a page that pans natively in a scroll container and zooms on top — the non-obvious behaviours found in the native-panning spike
metadata:
  type: project
---

Found 2026-11-10 on the owner's iPhone (Firefox for iOS, WebKit), each from flight + screen recordings:

- Once iOS has begun a native pan, nothing stops it: not preventDefault (touchmove no longer cancelable), not overflow: hidden. Moving the scrolled content into a non-scrolling overlay does stop it; touch listeners must then be on the document.
- iOS starts no new native pan for a finger already down (after a pinch): the page must pan that finger itself.
- iOS paints a big scrolled layer only near the window: resizing or scaling it per pinch step shows the container's background (grey) until painted. Scale with a CSS transform and lay out once at the end; draw the grid on a window-sized canvas during the pinch.
- Breezy's board touchstart preventDefault (anti-magnifier) blocks all native panning; iOS's gesture events zoom under a native pan unless ignored.
- iOS scrolls the container to keep a caret in view (caret drag, spacebar trackpad): lock scrolling while editing.
- The owner's browser on iPhone is Firefox for iOS (UA FxiOS); phone screen recording: scripts/phone-record.swift.

**Why:** each took a round with the owner on the phone. **How to apply:** read before touching native panning on iOS. Related: [[native-feel-reference-testing]].
