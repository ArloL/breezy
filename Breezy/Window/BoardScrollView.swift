import AppKit
import BreezyKit

/// ⌘-scroll zooms around the pointer; pinch is the scroll view's own. Zoom commands spring, and a
/// scroll or pinch catches the spring where it is. Springs hold their points in the document's own coordinates, the
/// board's, which stay put as the board grows at its left or top, where the clip view's move.
final class BoardScrollView: NSScrollView {
  private var spring: (value: Double, v: Double, to: Double, centre: NSPoint, last: CFTimeInterval)?
  private var link: CADisplayLink?
  /// A pan the app makes, each axis on the camera's spring, as the web app's camera pans.
  private var pan: (x: Double, vx: Double, y: Double, vy: Double, to: NSPoint, last: CFTimeInterval, link: CADisplayLink)?
  /// What keeps the view's frames in the board's recording.
  var frames: FrameRecorder?

  /// Whether a gesture scrolls the view, and whether one zooms it, as AppKit brackets them; the two can overlap.
  private(set) var scrolling = false
  private(set) var magnifying = false
  var live: Bool { scrolling || magnifying }
  /// Called as a gesture ends, for the board to rest once the view is still.
  var onGestureEnd: (() -> Void)?
  private var settingMagnification = 0

  override init(frame: NSRect) {
    super.init(frame: frame)
    contentView = BoardClipView()
    let nc = NotificationCenter.default
    let flags: [(Notification.Name, ReferenceWritableKeyPath<BoardScrollView, Bool>, Bool)] = [
      (Self.willStartLiveScrollNotification, \.scrolling, true), (Self.didEndLiveScrollNotification, \.scrolling, false),
      (Self.willStartLiveMagnifyNotification, \.magnifying, true), (Self.didEndLiveMagnifyNotification, \.magnifying, false),
    ]
    for (name, flag, now) in flags {
      nc.addObserver(forName: name, object: self, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated {
          guard let self else { return }
          self[keyPath: flag] = now
          if !now { self.onGestureEnd?() }
        }
      }
    }
  }

  required init?(coder: NSCoder) { fatalError() }

  /// Whether the view zooms now: a pinch under way, or a magnification being set. Only then does the clip view grow
  /// the board to what it would show; a pan, however soon after, stops at the edge.
  var zooming: Bool { magnifying || settingMagnification > 0 }

  private func zoom(_ set: () -> Void) {
    settingMagnification += 1
    defer { settingMagnification -= 1 }
    set()
  }

  // dynamic: this class is final, so Swift called the setter itself on `animator()`'s proxy, whose super call handed
  // AppKit the proxy as the scroll view and faulted; through the runtime the proxy animates it, as AppKit means
  override dynamic var magnification: CGFloat {
    get { super.magnification }
    set { zoom { super.magnification = newValue } }
  }

  override dynamic func setMagnification(_ magnification: CGFloat, centeredAt point: NSPoint) {
    zoom { super.setMagnification(magnification, centeredAt: point) }
  }

  override func magnify(toFit rect: NSRect) { zoom { super.magnify(toFit: rect) } }

  /// Whether the view moves of itself, on a spring.
  var animating: Bool { spring != nil || pan != nil }

  /// From the clip view's points to the document's.
  private var offset: CGVector {
    guard let d = documentView else { return .zero }
    return CGVector(dx: d.bounds.minX - d.frame.minX, dy: d.bounds.minY - d.frame.minY)
  }

  private func clip(_ p: NSPoint) -> NSPoint { NSPoint(x: p.x - offset.dx, y: p.y - offset.dy) }

  override func scrollWheel(with event: NSEvent) {
    stopSpring()
    stopPan()
    guard event.modifierFlags.contains(.command) else { return super.scrollWheel(with: event) }
    let p = contentView.convert(event.locationInWindow, from: nil)
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
    stopPan()
    super.smartMagnify(with: event)
  }

  /// Springs the zoom to `zoom` keeping clip view point `centre` in place, in log space so zooming
  /// in and out feel alike.
  func springMagnification(to zoom: CGFloat, centeredAt centre: NSPoint) {
    let z = min(max(zoom, minMagnification), maxMagnification)
    guard !Spring.reduced else {
      stopSpring()
      return setMagnification(z, centeredAt: centre)
    }
    let o = offset
    spring = (log(magnification), spring?.v ?? 0, log(z), NSPoint(x: centre.x + o.dx, y: centre.y + o.dy), CACurrentMediaTime())
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
      contentView.scroll(to: clip(origin))
      return reflectScrolledClipView(contentView)
    }
    let at = contentView.bounds.origin, o = offset
    let link = pan?.link ?? displayLink(target: self, selector: #selector(panTick(_:)))
    if pan == nil { link.add(to: .main, forMode: .common) }
    pan = (Double(at.x + o.dx), pan?.vx ?? 0, Double(at.y + o.dy), pan?.vy ?? 0, origin, CACurrentMediaTime(), link)
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
    if done { stopPan() } else { pan = p }
    contentView.scroll(to: clip(done ? p.to : NSPoint(x: p.x, y: p.y)))
    reflectScrolledClipView(contentView)
  }

  @objc private func tick(_ link: CADisplayLink) {
    guard var s = spring else { return stopSpring() }
    Spring.camera.step(&s.value, &s.v, to: s.to, dt: min(0.064, max(0, link.timestamp - s.last)))
    s.last = link.timestamp
    let done = abs(s.value - s.to) < 1e-5 && abs(s.v) < 1e-4
    if done { stopSpring() } else { spring = s }
    setMagnification(exp(done ? s.to : s.value), centeredAt: clip(s.centre))
  }
}

/// Keeps the board under all the view shows while it zooms or resizes: the board grows to take in what it would show
/// first. A pan stops at the edge, or pulls past it, where AppKit's rubber band stretches and springs back. AppKit asks
/// here as it sets the bounds, a size and then an origin, and as it measures a stretch, sometimes with no rect at all.
final class BoardClipView: NSClipView {
  private var resizing = 0

  /// A window resized, or a find bar shown or hidden: what the view shows now grows the board, as a zoom's does.
  override func setFrameSize(_ newSize: NSSize) {
    resizing += 1
    defer { resizing -= 1 }
    super.setFrameSize(newSize)
  }

  override func constrainBoundsRect(_ proposed: NSRect) -> NSRect {
    guard let canvas = documentView as? CanvasView, [proposed.minX, proposed.minY, proposed.width, proposed.height].allSatisfy(\.isFinite)
    else { return super.constrainBoundsRect(proposed) }
    if canvas.rebasing { return proposed }
    var r = proposed
    if (enclosingScrollView as? BoardScrollView)?.zooming == true || resizing > 0 || proposed.size != bounds.size {
      let d = canvas.takeIn(proposed, of: self)
      r.origin.x += d.dx
      r.origin.y += d.dy
    }
    return super.constrainBoundsRect(r)
  }
}
