import AppKit
import BreezyKit

extension Point {
  init(_ p: NSPoint) { self.init(x: Double(p.x), y: Double(p.y)) }
}

extension CanvasView {
  override func mouseMoved(with event: NSEvent) {
    core.hover(at: Point(world(event)))
    onPointer?(world(event))
  }

  override func mouseExited(with event: NSEvent) {
    core.hover(at: nil)
    onPointer?(nil)
  }

  override func mouseDown(with event: NSEvent) {
    endEditing()
    window?.makeFirstResponder(self)
    let m = event.modifierFlags
    core.press(at: Point(world(event)), clickCount: event.clickCount, shift: m.contains(.shift), option: m.contains(.option))
  }

  override func mouseDragged(with event: NSEvent) {
    onPointer?(world(event))
    guard drag != nil else { return }
    dragPoint = event.locationInWindow
    dragged()
    edgeScroll()
  }

  /// Carries the drag to where the pointer is; the board may have scrolled under it.
  private func dragged() {
    guard drag != nil, let w = dragPoint else { return }
    core.dragged(to: Point(world(at: w)))
    guard let r = core.marquee else { return }
    marquee.frame = doc(r)
    if marquee.isHidden {
      // coloured as it appears: the appearance callback does not come at launch
      tintMarquee()
      marquee.isHidden = false
    }
  }

  /// Near or past the edge of the visible area a drag scrolls the board, slowly at first and
  /// faster the longer it stays there, as in Freeform.
  private func edgeScroll() {
    // a press that has not become a drag yet stays put
    guard let d = drag, d.moved || d.kind == .marquee, edgeDirection() != nil else { return stopEdgeScroll() }
    guard edgeScrolling == nil else { return }
    let link = displayLink(target: self, selector: #selector(edgeTick(_:)))
    link.add(to: .main, forMode: .common)
    let now = CACurrentMediaTime()
    edgeScrolling = (link, now, now)
  }

  func stopEdgeScroll() {
    edgeScrolling?.link.invalidate()
    edgeScrolling = nil
  }

  /// Which way the board scrolls for a pointer within `EdgeScroll.zone` points of an edge.
  private func edgeDirection() -> CGVector? {
    guard let clip = enclosingScrollView?.contentView, let p = dragPoint else { return nil }
    let a = clip.convert(clip.bounds, to: nil)
    let zone = CGFloat(EdgeScroll.zone)
    func dir(_ v: CGFloat, _ lo: CGFloat, _ hi: CGFloat) -> CGFloat { v - lo <= zone ? -1 : hi - v <= zone ? 1 : 0 }
    // the window's y grows upwards, the board's downwards
    let v = CGVector(dx: dir(p.x, a.minX, a.maxX), dy: -dir(p.y, a.minY, a.maxY))
    return v == .zero ? nil : v
  }

  @objc private func edgeTick(_ link: CADisplayLink) {
    guard var e = edgeScrolling, let dir = edgeDirection(), let sv = enclosingScrollView else { return stopEdgeScroll() }
    let ms = min(64, max(0, (link.timestamp - e.last) * 1000))
    e.last = link.timestamp
    edgeScrolling = e
    let d = CGFloat(EdgeScroll.speed(heldMs: (link.timestamp - e.since) * 1000) * ms) / zoom
    let clip = sv.contentView
    var b = clip.bounds
    b.origin.x += dir.dx * d
    b.origin.y += dir.dy * d
    clip.scroll(to: clip.constrainBoundsRect(b).origin)
    sv.reflectScrolledClipView(clip)
    dragged()
  }

  override func mouseUp(with event: NSEvent) {
    guard drag != nil else { return }
    dragPoint = nil
    stopEdgeScroll()
    marquee.isHidden = true
    core.release()
    placeLanes()
    layoutCards()
  }

  /// The folded corner, which turns the card over.
  func hitsFold(_ c: Card, _ p: NSPoint) -> Bool { core.hitsFold(c, Point(p)) }
}
