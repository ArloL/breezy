import AppKit
import BreezyKit

/// ⌘-scroll zooms around the pointer; pinch is the scroll view's own. Zoom commands spring, and a
/// scroll or pinch catches the spring where it is.
final class BoardScrollView: NSScrollView {
  private var spring: (value: Double, v: Double, to: Double, centre: NSPoint, last: CFTimeInterval)?
  private var link: CADisplayLink?

  override func scrollWheel(with event: NSEvent) {
    stopSpring()
    guard event.modifierFlags.contains(.command), let doc = documentView else { return super.scrollWheel(with: event) }
    let p = doc.convert(event.locationInWindow, from: nil)
    let step = event.hasPreciseScrollingDeltas ? 0.01 : 0.1
    setMagnification(magnification * exp(event.scrollingDeltaY * step), centeredAt: p)
  }

  override func magnify(with event: NSEvent) {
    stopSpring()
    super.magnify(with: event)
  }

  override func smartMagnify(with event: NSEvent) {
    stopSpring()
    super.smartMagnify(with: event)
  }

  /// Springs the zoom to `zoom` keeping document point `centre` in place, in log space so zooming
  /// in and out feel alike.
  func springMagnification(to zoom: CGFloat, centeredAt centre: NSPoint) {
    let z = min(max(zoom, minMagnification), maxMagnification)
    guard !Spring.reduced else {
      stopSpring()
      return setMagnification(z, centeredAt: centre)
    }
    spring = (log(magnification), spring?.v ?? 0, log(z), centre, CACurrentMediaTime())
    guard link == nil else { return }
    let l = displayLink(target: self, selector: #selector(tick(_:)))
    l.add(to: .main, forMode: .common)
    link = l
  }

  private func stopSpring() {
    link?.invalidate()
    link = nil
    spring = nil
  }

  @objc private func tick(_ link: CADisplayLink) {
    guard var s = spring else { return stopSpring() }
    Spring.camera.step(&s.value, &s.v, to: s.to, dt: min(0.064, max(0, link.timestamp - s.last)))
    s.last = link.timestamp
    let done = abs(s.value - s.to) < 1e-5 && abs(s.v) < 1e-4
    setMagnification(exp(done ? s.to : s.value), centeredAt: s.centre)
    if done { stopSpring() } else { spring = s }
  }
}
