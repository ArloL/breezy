import AppKit
import BreezyKit

/// The scroll view's document view: draws the board held by `model` and turns pointer and key
/// input into changes on it. World coordinates, as stored in the board, are offset by `origin`.
final class CanvasView: NSView {
  static let origin: CGFloat = 834 * 24
  static let size: CGFloat = 2 * origin

  let model: BoardModel
  var board: Board { model.board }
  /// Called after every board change, for the find bar.
  var onBoardChange: (() -> Void)?

  var selection: Set<String> = [] {
    didSet {
      guard selection != oldValue else { return }
      for (id, v) in laneViews { v.selected = selection.contains(id) }
      layoutCards()
    }
  }
  /// The card showing its back.
  var turned: String?
  /// Cards held in a drag: above the others and not animated.
  var raised: Set<String> = []
  var heights: [String: Double] = [:]
  var cardLayers: [String: CardLayer] = [:]
  var pool: [CardLayer] = []
  var laneViews: [String: LaneView] = [:]
  let host = CardHostView()
  let marquee = NSView()
  var editingID: String? { nil }
  var drag: Drag?
  /// The card under the pointer, for Space.
  var hovered: String?

  init(model: BoardModel) {
    self.model = model
    super.init(frame: NSRect(x: 0, y: 0, width: Self.size, height: Self.size))
    host.frame = bounds
    addSubview(host)
    marquee.wantsLayer = true
    marquee.isHidden = true
    addSubview(marquee)
    addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self))
    model.onChange = { [weak self] _ in self?.boardChanged() }
    sync()
  }

  required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }
  override var acceptsFirstResponder: Bool { true }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  var zoom: CGFloat { enclosingScrollView?.magnification ?? 1 }

  // MARK: geometry

  func world(_ event: NSEvent) -> NSPoint {
    let p = convert(event.locationInWindow, from: nil)
    return NSPoint(x: p.x - Self.origin, y: p.y - Self.origin)
  }

  func doc(_ r: Rect) -> NSRect { NSRect(x: r.x + Self.origin, y: r.y + Self.origin, width: r.w, height: r.h) }

  var visibleWorldCentre: NSPoint { NSPoint(x: visibleRect.midX - Self.origin, y: visibleRect.midY - Self.origin) }

  /// The front's height: stacking uses it for turned cards too.
  func height(_ id: String) -> Double { heights[id] ?? 2 * Metrics.grid }

  func frontRect(_ c: Card) -> Rect { c.rect(height: height(c.id)) }

  /// Where card `c` is drawn: a turned card widens and grows to its back.
  func drawnRect(_ c: Card) -> Rect {
    c.id == turned ? Rect(x: c.x, y: c.y, w: Metrics.backWidth, h: Double(TextMetrics.backHeight(c))) : frontRect(c)
  }

  func card(at p: NSPoint) -> Card? {
    if let t = turned, let c = board.card(t), drawnRect(c).contains(p.x, p.y) { return c }
    return board.cards.last { $0.id != turned && drawnRect($0).contains(p.x, p.y) }
  }

  func lane(at p: NSPoint) -> Lane? { board.lanes.last { $0.rect.contains(p.x, p.y) } }

  // MARK: rendering

  private func boardChanged() {
    if let t = turned, board.card(t) == nil { turned = nil }
    let live = Set(board.cards.map(\.id) + board.lanes.map(\.id))
    if !selection.isSubset(of: live) { selection = selection.intersection(live) }
    sync()
    onBoardChange?()
  }

  func sync() {
    var live = Set<String>()
    for l in board.lanes {
      live.insert(l.id)
      let v = laneViews[l.id] ?? makeLaneView(l)
      v.lane = l
      v.frame = doc(l.rect)
    }
    for (id, v) in laneViews where !live.contains(id) {
      v.removeFromSuperview()
      laneViews[id] = nil
    }
    heights = Dictionary(uniqueKeysWithValues: board.cards.map { ($0.id, Double(TextMetrics.frontHeight($0.text, width: CGFloat($0.w)))) })
    layoutCards()
  }

  private func makeLaneView(_ l: Lane) -> LaneView {
    let v = LaneView(lane: l)
    addSubview(v, positioned: .below, relativeTo: host)
    laneViews[l.id] = v
    return v
  }

  /// Gives a layer to each card near the viewport and takes it back from the rest, so the cost of
  /// scrolling and the memory follow what is on screen, not the size of the board. Moves animate
  /// with one easing curve, except for cards just shown or held by the pointer.
  func layoutCards() {
    let scale = (window?.backingScaleFactor ?? 2) * pow(2, log2(zoom).rounded(.up))
    let v = visibleRect
    let near = v.insetBy(dx: -v.width / 4, dy: -v.height / 4)
    let dark = effectiveAppearance.isDark
    CATransaction.begin()
    CATransaction.setAnimationDuration(0.22)
    CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1))
    CATransaction.setDisableActions(NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
    var live = Set<String>()
    for (i, c) in board.cards.enumerated() {
      let r = doc(drawnRect(c))
      guard r.intersects(near) else { continue }
      live.insert(c.id)
      let isNew = cardLayers[c.id] == nil
      let l = cardLayers[c.id] ?? takeLayer(c.id)
      l.zPosition = CGFloat(i) + (raised.contains(c.id) ? 1e6 : 0) + (c.id == turned ? 2e6 : 0)
      if isNew || raised.contains(c.id) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        l.frame = r
        CATransaction.commit()
      } else {
        l.frame = r
      }
      let look = CardLayer.Look(card: c, back: c.id == turned, editing: c.id == editingID, dark: dark)
      l.configure(look, selected: selection.contains(c.id), scale: scale, appearance: effectiveAppearance)
    }
    for (id, l) in cardLayers where !live.contains(id) {
      l.recycle()
      cardLayers[id] = nil
      if pool.count < 64 { pool.append(l) }
    }
    CATransaction.commit()
  }

  private func takeLayer(_ id: String) -> CardLayer {
    let l = pool.popLast() ?? CardLayer()
    host.layer!.addSublayer(l)
    cardLayers[id] = l
    return l
  }

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    marquee.layer?.borderColor = Theme.cg(Theme.accent, in: effectiveAppearance)
    marquee.layer?.backgroundColor = Theme.cg(Theme.accent.withAlphaComponent(0.08), in: effectiveAppearance)
    layoutCards()
  }
}
