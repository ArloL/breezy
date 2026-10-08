import Foundation

/// A board, lane or card as it syncs: the JSON object its blob decrypts to.
public struct Record: Codable, Equatable, Sendable {
  public static let format = 1
  public var fields: [String: JSONValue]

  public init(_ fields: [String: JSONValue]) { self.fields = fields }
  public init(from decoder: Decoder) throws { fields = try [String: JSONValue](from: decoder) }
  public func encode(to encoder: Encoder) throws { try fields.encode(to: encoder) }

  public subscript(key: String) -> JSONValue? {
    get { fields[key] }
    set { fields[key] = newValue }
  }

  public var kind: String? { self["kind"]?.string }
  public var deleted: Bool { self["deleted"] == .bool(true) }
  public var format: Int { self["format"]?.number.map { Int($0) } ?? 0 }
  public var board: String? { self["board"]?.string }

  /// What stays of a deleted record, for good.
  public static func marker(_ kind: String) -> Record {
    Record(["format": .number(Double(format)), "kind": .string(kind), "deleted": .bool(true)])
  }
}

/// A local edit to one record: fields to set (all of them for a new record), or its deletion.
public enum Change: Equatable, Sendable {
  case fields([String: JSONValue])
  case deleted(String)
}

/// Boards as records and back. A card's `pos` and a lane's `pos` and `size` are pairs, so that a merge
/// never takes x from one move and y from another.
public enum Records {
  static func pair(_ a: Double, _ b: Double) -> JSONValue { .array([.number(a), .number(b)]) }

  static func unpair(_ v: JSONValue?) -> (Double, Double)? {
    guard let a = v?.array, a.count == 2, let x = a[0].number, let y = a[1].number, x.isFinite, y.isFinite else { return nil }
    return (x, y)
  }

  public static func card(_ c: Card, board: String, order: String) -> Record {
    Record([
      "format": .number(Double(Record.format)), "kind": .string("card"), "board": .string(board),
      "text": .string(c.text), "notes": .string(c.notes ?? ""), "color": .number(Double(c.color)),
      "pos": pair(c.x, c.y), "w": .number(c.w), "order": .string(order),
    ])
  }

  public static func lane(_ l: Lane, board: String) -> Record {
    Record([
      "format": .number(Double(Record.format)), "kind": .string("lane"), "board": .string(board),
      "title": .string(l.title), "pos": pair(l.x, l.y), "size": pair(l.w, l.h),
    ])
  }

  public static func board(title: String) -> Record {
    Record(["format": .number(Double(Record.format)), "kind": .string("board"), "title": .string(title)])
  }

  /// Board `id` as `records` describe it: cards by order key, then id; lanes by id.
  public static func board(_ id: String, from records: [String: Record]) -> Board {
    var cards: [(order: String, card: Card)] = []
    var lanes: [Lane] = []
    for (rid, r) in records where !r.deleted && r.board == id {
      let (x, y) = unpair(r["pos"]) ?? (0, 0)
      switch r.kind {
      case "card":
        let notes = r["notes"]?.string ?? ""
        let color = Int(r["color"]?.number ?? 1)
        let w = r["w"]?.number.flatMap { $0.isFinite ? $0 : nil } ?? Metrics.cardWidth
        let c = Card(id: rid, x: x, y: y, w: w, text: r["text"]?.string ?? "", notes: notes.isEmpty ? nil : notes, color: min(max(color, 1), 5))
        cards.append((r["order"]?.string ?? "", c))
      case "lane":
        let (w, h) = unpair(r["size"]) ?? (Metrics.laneWidth, Metrics.laneHeight)
        lanes.append(Lane(id: rid, x: x, y: y, w: w, h: h, title: r["title"]?.string ?? ""))
      default:
        break
      }
    }
    cards.sort { ($0.order, $0.card.id) < ($1.order, $1.card.id) }
    return Board(cards: cards.map(\.card), lanes: lanes.sorted { $0.id < $1.id })
  }

  /// What changed from `old` to `new`, both board `id`: whole records for new items, the changed
  /// fields of the others, and deletions. `orders` holds the order keys the store has for its cards.
  public static func changes(from old: Board, to new: Board, board id: String, orders: [String: String]) -> [String: Change] {
    var out: [String: Change] = [:]
    let keys = OrderKey.assign(new.cards.map(\.id), keeping: orders)
    let oldCards = Dictionary(old.cards.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    for c in new.cards {
      let now = card(c, board: id, order: keys[c.id]!)
      guard let was = oldCards[c.id] else {
        out[c.id] = .fields(now.fields)
        continue
      }
      let diff = changed(card(was, board: id, order: orders[c.id] ?? ""), now)
      if !diff.isEmpty { out[c.id] = .fields(diff) }
    }
    let oldLanes = Dictionary(old.lanes.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    for l in new.lanes {
      let now = lane(l, board: id)
      guard let was = oldLanes[l.id] else {
        out[l.id] = .fields(now.fields)
        continue
      }
      let diff = changed(lane(was, board: id), now)
      if !diff.isEmpty { out[l.id] = .fields(diff) }
    }
    let cardIDs = Set(new.cards.map(\.id)), laneIDs = Set(new.lanes.map(\.id))
    for c in old.cards where !cardIDs.contains(c.id) { out[c.id] = .deleted("card") }
    for l in old.lanes where !laneIDs.contains(l.id) { out[l.id] = .deleted("lane") }
    return out
  }

  static func changed(_ a: Record, _ b: Record) -> [String: JSONValue] { b.fields.filter { a[$0.key] != $0.value } }
}
