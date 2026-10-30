import Foundation

/// A point on the board, in world points.
public struct Point: Equatable, Sendable {
  public var x: Double
  public var y: Double

  public init(x: Double, y: Double) {
    self.x = x
    self.y = y
  }
}

/// A distance on the board, in world points.
public struct Vector: Equatable, Sendable {
  public var dx: Double
  public var dy: Double

  public init(dx: Double = 0, dy: Double = 0) {
    self.dx = dx
    self.dy = dy
  }

  public static let zero = Vector()
}

/// The cards or lane a drag holds, and how far they are drawn from where the board keeps them.
public struct Grip: Equatable, Sendable {
  public var ids: Set<String> = []
  public var offset = Vector.zero
  /// A resized lane's size beyond the grid.
  public var growth = Vector.zero

  public init() {}
}

/// A press that may become a drag, in world points.
public struct Drag {
  public enum Kind: Sendable { case cards, lane, resize, marquee }
  public var kind: Kind
  public var id: String?
  public var start: Point
  public var origins: [Origin] = []
  public var laneOrigin: Origin?
  public var size = Vector.zero
  public var base: Set<String> = []
  public var room: Room?
  public var moved = false
}

/// What the Mac does with a mouse on the board: which item a press hits, what a drag moves, and where it lands. Points
/// are in the world; the app turns events into calls here and draws what this holds.
@MainActor public final class CanvasCore {
  public let model: BoardModel
  public var board: Board { model.board }

  /// What someone else holds, which can't be selected, moved or edited.
  public var taken: () -> Set<String> = { [] }
  /// The zoom, for the distance a press must move to become a drag.
  public var zoom: () -> Double = { 1 }
  /// A card's front height, which stacking uses for turned cards too.
  public var heightOf: HeightOf = { _ in 2 * Metrics.grid }
  /// Where the view looks, for the scene.
  public var camera: () -> Scene.Camera = { Scene.Camera(x: 0, y: 0, zoom: 1) }
  /// Where card `c` is drawn; a turned card shows its back.
  public var drawnRect: (Card) -> Rect
  /// Turns a card over, or puts it back with nil; the app animates it.
  public var turn: (String?) -> Void
  public var onDoubleClick: (Point) -> Void = { _ in }
  /// Asks the space to hold these ids for the gesture starting.
  public var hold: (Set<String>) -> Void = { _ in }
  /// After the selection changes.
  public var onSelection: () -> Void = {}
  /// What the pointer holds moved off the grid while the board stayed put.
  public var onFloat: () -> Void = {}
  /// Cards landed where a drag dropped them.
  public var onLand: () -> Void = {}

  public var selection: Set<String> = [] {
    didSet {
      let t = taken()
      if !selection.isDisjoint(with: t) { selection.subtract(t) }
      if selection != oldValue { onSelection() }
    }
  }
  /// The card showing its back.
  public var turned: String? {
    didSet {
      if turned != oldValue { flight.note(.transition, "turn", ["from": oldValue.map(JSONValue.string) ?? .null, "to": turned.map(JSONValue.string) ?? .null]) }
    }
  }
  /// What it saw and decided, for whoever debugs it, as the web app's App keeps it.
  public let flight = Flight()
  /// Cards lifted by a drag: above the others, a little larger.
  public var raised: Set<String> = []
  /// What the pointer holds, which follows it exactly; the board keeps it on the grid, where it lands on release.
  public var held = Grip()
  public var drag: Drag?
  /// The selection box being drawn.
  public private(set) var marquee: Rect?
  /// Where a press or a move, pressed or not, last left the pointer; nil off the board.
  public private(set) var pointer: Point?
  /// The card under the pointer, for Space; found afresh, as a drag moves cards under a still pointer.
  public var hovered: String? { pointer.flatMap { card(at: $0)?.id } }

  public init(model: BoardModel) {
    self.model = model
    drawnRect = { _ in Rect(x: 0, y: 0, w: 0, h: 0) }
    turn = { _ in }
    // a turned card at its back's size, as the app draws it: as wide as a back is, and a title and its notes tall, 12
    // lines at least, as the web's fake view has it
    drawnRect = { [unowned self] c in
      guard c.id == turned else { return c.rect(height: heightOf(c.id)) }
      let lines = 1 + (c.notes ?? "").split(separator: "\n", omittingEmptySubsequences: false).count
      return Rect(x: c.x, y: c.y, w: Metrics.backWidth, h: max(Metrics.backMinHeight, Double(lines + 2) * Metrics.grid))
    }
    turn = { [unowned self] in turned = $0 }
  }

  // MARK: hits

  public func card(at p: Point) -> Card? {
    if let t = turned, let c = board.card(t), drawnRect(c).contains(p.x, p.y) { return c }
    return board.cards.last { $0.id != turned && drawnRect($0).contains(p.x, p.y) }
  }

  public func lane(at p: Point) -> Lane? { board.lanes.last { $0.rect.contains(p.x, p.y) } }

  /// The corner every card has, which a double-click turns.
  public func hitsFold(_ c: Card, _ p: Point) -> Bool {
    let r = drawnRect(c)
    return r.contains(p.x, p.y) && p.x > r.x + r.w - Metrics.fold && p.y > r.y + r.h - Metrics.fold
  }

  /// The resize corner of lane `l`.
  public static func hitsCorner(_ l: Lane, _ p: Point) -> Bool { p.x > l.x + l.w - 20 && p.y > l.y + l.h - 20 }

  /// How far what the pointer holds floats off the grid, as this device draws it.
  public var floating: Records.Floating? {
    switch drag?.kind {
    case .cards?, .lane?: .moved(held.offset.dx, held.offset.dy)
    case .resize?: .resized(held.growth.dx, held.growth.dy)
    default: nil
    }
  }

  // MARK: gestures

  public func press(at p: Point, clickCount: Int = 1, shift: Bool = false, option: Bool = false) {
    // on the screen, as the web app notes a press, not on the board
    let cam = camera()
    flight.note(.input, "press", ["x": .number((p.x * cam.zoom + cam.x).rounded()), "y": .number((p.y * cam.zoom + cam.y).rounded()),
                                  "clicks": .number(Double(clickCount))])
    pointer = p
    let hit = card(at: p)
    // a lane by its corner or header, top first, as its body is the board's and hides no lane under it
    let handle = board.lanes.last { $0.rect.contains(p.x, p.y) && (Self.hitsCorner($0, p) || p.y < $0.y + Metrics.laneHeader) }
    if let id = hit?.id ?? handle?.id, taken().contains(id) { return }
    if let t = turned, hit?.id != t { turn(nil) }
    if clickCount == 2 {
      guard let c = hit, hitsFold(c, p) else { return onDoubleClick(p) }
      selection = [c.id]
      return turn(turned == c.id ? nil : c.id)
    }
    if let c = hit {
      if shift {
        selection.formSymmetricDifference([c.id])
        return
      }
      if option {
        selection = Set(board.pile(c.id, heightOf: heightOf))
      } else if !selection.contains(c.id) {
        selection = [c.id]
      }
      let held = board.cards.filter { selection.contains($0.id) }
      model.begin()
      hold(Set(held.map(\.id)))
      drag = Drag(kind: .cards, id: c.id, start: p, origins: held.map { Origin(id: $0.id, x: $0.x, y: $0.y) },
                  room: Room(base: board.layout(excluding: Set(held.map(\.id))), heightOf: heightOf))
      return
    }
    if let l = handle {
      if Self.hitsCorner(l, p) {
        selection = [l.id]
        model.begin()
        hold([l.id])
        drag = Drag(kind: .resize, id: l.id, start: p, size: Vector(dx: l.w, dy: l.h))
        return
      }
      if p.y < l.y + Metrics.laneHeader {
        if shift {
          selection.formSymmetricDifference([l.id])
          return
        }
        selection = [l.id]
        let carried = board.cardsInLane(l.id, heightOf: heightOf).map { Origin(id: $0.id, x: $0.x, y: $0.y) }
        if carried.contains(where: { taken().contains($0.id) }) { return }
        model.begin()
        hold(Set([l.id] + carried.map(\.id)))
        drag = Drag(kind: .lane, id: l.id, start: p, origins: carried, laneOrigin: Origin(id: l.id, x: l.x, y: l.y))
        return
      }
    }
    if !shift { selection = [] }
    drag = Drag(kind: .marquee, start: p, base: selection)
  }

  /// Carries the drag to world point `p`.
  public func dragged(to p: Point) {
    if !planted("stale-hover") { pointer = p }
    guard var d = drag else { return }
    let dx = p.x - d.start.x
    let dy = p.y - d.start.y
    // a box starts on any move, as the web app draws one there
    if !d.moved && hypot(dx, dy) * zoom() > (d.kind == .marquee ? 0 : 3) {
      d.moved = true
      // named as the web app names a drag's action; a box's ids are those it adds to
      let action = switch d.kind { case .cards: "move"; case .lane: "lane"; case .resize: "resize"; case .marquee: "marquee" }
      let ids = d.kind == .marquee ? d.base.count : selection.count
      flight.note(.transition, "drag", ["action": .string(action), "ids": .number(Double(ids))])
      switch d.kind {
      case .cards:
        raised = Set(d.origins.map(\.id))
        held.ids = raised
      case .lane: held.ids = Set([d.id!] + d.origins.map(\.id))
      case .resize: held.ids = [d.id!]
      case .marquee: break
      }
    }
    drag = d
    if d.kind == .marquee {
      let r = Rect(x: min(d.start.x, p.x), y: min(d.start.y, p.y), w: abs(dx), h: abs(dy))
      marquee = r
      selection = d.base.union(board.cardsInRect(r, heightOf: heightOf).map(\.id))
      return
    }
    guard d.moved else { return }
    // what the pointer holds follows it exactly, set before the board's change lays it out
    func offset(_ o: Origin, _ x: Double?, _ y: Double?) -> Vector {
      guard let x, let y else { return .zero }
      return Vector(dx: o.x + dx - x, dy: o.y + dy - y)
    }
    let before = (board, held)
    switch d.kind {
    case .cards:
      let o = d.origins[0]
      model.update {
        $0.moveCards(d.origins, dx: dx, dy: dy, room: d.room)
        held.offset = offset(o, $0.card(o.id)?.x, $0.card(o.id)?.y)
      }
    case .lane:
      guard let o = d.laneOrigin else { break }
      model.update {
        $0.moveLane(o, cards: d.origins, dx: dx, dy: dy)
        held.offset = offset(o, $0.lane(o.id)?.x, $0.lane(o.id)?.y)
      }
    case .resize:
      guard let id = d.id else { break }
      model.update {
        $0.resizeLane(id, w: d.size.dx + dx, h: d.size.dy + dy)
        if let l = $0.lane(id) {
          held.growth = Vector(dx: max(Metrics.laneMin, d.size.dx + dx) - l.w, dy: max(Metrics.laneMin, d.size.dy + dy) - l.h)
        }
      }
    case .marquee: break
    }
    if board == before.0 && held != before.1 { onFloat() }
  }

  public func release() {
    guard let d = drag else { return }
    flight.note(.input, "release")
    drag = nil
    marquee = nil
    // what was held springs from the pointer to its place on the grid
    raised = []
    held = Grip()
    switch d.kind {
    case .cards:
      if d.moved, let room = d.room {
        model.update { $0.land(Set(d.origins.map(\.id)), room: room) }
        onLand()
      } else if let id = d.id {
        selection = [id]
      }
      model.end("Move")
    case .lane: model.end("Move Lane")
    case .resize: model.end("Resize Lane")
    case .marquee: break
    }
  }

  /// The pointer moved to `p` without a press, or left the board with nil.
  public func hover(at p: Point?) { pointer = p }

  // MARK: keys

  /// A key on the board, by AppKit's key code or by character; false when the board does not take it.
  @discardableResult public func key(code: UInt16, chars: String) -> Bool {
    switch (code, chars) {
    case (49, _): turnCard()
    case (53, _): if turned != nil { turn(nil) } else { selection = [] }
    case (51, _), (117, _): deleteSelection()
    case (_, "1"), (_, "2"), (_, "3"), (_, "4"), (_, "5"): setColor(Int(chars)!)
    default: return false
    }
    return true
  }

  /// Space: turns over the card under the pointer, else the selected one; turns back the one in hand.
  public func turnCard() {
    let ids = Array(selection)
    let id = hovered ?? (ids.count == 1 && board.card(ids[0]) != nil ? ids[0] : nil)
    turn(id == turned ? nil : id)
  }

  public func deleteSelection() {
    guard !selection.isEmpty else { return }
    let ids = selection
    if let t = turned, ids.contains(t) { turned = nil }
    model.begin()
    model.update { $0.remove(ids) }
    model.update { $0.gravity(heightOf) }
    model.end("Delete")
    selection = []
  }

  /// The selected cards as a clip, nil when none is a card.
  public func copySelection(board id: String) -> Clip? {
    guard let c = board.clip(board: id, ids: selection, heightOf: heightOf) else { return nil }
    flight.note(.transition, "copy", ["ids": .number(Double(c.cards.count))])
    return c
  }

  /// Copies the selected cards and removes them, lanes staying.
  public func cutSelection(board id: String) -> Clip? {
    guard !model.inGesture, let c = copySelection(board: id) else { return nil }
    let ids = Set(c.cards.map(\.id))
    if let t = turned, ids.contains(t) { turned = nil }
    model.begin()
    model.update { $0.remove(ids) }
    model.update { $0.gravity(heightOf) }
    model.end("Cut")
    selection = []
    flight.note(.transition, "cut", ["ids": .number(Double(ids.count))])
    return c
  }

  /// Puts `clip` on the board near `centre` and selects the copies; nothing during a drag.
  public func paste(_ clip: Clip, board id: String, centre: Point) {
    turned = nil
    guard !model.inGesture else { return }
    var ids: [String] = []
    model.perform("Paste") { ids = $0.paste(clip, board: id, centre: centre, heightOf: heightOf) }
    guard !ids.isEmpty else { return }
    flight.note(.transition, "paste", ["ids": .number(Double(ids.count))])
    selection = Set(ids)
  }

  public func setColor(_ color: Int) {
    let ids = selection
    model.perform("Colour") { $0.setColor(ids, color) }
  }

  /// Someone else got there first with `ids`: a drag holding any of them goes back as it began. False when no drag
  /// holds them.
  @discardableResult public func refused(_ ids: Set<String>) -> Bool {
    guard let d = drag, d.kind != .marquee,
          !ids.isDisjoint(with: held.ids.union(d.origins.map(\.id)).union([d.id].compactMap { $0 })) else { return false }
    cancel()
    return true
  }

  /// Ends the drag, putting the board back as it began.
  public func cancel() {
    guard let d = drag else { return }
    drag = nil
    marquee = nil
    raised = []
    held = Grip()
    if d.kind != .marquee { model.cancel() }
  }
}

/// What a device shows of its board, the same in both languages, for tests that drive one device and look at another.
public struct Scene: Codable, Equatable, Sendable {
  public struct Item: Codable, Equatable, Sendable {
    public var id: String
    public var x: Double
    public var y: Double
    public var w: Double
    public var h: Double
    public var selected: Bool
    public var held: Bool
    /// Cards only: lifted by a drag.
    public var raised: Bool?
    public var color: Int?
    public var text: String?
    public var title: String?
  }

  /// Where the view looks: the screen point of the world's origin, and the zoom.
  public struct Camera: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var zoom: Double

    public init(x: Double, y: Double, zoom: Double) {
      self.x = x
      self.y = y
      self.zoom = zoom
    }
  }

  public var cards: [Item]
  public var lanes: [Item]
  public var turned: String?
  public var marquee: Rect?
  public var camera: Camera

  enum CodingKeys: String, CodingKey { case cards, lanes, turned, marquee, camera }

  public init(cards: [Item], lanes: [Item], turned: String?, marquee: Rect?, camera: Camera) {
    self.cards = cards
    self.lanes = lanes
    self.turned = turned
    self.marquee = marquee
    self.camera = camera
  }

  /// `turned` and `marquee` as null when there is none, as the web has them.
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(cards, forKey: .cards)
    try c.encode(lanes, forKey: .lanes)
    try c.encode(turned, forKey: .turned)
    try c.encode(marquee, forKey: .marquee)
    try c.encode(camera, forKey: .camera)
  }
}

extension Rect: Codable {
  enum CodingKeys: String, CodingKey { case x, y, w, h }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    self.init(x: try c.decode(Double.self, forKey: .x), y: try c.decode(Double.self, forKey: .y),
              w: try c.decode(Double.self, forKey: .w), h: try c.decode(Double.self, forKey: .h))
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(x, forKey: .x)
    try c.encode(y, forKey: .y)
    try c.encode(w, forKey: .w)
    try c.encode(h, forKey: .h)
  }
}

extension CanvasCore {
  /// Where each item is drawn: what the pointer holds floats off the grid.
  public var scene: Scene {
    let cards = board.cards.map { c in
      var r = drawnRect(c)
      let isHeld = held.ids.contains(c.id)
      if isHeld {
        r.x += held.offset.dx
        r.y += held.offset.dy
      }
      return Scene.Item(id: c.id, x: r.x, y: r.y, w: r.w, h: r.h, selected: selection.contains(c.id), held: isHeld,
                        raised: raised.contains(c.id), color: c.color, text: c.text)
    }
    let lanes = board.lanes.map { l in
      let isHeld = held.ids.contains(l.id)
      let (o, g) = isHeld ? (held.offset, held.growth) : (.zero, .zero)
      return Scene.Item(id: l.id, x: l.x + o.dx, y: l.y + o.dy, w: l.w + g.dx, h: l.h + g.dy, selected: selection.contains(l.id),
                        held: isHeld, title: l.title)
    }
    return Scene(cards: cards, lanes: lanes, turned: turned, marquee: marquee, camera: camera())
  }
}
