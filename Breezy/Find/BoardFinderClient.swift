import AppKit
import BreezyKit

/// Lets the system find bar search the board: the text comes from BreezyKit's SearchIndex, and
/// found ranges map back to cards and lanes on the canvas.
final class BoardFinderClient: NSObject, NSTextFinderClient {
  private unowned let canvas: CanvasView
  private var cached: SearchIndex?
  private var selection = NSRange(location: 0, length: 0)

  init(canvas: CanvasView) {
    self.canvas = canvas
  }

  private var index: SearchIndex {
    if let cached { return cached }
    let i = SearchIndex(canvas.board)
    cached = i
    return i
  }

  func invalidate() { cached = nil }

  var string: String { index.string }
  var isSelectable: Bool { true }
  var allowsMultipleSelection: Bool { false }
  var isEditable: Bool { false }
  var firstSelectedRange: NSRange { selection }

  var selectedRanges: [NSValue] {
    get { [NSValue(range: selection)] }
    set { selection = newValue.first?.rangeValue ?? NSRange(location: 0, length: 0) }
  }

  func scrollRangeToVisible(_ range: NSRange) {
    guard let hit = index.locate(range) else { return }
    canvas.reveal(hit.entry.id, back: hit.entry.side == .back)
  }

  var visibleCharacterRanges: [NSValue] {
    index.entries.filter { canvas.isVisible($0.id) }.map { NSValue(range: $0.range) }
  }

  func rects(forCharacterRange range: NSRange) -> [NSValue]? {
    guard let hit = index.locate(range) else { return nil }
    return canvas.textRects(hit.entry, hit.local).map { NSValue(rect: $0) }
  }

  func contentView(at index: Int, effectiveCharacterRange outRange: NSRangePointer) -> NSView {
    let entry = self.index.entries.first { NSLocationInRange(index, $0.range) || index == NSMaxRange($0.range) }
    outRange.pointee = entry?.range ?? NSRange(location: index, length: 0)
    return canvas
  }

  func drawCharacters(in range: NSRange, forContentView view: NSView) {
    guard let hit = index.locate(range) else { return }
    canvas.drawText(hit.entry, hit.local)
  }
}
