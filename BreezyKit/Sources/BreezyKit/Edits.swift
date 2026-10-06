import Foundation

/// Where everything but the dragged cards stood when a drag began.
public struct Layout: Equatable, Sendable {
  public var cardY: [String: Double]
  public var laneH: [String: Double]
}

/// A drag in progress: the others make room for the held cards, starting from `base`.
public struct Room {
  public var base: Layout
  public var heightOf: HeightOf

  public init(base: Layout, heightOf: @escaping HeightOf) {
    self.base = base
    self.heightOf = heightOf
  }
}

extension Board {
  @discardableResult
  public mutating func addCard(x: Double, y: Double) -> String {
    let card = Card(id: newID("c"), x: snap(x), y: snap(y))
    cards.append(card)
    return card.id
  }

  public mutating func setText(_ id: String, _ text: String) {
    if let i = cardIndex(id) { cards[i].text = text }
  }

  public mutating func setNotes(_ id: String, _ notes: String) {
    if let i = cardIndex(id) { cards[i].notes = notes }
  }

  public mutating func setLaneTitle(_ id: String, _ title: String) {
    if let i = laneIndex(id) { lanes[i].title = title }
  }

  /// Ends editing card `id`: trailing whitespace goes, and a card blank on both sides is removed.
  public mutating func finishEdit(_ id: String) {
    guard let i = cardIndex(id) else { return }
    cards[i].text = cards[i].text.trimmingTrailingWhitespace()
    let notes = (cards[i].notes ?? "").trimmingTrailingWhitespace()
    cards[i].notes = notes.isEmpty ? nil : notes
    if cards[i].text.isEmpty && cards[i].notes == nil { cards.remove(at: i) }
  }

  /// With `room` the cards are held in a drag and the others make room for them; see `settle`.
  public mutating func moveCards(_ origins: [Origin], dx: Double, dy: Double, room: Room? = nil) {
    for o in origins {
      guard let i = cardIndex(o.id) else { continue }
      cards[i].x = snap(o.x + dx)
      cards[i].y = snap(o.y + dy)
    }
    if let room { settle(room.heightOf, held: Set(origins.map(\.id)), base: room.base) }
  }

  public mutating func setColor(_ ids: Set<String>, _ color: Int) {
    for i in cards.indices where ids.contains(cards[i].id) { cards[i].color = color }
  }

  public mutating func remove(_ ids: Set<String>) {
    cards.removeAll { ids.contains($0.id) }
    lanes.removeAll { ids.contains($0.id) }
  }

  @discardableResult
  public mutating func addLane(x: Double, y: Double) -> String {
    let lane = Lane(id: newID("l"), x: snap(x), y: snap(y))
    lanes.append(lane)
    return lane.id
  }

  /// Moves lane `origin.id` by the snapped delta and carries `carried` with it.
  public mutating func moveLane(_ origin: Origin, cards carried: [Origin], dx: Double, dy: Double) {
    guard let li = laneIndex(origin.id) else { return }
    lanes[li].x = snap(origin.x + dx)
    lanes[li].y = snap(origin.y + dy)
    let ddx = lanes[li].x - origin.x
    let ddy = lanes[li].y - origin.y
    for o in carried {
      guard let i = cardIndex(o.id) else { continue }
      cards[i].x = o.x + ddx
      cards[i].y = o.y + ddy
    }
  }

  public mutating func resizeLane(_ id: String, w: Double, h: Double) {
    guard let i = laneIndex(id) else { return }
    lanes[i].w = max(Metrics.laneMin, snap(w))
    lanes[i].h = max(Metrics.laneMin, snap(h))
  }

  public func cardsInLane(_ id: String, heightOf: HeightOf) -> [Card] {
    guard let lane = lane(id) else { return [] }
    return cards.filter { lane.rect.containsCentre(of: $0.rect(height: heightOf($0.id))) }
  }

  public func cardsInRect(_ r: Rect, heightOf: HeightOf) -> [Card] {
    cards.filter { r.intersects($0.rect(height: heightOf($0.id))) }
  }
}

extension String {
  func trimmingTrailingWhitespace() -> String {
    var s = Substring(self)
    while let last = s.last, last.isWhitespace { s.removeLast() }
    return String(s)
  }
}
