import AppKit

/// The card editor: Esc or ⌘↩ finishes, Tab turns the card over and goes on editing.
final class EditorTextView: NSTextView {
  var onFinish: (() -> Void)?
  var onTab: (() -> Void)?
  private var textOffset = NSPoint.zero

  override var textContainerOrigin: NSPoint { textOffset }

  /// Lays the text out in `rect` of the superview. AppKit moves a view's frame out to whole pixels,
  /// so the text is offset back into place, where the card's bitmap draws it.
  func place(_ rect: NSRect) {
    guard let s = superview, let container = textContainer else { return }
    let f = s.backingAlignedRect(rect, options: .alignAllEdgesOutward)
    let offset = NSPoint(x: rect.minX - f.minX, y: rect.minY - f.minY)
    if offset != textOffset {
      textOffset = offset
      needsDisplay = true
    }
    container.widthTracksTextView = false
    if container.size.width != rect.width { container.size = NSSize(width: rect.width, height: container.size.height) }
    frame = f
  }

  override func keyDown(with event: NSEvent) {
    let mods = event.modifierFlags.intersection([.command, .option, .control, .shift])
    if event.keyCode == 53 || (event.keyCode == 36 && mods == .command) {
      onFinish?()
    } else if event.keyCode == 48 && mods.isEmpty {
      onTab?()
    } else {
      super.keyDown(with: event)
    }
  }
}
