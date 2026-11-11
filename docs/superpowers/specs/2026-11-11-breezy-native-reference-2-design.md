# Breezy native reference, phase 2: what looks off, on every platform

Phase 1 (`2026-11-10-breezy-native-reference-design.md`) replaced judging by feel with measuring against AppKit, for one thing: the trackpad at the board's edge in Firefox. It found the band 4–8 times too soft. Everything else that looks off still reaches the owner first, by hand, on every platform:

- **The Mac app, 2026-11-11,** `mac-bounded-board` at `7e0248e`, pinching out past 25 %, in the owner's words: "the background looks off; the scrollbars are weird; it jumps back weirdly; the background flickers". A screen recording of it (`build/native-reference-2/owner-pinch-handcheck-2026-11-11.mkv`, 60 fps, the pinches at 11.5–20.5 s) shows:
  - a band of plain grey, 40–70 pt wide, opening along the board's top and left from about 30 % down to 23 %, and vanishing as the pinch ends (`grey-band-frames.png`);
  - the zoom overshooting to 23 % and springing back to 25 %;
  - the scrollers' length changing around the pinch.

  Main's build has no board edge, so it can't show any of this. The only evidence was that recording, tracked by hand, because the build recorded nothing that could be read. What "the scrollbars are weird" meant beyond their length changing isn't known; step 1 begins by asking the owner, with the recording in front of them.
- **The iPhone:** the dot grid flickered during a pinch (`1dd075e`); cards painted over the top bar during a pinch (`11a483a`); the finger left after a pinch didn't pan (`0a4ebe9`); a hold that crept 6 pt let iOS scroll the board 267 pt (`156f154`).
- **The Mac app, October:** the board cross-faded as a card was added (`5c41379`); a card's text moved when its editor opened (`5d78bca`).

Recordings (`web/flight.ts`, `BreezyKit/Sources/BreezyKit/Flight.swift`) note each gesture but none of its frames (`5a688b7`), and no level owns visual glitches (B8 in `TESTING.md`).

Phase 2 uses phase 1's method on every platform and every gesture. It records frames by default and checks them against rules, each rule proven on the native reference first.

## Goals

- **Frames recorded by default, in every build.** The web app (every browser, the Home Screen app, Chrome and Firefox on Android) and the Mac app keep the last ~30 s of frames in their recording. On each frame: its time; the input, meaning finger points, trackpad deltas with their phases, and magnification; the camera's zoom and origin; the visible rect; the board's rect; and enough of what is drawn for the rules below. That means scroller knobs on the Mac and what covers the bars on the iPhone. It is in the same format on both cores, as their recordings already share.
- **"That looked off."** One command on every platform saves the last seconds of frames, with the recording's context, to `server/diag.php`, where `scripts/diag.ts` reads them. The web app has Report a Problem; this extends it, or adds a quicker entry beside it, and the Mac app gains the same. The partner's Android has it too.
- **Rules over frames,** each a pure function over the shared format, with one checker for both cores. The first set:
  - **Follow:** the board point under each finger, or under a pinch's centre, stays under it, while the gesture is in contact and through its hand-off.
  - **Coverage:** nothing past the board's edge shows, unless a pan pulled it there. The chrome (bars, find, the keyboard's bar) is never covered by the board.
  - **Continuity:** no frame jumps further than the input moved it. At a hand-off from a gesture to a spring or a coast, the speed carries over.
  - **No flicker:** nothing visible disappears, or changes opacity, colour or position, for one to three frames and comes back. The background doesn't change mid-gesture.
  - **Scrollers (the Mac):** the knobs' size changes only with zoom, never as the board grows during a gesture.
  - **The reference's curve:** a stroke's camera stays within the spread of the owner's own repeats of AppKit's or UIKit's curve, as phase 1 compares.
- **A native reference on each platform,** recording the same format:
  - **The Mac:** phase 1's app (`Reference/`), extended with magnification, AppKit's own limits and its band past them.
  - **The iPhone:** the UIKit twin phase 1 parked: one UIScrollView set up as Freeform's canvas.
  - **Android, Windows and every other platform:** the iPhone's UIKit reference, not their own native feel (the owner's decision, below).
- **Replay on each platform,** the owner's recorded gestures posted as the OS's own input, into the reference and into Breezy:
  - **The Mac:** `CGEvent`s, with scroll phases (phase 1's `scripts/replay-helper.swift`) and pinches.
  - **The iOS Simulator:** `scripts/sim-finger.m`, which moves several fingers at once (`aee7e0c`).
  - **The Android emulator:** its own input.
- **Pixels where only pixels show it.** Drawing that lags its geometry, as either cause of the Mac's grey band could, and flicker: a capture at the display's rate, read by a script, on boards whose elements have colours the script can tell apart. On the Mac this is ScreenCaptureKit, on the Simulator its video, on Android `screenrecord`.

## How it's judged

The owner: "start with the things I tell you look off — if the idea can't pinpoint those issues it's useless."

1. **Today's Mac issues, each pinpointed.** On `7e0248e`, the owner's pinch past 25 %, replayed, fails a rule for each of the four things reported: the grey band, the scrollers, the jump back, the flicker. Each failure names the frames. The same stroke into AppKit's reference passes the same rules. A thing reported that no rule fails on means the rules are wrong; this phase isn't done until it is fixed.
2. **The past ones, planted.** Each escape above goes back in as a plant (`TESTING.md`, "Adding a plant"), and its platform's rules fail on it: the iPhone's grid flicker, the cross-fade, the text that moved, the finger left after a pinch, the creeping hold, the cards over the bars. That makes B8 the first class owned at any level.
3. **Every later report.** A "That looked off" from the owner or the partner is first made to fail a rule, from its saved frames, before anything is fixed.

## Order

1. **The Mac's pinch.** Frames in the Mac app's recording, the reference app's pinch, pinch replay, the rules that pinpoint today's four, and "That looked off" in the Mac app. The bounded board's fix follows, judged by those rules.
2. **The web app's frames and "That looked off",** on every browser and the Home Screen app.
3. **The iPhone,** with the UIKit twin and its plants, then **Android** and other platforms, held to the same UIKit reference.

## Non-goals

- **Fixing what the rules find.** Each fix is its own PR with its own test, as `AGENTS.md` asks. The bounded board's fix follows step 1 directly.
- Frame times, key-to-glyph and launch, which `scripts/bench.sh`, `scripts/feel.ts` and `scripts/launch.ts` measure.
- Taste: colours, sizes and whether a design is pretty.

## Anti-goals

- **Finicky:** an app that behaves like iOS under ideal conditions and erratically otherwise. Consistency comes before peak feel.
- **A limit assumed, not proven.** No interaction is dropped or simplified on a platform without the proof described under "Decided by the owner".
- **A rule that passes while it looks off.** If the owner sees it and every rule passes, the rules are wrong and get fixed first.
- **A rule the reference fails, unless the owner says the reference is wrong there.** Then the rule holds the owner's written deviation instead.
- **A replay that doesn't reproduce its own recording in the reference.** Nothing is compared until it does (phase 1's rule).
- **Card text in a recording.** `web/flight.ts` keeps only digests of words, and frames keep none.
- **A recording that slows the app.** Launch is measured nightly against the same build not recording (`TESTING.md`), and frames are held to that.

## Constraints

- Never `breezy.k5d.de` in a copy of the owner's Firefox profile; test against localhost (`AGENTS.md`).
- Every wait is bounded; test files exit on their own; CI jobs carry `timeout-minutes`.
- Small PRs off main, merged only when every job is green. The gate stays within ten minutes, so what needs a device runs nightly or as a probe.
- Posting `CGEvent`s and capturing the screen need Accessibility and Screen Recording, granted to Visual Studio Code on the owner's Mac.
- The saved frames travel as recordings do today: to `server/diag.php` under the space's token, read with an invite link that is never stored.

## Decided by the owner

- This is phase 2 of native reference: a rule is trusted once the reference passes it.
- It starts from what the owner reports looks off, and it is judged by whether it pinpoints those reports.
- "That looked off" is on every platform, and every build keeps frames.
- **iOS is the north star, not a floor.** The owner ranks the platforms' own zooming, panning and rubber banding as iOS best, macOS second, and all others third. Breezy aims to feel as good as iOS on every platform, and better wherever iOS's own limits feel unnatural: "iOS is the bar as far as I can tell — but maybe the bar can be higher … it's the north star for now. Let's see how far we get. If we can't get everything I want, that's fine." Where the owner finds the reference itself unnatural, their feel wins.
- **Other platforms' native feel is overridden.** On Android, Windows and the rest, the platform's own feel gives way "to a fairly large degree": "I don't like the native feel" of Android.
- **The Mac's trackpad is a touch device too.** The owner: "as long as we can make it consistent with the platform of macOS and the application not feeling un-Mac … and maybe even feeling better than AppKit, I am all for it to ignore its behavior — the bar is better." AppKit's reference still shows what a Mac user expects, and what Breezy must not break. Where the owner finds a curve better than AppKit's, it replaces AppKit's as the one the rules hold, as any deviation does.
- **Always natural and consistent, rather than iOS-like only at best.** The owner: "I don't want the app to be an unstable finicky thing that under ideal conditions behaves like iOS. It should always behave as naturally as possible and behave like real world objects (e.g. rubber banding) and then fall back to a consistent state of interactions where the gold standard is not achievable due to platform limitations … I accept that; but I want it proven that it's unattainable rather than assumed." So:
  - **The rules hold everywhere, not only in ideal conditions.** They hold on a slow device, under load, with input merged or late, and with gestures combined. A rule passing only on a fast Mac fails.
  - **Each platform has a fallback where the north star is out of reach.** The fallback is a smaller set of interactions that behaves consistently, and the same rules hold it.
  - **A limit is proven before anything falls back.** Each limit is named per device and browser. The proof is a recording that shows the platform withholding what the gesture needs: events never sent, phases missing, a pan the browser won't give up. A spike that tried the alternatives goes with it. Each proven limit gets a row, with its evidence, in `docs/platform-expectations.md` or a page beside it. A limit that is only assumed doesn't count.
- **The band stays; how it feels is what's wrong.** In the owner's words: "The rubber banding is not the problem … it feels unnatural." Pinching past a zoom limit overshoots and springs back, as AppKit's does. Natural means as the platform's reference does it. So the band's curve is held to the reference's, and anything the reference doesn't show during it, such as grey past the edge, a flicker or a jump, fails the rules.

## My calls

- About 30 s of frames, kept apart from the recording's ring of entries, so that a long session's gestures don't push out its decisions.
- One checker, in TypeScript under `scripts/`, run by Node on Linux like the other tests, reading both cores' recordings. A rule's logic lives once.
- **Where the rules run.** The checker runs in Node on every push, over frame fixtures checked into the repo: each pairs a replayed stroke's frames from Breezy with the reference's, as phase 1's fixture does. Making a fixture needs a device: the owner's Mac, where Visual Studio Code holds Accessibility and Screen Recording; the Simulator and the emulator, locally or as a probe. A fix's PR carries the fixture of its replay on the fixed build, and the pinch is replayed on CI only once a spike shows a CI Mac can post and capture.
- **What proves a plant.** `scripts/plants.ts` runs the checker over a fixture recorded from the planted build, kept beside the clean one, so a plant fails in Node every week. Re-recording a plant's fixture is a local step, named in its row.
- **A plant the Simulator can't show,** as the iPhone's grid flicker may not on the Mac's GPU, is proven once on the owner's iPhone, with "That looked off" saving its frames as the fixture, and marked as proven by hand in `TESTING.md`'s matrix, not as owned.
- **Where the owner overrides the reference,** the deviation is written beside the rule with the owner's words and the strokes that showed it. The rule is then held to the deviation, not the reference.
- Freeform stays a comparison by feel, not a reference: its curves can't be read, and the owner finds it off too.
- `mac-bounded-board` waits for step 1, whose rules become its tests, rather than merge with the grey band as a logged escape.

## Risks to settle first, each with a throwaway spike

- **A pinch posted as a `CGEvent`.** AppKit may not run its live magnification for a posted gesture. The spike records the owner's pinch with an event tap, saves each event whole (`CGEvent` data), and posts it back into the reference app; the replay must match the recorded curve. If it doesn't, the pinch is replayed into the app's own event handling (`NSEvent(cgEvent:)` sent to the window), which skips the window server; say so in the results.
- **Frames on a slow phone.** Recording every frame in Safari on the iPhone 13 mini must not cost the launch measure or a dropped frame.
- **Flicker from layer state or pixels.** Whether reading each layer's presentation values per frame finds the Mac's cross-fade plant, or only pixels do.

## Left to the builder

- The frame entry's fields and encoding, and whether frames are kept only while something moves.
- Which elements' drawn state each platform records.
- Tolerances, set from how the owner's repeats and the reference's curves vary.
- The capture tools on each platform, and the colours of test boards.
- Where the quicker "That looked off" entry sits in each app, and its shortcut.

## Spike findings

**A recorded pinch, replayed into AppKit** (2026-11-11, macOS 27, the owner's MacBook trackpad; `spike/pinch-replay`, kept unmerged). A bare `NSScrollView` (magnification 0.25–2, a 40,032 pt document) recorded each event it received as `CGEvent` data, and its magnification on every frame. The owner made three pinches out past 25 %. Each was replayed into the same window four ways:

| Route | Magnify events received | Zoom |
|---|---|---|
| Posted to the HID tap, as recorded | 92 of 94, 0, 0 | stayed at 100 % |
| Posted, window under the pointer rewritten and the cursor moved over the window | 94 of 94, 0, 0 | stayed at 100 % |
| Posted to the app's own process (`postToPid`) | 94, 72, 139 of 94, 72, 140 | stayed at 100 % |
| In the app: `NSEvent(cgEvent:)` handed to `window.sendEvent` | not seen by the window's monitor, as expected | as recorded |

In the app, the replays' lowest zoom was 0.2296, 0.2271 and 0.2239 against the recordings' 0.2296, 0.2274 and 0.2235. All three settled at 0.25, as recorded, within 1, 31 and 25 ms of the recordings' settle times. Aligned on the first frame the zoom left 100 %, and allowing one display frame of timing either way, the curves stay within 0.009, 0.011 and 0.011. Without that allowance, the largest gap is 0.05–0.075, in the first 56 ms, where a single magnify event moves the zoom 9 %.

**Verdict.** A posted pinch reaches the app as `NSEvent`s of type magnify with the recorded values and phases, but `NSScrollView` zooms by none of them, by every route tried. Pinches are therefore replayed in the app, through `NSEvent(cgEvent:)` and `window.sendEvent`: in Breezy through the Debug control port (`Breezy/Support/Control.swift`), and in the reference app through its own. Fixtures are made from Debug builds. The window server's own handling of a pinch is not covered by a replay; the owner's hand covers it. The evidence is in `build/native-reference-2/spike/`.
