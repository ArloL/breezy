import CoreGraphics

/// One stroke: each scroll event `[t, dx, dy, phase, momentumPhase]` and the clip's origin each frame `[t, x, y]`,
/// in ms from the first event.
struct Stroke: Codable, Equatable {
  var name: String
  var stage: [Double]
  var start: [Double]
  var events: [[Double]]
  var frames: [[Double]]
}

/// Collects a stroke from its first event until the board has rested: `restAfter` ms without an event and the origin
/// still for 100 ms. Times come in seconds, on `CACurrentMediaTime`'s clock.
struct StrokeRecorder {
  let name: String
  let stage: CGSize
  let start: CGPoint
  let restAfter: Double
  private var t0: Double?
  private var lastEvent = 0.0
  private var still: (since: Double, at: CGPoint)?
  private var events: [[Double]] = []
  private var frames: [[Double]] = []

  init(name: String, stage: CGSize, start: CGPoint, restAfter: Double = 1500) {
    self.name = name
    self.stage = stage
    self.start = start
    self.restAfter = restAfter
  }

  /// A gesture beginning once the board has been still for 250 ms starts a new stroke, and gives the one it ends; one
  /// beginning while the board still moves, as a push into a bounce, stays in it.
  @discardableResult
  mutating func event(t: Double, dx: Double, dy: Double, phase: UInt, momentum: UInt) -> Stroke? {
    var ended: Stroke?
    if let t0, phase == 1 || phase == 32, let s = still, ms(t, t0) - s.since >= 250 {
      ended = stroke
      self.t0 = nil
      still = nil
      events = []
      frames = []
    }
    let t0 = self.t0 ?? t
    self.t0 = t0
    lastEvent = ms(t, t0)
    events.append([lastEvent, dx, dy, Double(phase), Double(momentum)])
    return ended
  }

  private var stroke: Stroke {
    Stroke(name: name, stage: [stage.width, stage.height], start: [start.x, start.y], events: events, frames: frames)
  }

  mutating func frame(t: Double, origin: CGPoint) -> Stroke? {
    guard let t0 else { return nil }
    let now = ms(t, t0)
    frames.append([now, origin.x, origin.y])
    if let s = still, abs(s.at.x - origin.x) <= 0.01, abs(s.at.y - origin.y) <= 0.01 {} else { still = (now, origin) }
    guard now - lastEvent >= restAfter, now - still!.since >= 100 else { return nil }
    return stroke
  }

  private func ms(_ t: Double, _ t0: Double) -> Double { ((t - t0) * 1e4).rounded() / 10 }
}
