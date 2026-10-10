import Foundation

/// Record fields of an item someone else is dragging or editing, as their live messages carry them.
public typealias LiveFields = [String: JSONValue]

extension Records {
  /// The fields a live message may carry; an item new during the gesture also carries `kind`, and one deleted `gone`.
  public static let liveFieldNames: Set<String> = ["pos", "size", "w", "text", "notes", "color", "title"]

  /// What the gesture changed of items `ids` between `start` and `now`, as record fields.
  public static func liveFields(from start: Board, to now: Board, ids: Set<String>, board: String) -> [String: LiveFields] {
    var out: [String: LiveFields] = [:]
    func put(_ id: String, _ before: Record?, _ after: Record) {
      let names = before == nil ? liveFieldNames.union(["kind"]) : liveFieldNames
      let f = after.fields.filter { names.contains($0.key) && before?[$0.key] != $0.value }
      if !f.isEmpty { out[id] = f }
    }
    for c in now.cards where ids.contains(c.id) {
      put(c.id, start.card(c.id).map { card($0, board: board, order: "") }, card(c, board: board, order: ""))
    }
    for l in now.lanes where ids.contains(l.id) {
      put(l.id, start.lane(l.id).map { lane($0, board: board) }, lane(l, board: board))
    }
    let kept = Set(now.cards.map(\.id) + now.lanes.map(\.id))
    for id in start.cards.map(\.id) + start.lanes.map(\.id) where ids.contains(id) && !kept.contains(id) { out[id] = ["gone": .bool(true)] }
    return out
  }

  /// Where the held cards and lanes of `ids` were when the gesture began, as `[x, y]`.
  public static func startPositions(_ start: Board, ids: Set<String>) -> [String: [Double]] {
    var out: [String: [Double]] = [:]
    for c in start.cards where ids.contains(c.id) { out[c.id] = [c.x, c.y] }
    for l in start.lanes where ids.contains(l.id) { out[l.id] = [l.x, l.y] }
    return out
  }
}

extension Board {
  /// This board as others' live edits show it; a new card appears, other unknown ids are left out.
  public func overlaid(_ overlay: [String: LiveFields]) -> Board {
    guard !overlay.isEmpty else { return self }
    var b = self
    b.cards.removeAll { overlay[$0.id]?["gone"] == .bool(true) }
    b.lanes.removeAll { overlay[$0.id]?["gone"] == .bool(true) }
    for i in b.cards.indices {
      guard let f = overlay[b.cards[i].id] else { continue }
      if let (x, y) = Records.unpair(f["pos"]) { (b.cards[i].x, b.cards[i].y) = (x, y) }
      if let w = f["w"]?.number, w.isFinite { b.cards[i].w = w }
      if let t = f["text"]?.string { b.cards[i].text = t }
      if let n = f["notes"]?.string { b.cards[i].notes = n.isEmpty ? nil : n }
      if let c = f["color"]?.number { b.cards[i].color = Int(min(max(c, 1), 5)) }
    }
    for i in b.lanes.indices {
      guard let f = overlay[b.lanes[i].id] else { continue }
      if let (x, y) = Records.unpair(f["pos"]) { (b.lanes[i].x, b.lanes[i].y) = (x, y) }
      if let (w, h) = Records.unpair(f["size"]) { (b.lanes[i].w, b.lanes[i].h) = (w, h) }
      if let t = f["title"]?.string { b.lanes[i].title = t }
    }
    let known = Set(b.cards.map(\.id) + b.lanes.map(\.id))
    for (id, f) in overlay.sorted(by: { $0.key < $1.key }) where !known.contains(id) && f["gone"] == nil {
      let (x, y) = Records.unpair(f["pos"]) ?? (0, 0)
      switch f["kind"]?.string {
      case "card":
        let notes = f["notes"]?.string ?? ""
        b.cards.append(Card(id: id, x: x, y: y, w: f["w"]?.number ?? Metrics.cardWidth, text: f["text"]?.string ?? "",
                            notes: notes.isEmpty ? nil : notes, color: Int(min(max(f["color"]?.number ?? 1, 1), 5))))
      case "lane":
        let (w, h) = Records.unpair(f["size"]) ?? (Metrics.laneWidth, Metrics.laneHeight)
        b.lanes.append(Lane(id: id, x: x, y: y, w: w, h: h, title: f["title"]?.string ?? ""))
      default: break
      }
    }
    return b
  }
}
