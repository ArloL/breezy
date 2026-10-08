import AppKit

/// Holds the card layers above the lanes. It takes no clicks: the canvas handles them all.
final class CardHostView: NSView {
  override var isFlipped: Bool { true }

  override init(frame: NSRect) {
    super.init(frame: frame)
    layer = CALayer()
    // a layer-hosting view's layer animates implicitly: adding a card would cross-fade the board
    layer!.actions = ["sublayers": NSNull()]
    wantsLayer = true
  }

  required init?(coder: NSCoder) { fatalError() }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
