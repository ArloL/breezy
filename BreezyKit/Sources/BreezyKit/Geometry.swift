import Foundation

public enum Metrics {
  public static let grid = 24.0
  public static let cardWidth = 240.0
  public static let backWidth = 480.0
  public static let backMinHeight = 12 * grid
  /// A card with a grid either side.
  public static let laneWidth = cardWidth + 2 * grid
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

  /// How far what `area` shows moves, the least, to bring this rect into it `pad` in from its edges, less where `area`
  /// is too small for that, 16 at least; a rect too big for it shows its left edge and its top, or its bottom with
  /// `bottom`. As the web app's revealing, held to Tests/Fixtures/reveal.json.
  public func revealShift(in area: Rect, pad: Double = 16, bottom: Bool = false) -> Vector {
    let px = min(pad, max(16, (area.w - w) / 2)), py = min(pad, max(16, (area.h - h) / 2))
    var s = Vector()
    if w + 2 * px > area.w || x < area.x + px { s.dx = area.x + px - x }
    else if x + w > area.x + area.w - px { s.dx = area.x + area.w - px - (x + w) }
    if h + 2 * py > area.h { s.dy = bottom ? area.y + area.h - py - (y + h) : area.y + py - y }
    else if y < area.y + py { s.dy = area.y + py - y }
    else if y + h > area.y + area.h - py { s.dy = area.y + area.h - py - (y + h) }
    return s
  }

  /// Whether the two overlap horizontally, as cards in one column of a lane do.
  public func sharesColumn(with o: Rect) -> Bool { x < o.x + o.w && o.x < x + w }

  /// The first grid line at least `Metrics.room` below this rect.
  public var lineBelow: Double { ((y + h + Metrics.room) / Metrics.grid).rounded(.up) * Metrics.grid }
}
