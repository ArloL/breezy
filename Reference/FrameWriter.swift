import Foundation

/// One stroke of the reference app's `--zoom` mode, as the Mac app's recording keeps frames
/// (docs/superpowers/specs/2026-11-11-breezy-native-reference-2-design.md): a frame track with the fields
/// scripts/frames/fields.json lists, and each event that made it as `CGEvent` data, to replay into the reference and
/// into Breezy. Times in ms from the stroke's first event; it ends once nothing touches, 1.5 s after its last event,
/// with the view still for 100 ms.
struct FrameWriter {
  static let fields = [
    "t", "zoom", "camX", "camY", "viewW", "viewH", "boardX", "boardY", "boardW", "boardH", "px", "py", "f1x", "f1y", "f2x", "f2y",
    "wheelDX", "wheelDY", "wheelPhase", "momentumPhase", "magnify", "gesture", "knobH", "knobV", "knobHAt", "knobVAt", "grey", "fading",
  ]

  struct Shown: Equatable {
    var zoom: Double
    var cam: CGPoint
    var view: CGSize
    var board: CGRect
    var knobH: Double?
    var knobV: Double?
    /// Each knob's place along its scroller, 0 to 1.
    var knobHAt: Double? = nil
    var knobVAt: Double? = nil
  }

  enum Phase { case began, changed, ended }

  struct Track: Codable, Equatable {
    var fields: [String]
    var rows: [[Double?]]
  }

  /// A recording as web/flight.ts's, with no entries, and `raw`: each event as `[t, base64 CGEvent data]`.
  struct Stroke: Codable {
    var schema = 1
    var origin = 0.0
    var dropped = 0
    var context: [String: String]
    var entries: [[String]] = []
    var frames: Track
    var raw: [[String]]
    /// Where the view was just before the stroke's first event, `[zoom, camX, camY]`, for a replay to start there.
    var start: [Double]
    /// The window's frame on screen when recorded, `[x, y, w, h]` in global display points, for a replay to move the
    /// events' locations to wherever its window is.
    var window: [Double]
  }

  let name: String
  var window: CGRect = .zero
  private var t0: Double?
  private var rows: [[Double?]] = []
  private var raw: [[String]] = []
  private var wheel = (dx: 0.0, dy: 0.0, phase: 0.0, momentum: 0.0)
  private var magnify = 0.0, gesture = 0.0
  private var touching = false, coasting = false
  private var lastEvent = 0.0
  private var pointer = CGPoint.zero
  private var still: (since: Double, shown: Shown)?
  /// The last frame before the first event.
  private var before: Shown?

  init(name: String) { self.name = name }

  private func ms(_ t: Double) -> Double { ((t - (t0 ?? t)) * 1e4).rounded() / 10 }

  private mutating func began(_ t: Double, _ at: CGPoint, _ data: Data?) {
    if t0 == nil { t0 = t }
    lastEvent = ms(t)
    pointer = at
    if let data { raw.append([String(lastEvent), data.base64EncodedString()]) }
  }

  /// Any other event a gesture is made of, kept to replay.
  mutating func other(t: Double, at: CGPoint, raw data: Data?) { began(t, at, data) }

  mutating func magnify(t: Double, by m: Double, phase: Phase, at: CGPoint, raw data: Data?) {
    began(t, at, data)
    magnify += m
    gesture = phase == .began ? 1 : phase == .changed ? 2 : 3
    touching = phase != .ended
  }

  /// A scroll, its phase and momentum phase as NSEvent numbers them.
  mutating func scroll(t: Double, dx: Double, dy: Double, phase: UInt, momentum: UInt, at: CGPoint, raw data: Data?) {
    began(t, at, data)
    wheel.dx += dx
    wheel.dy += dy
    wheel.phase = Double(phase)
    wheel.momentum = Double(momentum)
    if phase != 0 { touching = phase != 8 && phase != 16 }
    if momentum != 0 { coasting = momentum != 8 }
  }

  /// Adds a frame; gives the stroke once it has ended.
  mutating func frame(t: Double, shown s: Shown) -> Stroke? {
    guard t0 != nil else {
      before = s
      return nil
    }
    let now = ms(t)
    let b = s.board
    rows.append([now, s.zoom, s.cam.x, s.cam.y, s.view.width, s.view.height, b.minX, b.minY, b.width, b.height, pointer.x, pointer.y,
                 nil, nil, nil, nil, wheel.dx, wheel.dy, wheel.phase, wheel.momentum, magnify, gesture, s.knobH, s.knobV, s.knobHAt, s.knobVAt, 0, 0])
    wheel = (0, 0, wheel.phase == 8 || wheel.phase == 16 ? 0 : wheel.phase, wheel.momentum == 8 ? 0 : wheel.momentum)
    magnify = 0
    gesture = gesture == 1 ? 2 : gesture == 3 ? 0 : gesture
    if still?.shown != s { still = (now, s) }
    guard !touching, !coasting, now - lastEvent >= 1500, now - still!.since >= 100 else { return nil }
    let w = window, b0 = before ?? s
    return Stroke(context: ["app": "reference", "name": name], frames: Track(fields: Self.fields, rows: rows), raw: raw,
                  start: [b0.zoom, b0.cam.x, b0.cam.y], window: [w.minX, w.minY, w.width, w.height])
  }
}
