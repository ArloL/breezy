import AppKit
import BreezyKit

/// -BreezyReplay <stroke.json> -BreezyReplayOut <recording.json>: hands a stroke the reference app recorded
/// (Reference/FrameWriter.swift) to the board's window, as the owner's fingers made it, in a view of the reference's
/// size, keeps the recording once the view rests and quits; exit 2 if it never rests.
@MainActor enum Replay {
  struct Stroke: Decodable {
    let raw: [[String]]
    /// The reference's window frame when recorded, as `RawReplay.cgFrame` gives it.
    let window: [Double]
    /// The reference's zoom and camera as the stroke began.
    let start: [Double]
    let context: [String: String]?
  }

  /// The reference app's --zoom window and its view, inside its scrollers, and its board's side.
  static let stage = NSSize(width: 1512, height: 949)
  static let referenceView = NSSize(width: 1495, height: 932), referenceBoard = 40032.0

  /// Puts the view where the stroke began: at its zoom, as far from the board's centre as the reference's was from its
  /// board's, or from its top left for a stroke at the corner.
  static func start(_ s: Stroke, _ wc: BoardWindowController) {
    let sv = wc.scrollView, clip = sv.contentView
    guard let doc = sv.documentView else { return }
    let z = s.start[0], corner = s.context?["name"] == "pinch-corner"
    let refAt = { (side: Double, view: Double) in corner ? 0 : side / 2 - view / z / 2 }
    let dx = s.start[1] - refAt(referenceBoard, referenceView.width), dy = s.start[2] - refAt(referenceBoard, referenceView.height)
    sv.magnification = z
    let b = doc.bounds, view = clip.frame.size
    let at = corner ? NSPoint(x: b.minX + dx, y: b.minY + dy) : NSPoint(x: b.midX - view.width / z / 2 + dx, y: b.midY - view.height / z / 2 + dy)
    clip.scroll(to: clip.convert(at, from: doc))
    sv.reflectScrolledClipView(clip)
  }

  /// Hands `s`'s events to the window, each to the recording as well, which they skip.
  static func play(_ s: Stroke, _ wc: BoardWindowController, done: @escaping @MainActor (Int) -> Void) {
    guard let window = wc.window else { return done(0) }
    RawReplay.play(s.raw, recorded: s.window, into: window, observe: { wc.scrollView.frames?.observe($0) }, done: done)
  }

  static func run(_ path: String, out: String, _ wc: BoardWindowController) {
    guard let data = FileManager.default.contents(atPath: path), let s = try? JSONDecoder().decode(Stroke.self, from: data) else {
      print("can’t read \(path)")
      exit(1)
    }
    Timer.scheduledTimer(withTimeInterval: 120, repeats: false) { _ in exit(2) }
    wc.window?.setContentSize(stage)
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
      start(s, wc)
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
        play(s, wc) { n in
          print("handed \(n) of \(s.raw.count)")
          rested(wc.canvas.core.flight, within: 10) { rested in
            if !rested { print("never rested") }
            do {
              try JSONEncoder().encode(wc.canvas.core.flight.recording()).write(to: URL(fileURLWithPath: out))
              print(out)
              exit(0)
            } catch {
              print("can’t write \(out): \(error)")
              exit(1)
            }
          }
        }
      }
    }
  }

  /// Calls `then(true)` once the recording's newest frame is a second old, as the view rests after AppKit's spring, or
  /// `then(false)` if it has not within `seconds`, while the ring still holds the gesture: a full ring keeps as many
  /// frames however many come, and its count read a view resizing every 125 ms as rested.
  static func rested(_ flight: Flight, within seconds: Double, then: @escaping @MainActor (Bool) -> Void) {
    let deadline = ProcessInfo.processInfo.systemUptime + seconds
    func look() {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
        MainActor.assumeIsolated {
          let now = ProcessInfo.processInfo.systemUptime
          let newest = flight.recording().frames?.rows.last?[0] ?? nil
          if newest.map({ now * 1000 - $0 >= 1000 }) ?? true { return then(true) }
          if now > deadline { return then(false) }
          look()
        }
      }
    }
    look()
  }
}
