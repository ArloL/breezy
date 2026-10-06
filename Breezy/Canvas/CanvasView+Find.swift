import AppKit
import BreezyKit

extension CanvasView {
  private func rect(of id: String) -> Rect? {
    if let c = board.card(id) { return drawnRect(c) }
    return board.lane(id)?.rect
  }

  /// Scrolls item `id` into view; a match on a card's back turns the card over.
  func reveal(_ id: String, back: Bool) {
    if board.card(id) != nil {
      if back { turn(id) } else if turned == id { turn(nil) }
    }
    guard let r = rect(of: id) else { return }
    scrollToVisible(doc(r).insetBy(dx: -48, dy: -48))
  }

  func isVisible(_ id: String) -> Bool { rect(of: id).map { doc($0).intersects(visibleRect) } ?? false }

  /// An entry's text laid out as drawn, and the canvas point where its first line starts.
  private func textLayout(_ e: SearchIndex.Entry) -> (NSAttributedString, CGFloat, NSPoint)? {
    switch e.side {
    case .front:
      guard let c = board.card(e.id) else { return nil }
      let r = doc(drawnRect(c))
      return (Typo.front(c.text), r.width - 2 * Typo.padX, NSPoint(x: r.minX + Typo.padX, y: r.minY + Typo.padY))
    case .back:
      guard let c = board.card(e.id) else { return nil }
      let r = doc(drawnRect(c))
      return (NSAttributedString(string: c.notes ?? "", attributes: Typo.notesAttrs), r.width - 2 * Typo.backPad,
              NSPoint(x: r.minX + Typo.backPad, y: r.minY + Typo.backPad + Typo.line))
    case .title:
      guard let l = board.lane(e.id) else { return nil }
      let r = doc(l.rect)
      let t = LaneView.headerTextRect(width: r.width)
      return (NSAttributedString(string: l.title, attributes: Typo.attrs(Typo.laneFont, Theme.ink2)), t.width,
              NSPoint(x: r.minX + t.minX, y: r.minY + t.minY))
    }
  }

  func textRects(_ e: SearchIndex.Entry, _ local: NSRange) -> [NSRect] {
    guard let (s, width, origin) = textLayout(e) else { return [] }
    let (storage, manager, container) = TextMetrics.layout(s, width: width)
    let glyphs = manager.glyphRange(forCharacterRange: local, actualCharacterRange: nil)
    var rects: [NSRect] = []
    manager.enumerateEnclosingRects(forGlyphRange: glyphs, withinSelectedGlyphRange: NSRange(location: NSNotFound, length: 0), in: container) { r, _ in
      rects.append(r.offsetBy(dx: origin.x, dy: origin.y))
    }
    withExtendedLifetime(storage) {}
    return rects
  }

  func drawText(_ e: SearchIndex.Entry, _ local: NSRange) {
    guard let (s, width, origin) = textLayout(e) else { return }
    let (storage, manager, _) = TextMetrics.layout(s, width: width)
    manager.drawGlyphs(forGlyphRange: manager.glyphRange(forCharacterRange: local, actualCharacterRange: nil), at: origin)
    withExtendedLifetime(storage) {}
  }
}
