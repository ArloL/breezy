import AppKit

/// Holds the card layers above the lanes.
final class CardHostView: NSView {
  override var isFlipped: Bool { true }

  override init(frame: NSRect) {
    super.init(frame: frame)
    layer = CALayer()
    wantsLayer = true
  }

  required init?(coder: NSCoder) { fatalError() }
}
