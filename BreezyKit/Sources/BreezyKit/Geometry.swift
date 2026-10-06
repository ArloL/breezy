import Foundation

public enum Metrics {
  public static let grid = 24.0
  public static let cardWidth = 240.0
  public static let backWidth = 480.0
  public static let backMinHeight = 12 * grid
  public static let laneWidth = 480.0
  public static let laneHeight = 720.0
  public static let laneMin = 4 * grid
  public static let laneHeader = 2 * grid
  /// Stacked cards sit on the first grid line at least this far below the card above.
  public static let room = grid / 2
  /// Lane cards float up to this far below the lane top.
  public static let stackTop = 3 * grid
  public static let undoLimit = 100
}

public func snap(_ v: Double) -> Double { (v / Metrics.grid).rounded() * Metrics.grid }

public struct Rect: Equatable, Sendable {
  public var x: Double
  public var y: Double
  public var w: Double
  public var h: Double

  public init(x: Double, y: Double, w: Double, h: Double) {
    self.x = x
    self.y = y
    self.w = w
    self.h = h
  }

  public func intersects(_ o: Rect) -> Bool { x < o.x + o.w && o.x < x + w && y < o.y + o.h && o.y < y + h }

  public func contains(_ px: Double, _ py: Double) -> Bool { px >= x && px <= x + w && py >= y && py <= y + h }

  public func containsCentre(of b: Rect) -> Bool { contains(b.x + b.w / 2, b.y + b.h / 2) }

  /// Whether the two overlap horizontally, as cards in one column of a lane do.
  public func sharesColumn(with o: Rect) -> Bool { x < o.x + o.w && o.x < x + w }

  /// The first grid line at least `Metrics.room` below this rect.
  public var lineBelow: Double { ((y + h + Metrics.room) / Metrics.grid).rounded(.up) * Metrics.grid }
}
