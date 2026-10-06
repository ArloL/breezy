import Foundation

extension Board {
  /// Where everything but cards `ids` stands, for a drag's `Room`.
  public func layout(excluding ids: Set<String>) -> Layout {
    Layout(
      cardY: Dictionary(uniqueKeysWithValues: cards.filter { !ids.contains($0.id) }.map { ($0.id, $0.y) }),
      laneH: Dictionary(uniqueKeysWithValues: lanes.map { ($0.id, $0.h) })
    )
  }

  /// Ends a drag: the held cards drop into the places kept for them.
  public mutating func land(_ ids: Set<String>, room: Room) {
    settle(room.heightOf, held: ids, base: room.base, land: true)
  }

  public mutating func gravity(_ heightOf: HeightOf) { settle(heightOf) }

  /// Floats the cards in each lane up their columns in order of their centres; lanes grow to fit.
  /// Cards `held` in a drag stay where they are but are ordered as a block by their top card and
  /// keep their places free; `land` moves them in. With `base` the others start from where they
  /// stood when the drag began, so dragging away gives cards back their places.
  mutating func settle(_ heightOf: HeightOf, held: Set<String> = [], base: Layout? = nil, land: Bool = false) {
    if let base {
      for i in cards.indices { if let y = base.cardY[cards[i].id] { cards[i].y = y } }
      for i in lanes.indices { if let h = base.laneH[lanes[i].id] { lanes[i].h = h } }
    }
    struct Box {
      var index: Int
      var rect: Rect
      var held: Bool
    }
    let boxes = cards.indices.map { i in
      Box(index: i, rect: cards[i].rect(height: heightOf(cards[i].id)), held: held.contains(cards[i].id))
    }
    var done = Set<Int>()
    for li in lanes.indices {
      let area = lanes[li].rect
      let members = boxes.filter { !done.contains($0.index) && area.containsCentre(of: $0.rect) }
      for b in members { done.insert(b.index) }
      let top = members.filter(\.held).min { $0.rect.y < $1.rect.y }
      func key(_ b: Box) -> (Double, Int, Double, Int) {
        b.held ? (top!.rect.y + top!.rect.h / 2, 0, b.rect.y, b.index) : (b.rect.y + b.rect.h / 2, 1, b.rect.y, b.index)
      }
      var placed: [Rect] = []
      for b in members.sorted(by: { key($0) < key($1) }) {
        var y = lanes[li].y + Metrics.stackTop
        for p in placed where p.sharesColumn(with: b.rect) { y = max(y, p.lineBelow) }
        let r = Rect(x: b.rect.x, y: y, w: b.rect.w, h: b.rect.h)
        placed.append(r)
        if !b.held || land { cards[b.index].y = y }
        lanes[li].h = max(lanes[li].h, r.lineBelow - lanes[li].y)
      }
    }
  }

  /// Card `id` and the cards below it in its lane's column.
  public func pile(_ id: String, heightOf: HeightOf) -> [String] {
    guard let c = card(id) else { return [] }
    let cr = c.rect(height: heightOf(id))
    guard let lane = lanes.first(where: { $0.rect.containsCentre(of: cr) }) else { return [id] }
    return cards.filter { x in
      let xr = x.rect(height: heightOf(x.id))
      return x.id == id || (x.y > c.y && cr.sharesColumn(with: xr) && lane.rect.containsCentre(of: xr))
    }.map(\.id)
  }
}
