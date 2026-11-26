import Foundation

/// How far the board reaches, as Freeform's: its cards and lanes, a margin round them, and what the view showed when it
/// last rested and while zooming since, so that its edge shows only while pulled. As web/camera.ts has it, held to
/// Tests/Fixtures/board.json.
public struct BoardBounds: Equatable, Sendable {
  /// How far the board reaches past its outermost card or lane, in board points whatever the zoom.
  public static let margin = 1194.0

  /// What the view showed when it last rested, and while zooming since.
  public private(set) var seen: Rect?

  public init() {}

  /// What `rects` span; an empty board spans its origin.
  public static func extent(_ rects: [Rect]) -> Rect {
    guard var r = rects.first else { return Rect(x: 0, y: 0, w: 0, h: 0) }
    for o in rects.dropFirst() { r = r.union(o) }
    return r
  }

  /// The board: `content` and the margin, and `seen`.
  public static func board(_ content: Rect, seen: Rect?) -> Rect {
    let m = margin, b = Rect(x: content.x - m, y: content.y - m, w: content.w + 2 * m, h: content.h + 2 * m)
    return seen.map(b.union) ?? b
  }

  /// The board `area`, in screen points, shows through `camera`.
  public static func seen(_ camera: Scene.Camera, area: Rect) -> Rect {
    let z = camera.zoom
    return Rect(x: (area.x - camera.x) / z, y: (area.y - camera.y) / z, w: area.w / z, h: area.h / z)
  }

  public static func takeIn(_ seen: Rect?, _ shown: Rect) -> Rect { seen.map { $0.union(shown) } ?? shown }

  /// The view came to rest showing `shown`: the board keeps that, and lets go of what it showed before.
  public mutating func rest(_ shown: Rect) { seen = shown }

  /// A zoom shows `shown`: the board grows to it, so that zooming out never shows its edge.
  public mutating func takeIn(_ shown: Rect) { seen = Self.takeIn(seen, shown) }

  /// How much further, in whole points, a board grown or shrunk `d` points at its left or top grows there for the view
  /// it moves under to move whole pixels, `pixelsPerPoint` of them a board point: else AppKit snaps the view onto its
  /// pixels after, and mid-pinch the board slipped from under the fingers by what it snapped. None found in 512 pt: 0.
  public static func onPixels(_ d: Double, pixelsPerPoint q: Double) -> Double {
    guard d != 0, q > 0 else { return 0 }
    for e in 0..<512 {
      let px = (d + Double(e)) * q
      if abs(px - px.rounded()) < 0.02 { return Double(e) }
    }
    return 0
  }

  /// The board round `content`, out to whole points, which a view's frame keeps exactly.
  public func board(_ content: Rect) -> Rect { Self.board(content, seen: seen).outward }
}

extension Rect {
  public func union(_ o: Rect) -> Rect {
    let x0 = min(x, o.x), y0 = min(y, o.y)
    return Rect(x: x0, y: y0, w: max(x + w, o.x + o.w) - x0, h: max(y + h, o.y + o.h) - y0)
  }

  /// The least rect on whole points that holds this one. An edge within rounding error of a whole point is on it: a
  /// union's far edge, x + w, comes back from its own sum a hair past the point it was.
  public var outward: Rect {
    func whole(_ v: Double, _ r: FloatingPointRoundingRule) -> Double { abs(v - v.rounded()) < 1e-9 ? v.rounded() : v.rounded(r) }
    let x0 = whole(x, .down), y0 = whole(y, .down)
    return Rect(x: x0, y: y0, w: whole(x + w, .up) - x0, h: whole(y + h, .up) - y0)
  }
}
