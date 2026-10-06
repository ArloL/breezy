import Foundation

public struct Card: Codable, Equatable, Identifiable, Sendable {
  public var id: String
  public var x: Double
  public var y: Double
  public var w: Double
  public var text: String
  public var notes: String?
  public var color: Int

  public init(id: String, x: Double, y: Double, w: Double = Metrics.cardWidth, text: String = "", notes: String? = nil, color: Int = 1) {
    self.id = id
    self.x = x
    self.y = y
    self.w = w
    self.text = text
    self.notes = notes
    self.color = color
  }

  public func rect(height: Double) -> Rect { Rect(x: x, y: y, w: w, h: height) }
}

public struct Lane: Codable, Equatable, Identifiable, Sendable {
  public var id: String
  public var x: Double
  public var y: Double
  public var w: Double
  public var h: Double
  public var title: String

  public init(id: String, x: Double, y: Double, w: Double = Metrics.laneWidth, h: Double = Metrics.laneHeight, title: String = "Lane") {
    self.id = id
    self.x = x
    self.y = y
    self.w = w
    self.h = h
    self.title = title
  }

  public var rect: Rect { Rect(x: x, y: y, w: w, h: h) }
}

/// Card heights depend on fonts, so the rules take them from the app.
public typealias HeightOf = (String) -> Double

/// Where an item stood when a drag began.
public struct Origin: Equatable, Sendable {
  public var id: String
  public var x: Double
  public var y: Double

  public init(id: String, x: Double, y: Double) {
    self.id = id
    self.x = x
    self.y = y
  }
}

public struct Board: Equatable, Sendable {
  public var cards: [Card]
  public var lanes: [Lane]

  public init(cards: [Card] = [], lanes: [Lane] = []) {
    self.cards = cards
    self.lanes = lanes
  }

  public func card(_ id: String) -> Card? { cards.first { $0.id == id } }
  public func lane(_ id: String) -> Lane? { lanes.first { $0.id == id } }
  func cardIndex(_ id: String) -> Int? { cards.firstIndex { $0.id == id } }
  func laneIndex(_ id: String) -> Int? { lanes.firstIndex { $0.id == id } }
}

public func newID(_ prefix: String) -> String {
  prefix + String(Int(Date().timeIntervalSince1970 * 1000), radix: 36) + String(Int.random(in: 0..<60_466_176), radix: 36)
}
