import AppKit

/// Replays recorded events in the app, as `NSEvent`s handed to its window: AppKit zooms by none of a pinch's events when
/// they are posted, by any route, and by these as by the owner's fingers (the spike in
/// docs/superpowers/specs/2026-11-11-breezy-native-reference-2-design.md). Shared by the reference app and Breezy.
enum RawReplay {
  /// `w`'s frame in global display points with the origin at the main display's top left, as `CGEvent` locations are.
  @MainActor static func cgFrame(_ w: NSWindow) -> CGRect {
    let top = NSScreen.screens.first?.frame.maxY ?? 0
    return CGRect(x: w.frame.minX, y: top - w.frame.maxY, width: w.frame.width, height: w.frame.height)
  }

  /// Where `e` was in `window`: a handed event has no window, and its location is on screen.
  @MainActor static func inWindow(_ e: NSEvent, of window: NSWindow) -> NSPoint {
    e.window == nil ? window.convertPoint(fromScreen: e.locationInWindow) : e.locationInWindow
  }

  /// Hands each of `raw`'s events (`[ms, base64 CGEvent data]`) to `window` at its time from now, its location moved
  /// from where the window was when recorded, `recorded` (`[x, y, w, h]` as `cgFrame` gives), to where it is; then
  /// calls `done` with how many it handed over. Events handed to a window skip the app's event monitors, so each also
  /// goes to `observe`, as a recorder's monitor would have. The cursor goes to each event's location, as AppKit zooms a
  /// pinch about the cursor: about wherever it was left, a replay ended 200 pt from where the owner's pinch had.
  @MainActor static func play(_ raw: [[String]], recorded: [Double], into window: NSWindow, observe: @escaping @MainActor (NSEvent) -> Void = { _ in },
                              done: @escaping @MainActor (Int) -> Void) {
    let now = cgFrame(window)
    let dx = now.minX - recorded[0], dy = now.minY - recorded[1]
    let events = raw.compactMap { r -> (Double, Data)? in
      guard r.count == 2, let t = Double(r[0]), let d = Data(base64Encoded: r[1]) else { return nil }
      return (t, d)
    }
    let windowNumber = Int64(window.windowNumber)
    // timed on a thread of its own, as the main queue's timers may fire late to batch, and each handed over on the main
    // thread, where AppKit takes events
    Thread.detachNewThread {
      let start = CACurrentMediaTime(), first = events.first?.0 ?? 0
      var handed = 0
      for (t, d) in events {
        let due = start + (t - first) / 1000
        while CACurrentMediaTime() < due { usleep(200) }
        guard let ev = CGEvent(withDataAllocator: nil, data: d as CFData) else { continue }
        ev.location = CGPoint(x: ev.location.x + dx, y: ev.location.y + dy)
        // as if it came now: AppKit reads a gesture's pace from its events' times
        ev.timestamp = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
        ev.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: windowNumber)
        ev.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: windowNumber)
        CGWarpMouseCursorPosition(ev.location)
        DispatchQueue.main.sync {
          MainActor.assumeIsolated {
            if let e = NSEvent(cgEvent: ev) {
              observe(e)
              window.sendEvent(e)
              handed += 1
            }
          }
        }
      }
      DispatchQueue.main.async { MainActor.assumeIsolated { done(handed) } }
    }
  }
}
