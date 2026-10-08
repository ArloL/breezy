import AppKit
import BreezyKit

/// While the zoom changes, a small capsule shows it, fading a second after it stops, as in
/// Freeform.
final class ZoomCapsule: NSView {
  static let size = NSSize(width: 72, height: 28)
  private let label = ReadoutLabel()
  private var hiding: DispatchWorkItem?
  private var shown = false

  override init(frame: NSRect) {
    super.init(frame: NSRect(origin: frame.origin, size: Self.size))
    wantsLayer = true
    isHidden = true
    label.font = .monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .medium)
    label.frame = bounds
    label.autoresizingMask = [.width, .height]
    let glass: NSView
    if #available(macOS 26, *) {
      let g = NSGlassEffectView()
      g.cornerRadius = Self.size.height / 2
      g.contentView = label
      glass = g
    } else {
      let v = NSVisualEffectView()
      v.material = .hudWindow
      v.blendingMode = .withinWindow
      v.wantsLayer = true
      v.layer?.cornerRadius = Self.size.height / 2
      v.layer?.masksToBounds = true
      v.addSubview(label)
      glass = v
    }
    glass.frame = bounds
    glass.autoresizingMask = [.width, .height]
    addSubview(glass)
    setAccessibilityElement(true)
    setAccessibilityRole(.staticText)
  }

  required init?(coder: NSCoder) { fatalError() }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  override func accessibilityValue() -> Any? { label.text }

  func show(_ text: String) {
    label.text = text
    hiding?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.swap(false) }
    hiding = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: work)
    swap(true)
  }

  /// Springs in from 0.9× and fades, or back out.
  private func swap(_ show: Bool) {
    guard show != shown, let layer else { return }
    shown = show
    guard !Spring.reduced else { return isHidden = !show }
    let now = layer.presentation()
    let small = layer.scaledAboutCentre(0.9)
    let spring = show ? Spring.bar : Spring(visualDuration: 0.25)
    let fade = spring.animation("opacity")
    fade.fromValue = isHidden ? 0 : now?.opacity ?? 1
    fade.toValue = show ? 1 : 0
    let grow = spring.animation("transform")
    grow.fromValue = NSValue(caTransform3D: isHidden ? small : now?.transform ?? CATransform3DIdentity)
    grow.toValue = NSValue(caTransform3D: show ? CATransform3DIdentity : small)
    isHidden = false
    CATransaction.begin()
    CATransaction.setCompletionBlock { [weak self] in
      guard let self, !shown else { return }
      isHidden = true
      self.layer?.removeAllAnimations()
    }
    for a in [fade, grow] {
      a.fillMode = .forwards
      a.isRemovedOnCompletion = false
      layer.add(a, forKey: a.keyPath)
    }
    CATransaction.commit()
  }
}

/// Redrawn at most 30 times a second during a zoom, and once more when it stops; faster digits
/// cannot be read anyway, and each redraw lays out the text.
final class ReadoutLabel: NSView {
  var text = "100 %" {
    didSet {
      guard text != oldValue else { return }
      let wait = 1.0 / 30 - (CACurrentMediaTime() - drawn)
      if wait <= 0 { return needsDisplay = true }
      guard !pending else { return }
      pending = true
      DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
        self?.pending = false
        self?.needsDisplay = true
      }
    }
  }
  private var drawn = 0.0
  private var pending = false
  var font: NSFont?

  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  override func draw(_ dirtyRect: NSRect) {
    drawn = CACurrentMediaTime()
    let s = NSAttributedString(string: text, attributes: [.font: font ?? .systemFont(ofSize: NSFont.systemFontSize), .foregroundColor: NSColor.labelColor])
    let size = s.size()
    s.draw(at: NSPoint(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2))
  }
}
