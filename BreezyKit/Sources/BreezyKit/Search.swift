import Foundation

/// The board's searchable text as one string for the system find bar: lane titles, card fronts
/// and card backs in reading order (top to bottom, then left to right), each its own paragraph.
public struct SearchIndex: Sendable {
  public enum Side: Sendable, Equatable { case front, back, title }

  public struct Entry: Sendable, Equatable {
    public var id: String
    public var side: Side
    public var range: NSRange
  }

  public let string: String
  public let entries: [Entry]

  public init(_ board: Board) {
    typealias Part = (id: String, side: Side, text: String)
    var items: [(x: Double, y: Double, parts: [Part])] = board.lanes.map { ($0.x, $0.y, [($0.id, .title, $0.title)]) }
    items += board.cards.map { c in
      (c.x, c.y, [(c.id, .front, c.text)] + (c.notes.map { [(c.id, .back, $0)] } ?? []))
    }
    items.sort { ($0.y, $0.x) < ($1.y, $1.x) }
    let s = NSMutableString()
    var entries: [Entry] = []
    for item in items {
      for part in item.parts {
        if s.length > 0 { s.append("\u{2029}") }
        let start = s.length
        s.append(part.text)
        entries.append(Entry(id: part.id, side: part.side, range: NSRange(location: start, length: s.length - start)))
      }
    }
    string = s as String
    self.entries = entries
  }

  /// The entry holding `range`, and the range within that entry's text.
  public func locate(_ range: NSRange) -> (entry: Entry, local: NSRange)? {
    guard let e = entries.first(where: { NSLocationInRange(range.location, $0.range) || range.location == NSMaxRange($0.range) })
    else { return nil }
    return (e, NSRange(location: range.location - e.range.location, length: range.length))
  }
}
