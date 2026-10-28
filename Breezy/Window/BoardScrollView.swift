import AppKit
import BreezyKit

/// ⌘-scroll zooms around the pointer; pinch is the scroll view's own. Zoom commands spring, and a
/// scroll or pinch catches the spring where it is.
final class BoardScrollView: NSScrollView {
  private var spring: (value: Double, v: Double, to: Double, centre: NSPoint, last: CFTimeInterval)?
  private var link: CADisplayLink?
  /// A pan the app makes, each axis on the camera's spring, as the web app's camera pans.
  private var pan: (x: Double, vx: Double, y: Double, vy: Double, to: NSPoint, last: CFTimeInterval, link: CADisplayLink)?

  override func scrollWheel(with event: NSEvent) {
    stopSpring()
    stopPan()
    guard event.modifierFlags.contains(.command), let doc = documentView else { return super.scrollWheel(with: event) }
    let p = doc.convert(event.locationInWindow, from: nil)
    let step = event.hasPreciseScrollingDeltas ? 0.01 : 0.1
    setMagnification(magnification * exp(event.scrollingDeltaY * step), centeredAt: p)
  }

  override func magnify(with event: NSEvent) {
    stopSpring()
    stopPan()
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

  /// Springs the visible area's origin, in the document's points, to `origin`; a pan under way turns towards it.
  func springScroll(to origin: NSPoint) {
    guard !Spring.reduced else {
      stopPan()
      contentView.scroll(to: origin)
      return reflectScrolledClipView(contentView)
    }
    let at = contentView.bounds.origin
    let link = pan?.link ?? displayLink(target: self, selector: #selector(panTick(_:)))
    if pan == nil { link.add(to: .main, forMode: .common) }
    pan = (Double(at.x), pan?.vx ?? 0, Double(at.y), pan?.vy ?? 0, origin, CACurrentMediaTime(), link)
  }

  private func stopPan() {
    pan?.link.invalidate()
    pan = nil
  }

  @objc private func panTick(_ link: CADisplayLink) {
    guard var p = pan else { return stopPan() }
    let dt = min(0.064, max(0, link.timestamp - p.last))
    p.last = link.timestamp
    Spring.camera.step(&p.x, &p.vx, to: p.to.x, dt: dt)
    Spring.camera.step(&p.y, &p.vy, to: p.to.y, dt: dt)
    let done = abs(p.x - p.to.x) < 0.1 && abs(p.y - p.to.y) < 0.1 && abs(p.vx) < 1 && abs(p.vy) < 1
    contentView.scroll(to: done ? p.to : NSPoint(x: p.x, y: p.y))
    reflectScrolledClipView(contentView)
    if done { stopPan() } else { pan = p }
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
