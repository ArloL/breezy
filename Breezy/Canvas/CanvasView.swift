import AppKit
import BreezyKit

/// The scroll view's document view: draws the board held by `model` and turns pointer and key
/// input into changes on it. World coordinates, as stored in the board, are offset by `origin`.
final class CanvasView: NSView {
  static let origin: CGFloat = 834 * 24
  static let size: CGFloat = 2 * origin

  let model: BoardModel
  var board: Board { model.board }
  var onBoardChange: (() -> Void)?

  init(model: BoardModel) {
    self.model = model
    super.init(frame: NSRect(x: 0, y: 0, width: Self.size, height: Self.size))
    model.onChange = { [weak self] _ in self?.boardChanged() }
  }

  required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }
  override var acceptsFirstResponder: Bool { true }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  var zoom: CGFloat { enclosingScrollView?.magnification ?? 1 }

  func doc(_ r: Rect) -> NSRect { NSRect(x: r.x + Self.origin, y: r.y + Self.origin, width: r.w, height: r.h) }

  func frontRect(_ c: Card) -> Rect { c.rect(height: 2 * Metrics.grid) }

  func layoutCards() {}

  private func boardChanged() {
    onBoardChange?()
  }
}
