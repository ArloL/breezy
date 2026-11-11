import AppKit
import BreezyKit

/// Keeps a frame in the board's recording on every display frame while the view moves, and one once it rests: what
/// showed, what moved it and what drew it, as scripts/frames/fields.json lists them
/// (docs/superpowers/specs/2026-11-11-breezy-native-reference-2-design.md). Its display link runs only while the view
/// moves or input comes, and stops after half a second still.
@MainActor final class FrameRecorder: NSObject {
  private weak var scrollView: NSScrollView?
  private let flight: Flight
  /// How far, in view pt, what is drawn reaches short of the view: grey where no board is drawn. Main's grid fills the
  /// whole view, so 0 unless the window says otherwise.
  var drawnShort: () -> Double = { 0 }
  private var link: CADisplayLink?
  private var lastShown: [Double?]?
  private var stillFrames = 0
  private var wheel = (dx: 0.0, dy: 0.0, phase: 0.0, momentum: 0.0)
  private var magnify = 0.0, gesture = 0.0
  /// Where the last event was, in the window, while its gesture goes on.
  private var pointer: NSPoint?
  private var monitor: Any?

  init(scrollView: NSScrollView, flight: Flight) {
    self.scrollView = scrollView
    self.flight = flight
    super.init()
    let clip = scrollView.contentView
    clip.postsBoundsChangedNotifications = true
    clip.postsFrameChangedNotifications = true
    for name in [NSView.boundsDidChangeNotification, NSView.frameDidChangeNotification] {
      NotificationCenter.default.addObserver(self, selector: #selector(moved), name: name, object: clip)
    }
    // the window's events, not the scroll view's overrides: NSScrollView tracks a pinch past them, and in the reference
    // app two of a stroke's three pinch ends never reached magnify(with:)
    monitor = NSEvent.addLocalMonitorForEvents(matching: [.magnify, .smartMagnify, .scrollWheel]) { [weak self] e in
      MainActor.assumeIsolated {
        guard let self, e.window != nil, e.window === self.scrollView?.window else { return }
        self.observe(e)
      }
      return e
    }
  }

  /// Keeps `e`'s input for the next frame: what the window's monitor sees, and what a replay hands the window, which
  /// skips monitors.
  func observe(_ e: NSEvent) {
    switch e.type {
    case .magnify: magnified(e)
    case .smartMagnify: smartMagnified(e)
    case .scrollWheel: scrolled(e)
    default: break
    }
  }

  isolated deinit {
    if let monitor { NSEvent.removeMonitor(monitor) }
  }

  private func scrolled(_ e: NSEvent) {
    wheel.dx += e.scrollingDeltaX
    wheel.dy += e.scrollingDeltaY
    wheel.phase = Double(e.phase.rawValue)
    wheel.momentum = Double(e.momentumPhase.rawValue)
    pointer = e.locationInWindow
    wake()
  }

  private func magnified(_ e: NSEvent) {
    magnify += e.magnification
    gesture = e.phase.contains(.began) ? 1 : e.phase.contains(.ended) || e.phase.contains(.cancelled) ? 3 : 2
    pointer = e.locationInWindow
    wake()
  }

  private func smartMagnified(_ e: NSEvent) {
    pointer = e.locationInWindow
    wake()
  }

  @objc private func moved() { wake() }

  private func wake() {
    stillFrames = 0
    guard link == nil, let sv = scrollView else { return }
    let l = sv.displayLink(target: self, selector: #selector(tick))
    l.add(to: .main, forMode: .common)
    link = l
  }

  @objc private func tick() {
    guard let shown = shown() else { return stop() }
    let input = [wheel.dx, wheel.dy, wheel.phase, wheel.momentum, magnify, gesture]
    let moving = shown != lastShown || input.contains { $0 != 0 }
    if moving || stillFrames == 0 {
      flight.frame(Array(shown.prefix(11)) + [nil, nil, nil, nil] + input.map { Optional($0) } + Array(shown.suffix(5)))
      if !moving { stillFrames = 1 }
    } else {
      stillFrames += 1
      if stillFrames > 30 { stop() }
    }
    if moving { stillFrames = 0 }
    lastShown = shown
    wheel = (0, 0, wheel.phase == 8 || wheel.phase == 16 ? 0 : wheel.phase, wheel.momentum == 3 ? 0 : wheel.momentum)
    magnify = 0
    if gesture == 3 { gesture = 0; pointer = nil } else if gesture == 1 { gesture = 2 }
  }

  private func stop() {
    link?.invalidate()
    link = nil
  }

  /// The camera, the view, the board and the pointer, then the knobs' sizes and places and what is drawn short: the
  /// fields but `t`, the fingers and the input, in order.
  private func shown() -> [Double?]? {
    guard let sv = scrollView, let doc = sv.documentView, let window = sv.window else { return nil }
    let clip = sv.contentView, z = sv.magnification
    let cam = doc.convert(clip.bounds.origin, from: clip)
    let at = pointer ?? window.mouseLocationOutsideOfEventStream
    let q = clip.convert(at, from: nil)
    let px = (q.x - clip.bounds.minX) * z, py = (clip.isFlipped ? q.y - clip.bounds.minY : clip.bounds.maxY - q.y) * z
    let b = doc.bounds
    let geometry: [Double?] = [z, cam.x, cam.y, clip.frame.width, clip.frame.height, b.minX, b.minY, b.width, b.height, px, py]
    let h = sv.horizontalScroller, v = sv.verticalScroller
    return geometry + [h.map { Double($0.knobProportion) }, v.map { Double($0.knobProportion) }, h.map { $0.doubleValue }, v.map { $0.doubleValue }, drawnShort()]
  }
}
