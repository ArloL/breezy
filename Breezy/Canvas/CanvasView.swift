import AppKit
import BreezyKit
import IOSurface

/// The scroll view's document view: draws the board held by `model` and turns pointer and key
/// input into changes on it. World coordinates, as stored in the board, are offset by `origin`.
final class CanvasView: NSView, NSTextViewDelegate, NSTextFieldDelegate {
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
  var editing: CardEditing?
  var renaming: (id: String, field: NSTextField)?
  var editingID: String? { editing?.id }
  var drag: Drag?
  /// The card under the pointer, for Space.
  var hovered: String?
  /// Brings cards off screen to the current scale once a zoom has settled.
  var settling: DispatchWorkItem?
  /// The elements last handed out, kept alive while assistive apps query them.
  var accessibilityElements: [NSAccessibilityElement] = []

  init(model: BoardModel) {
    self.model = model
    super.init(frame: NSRect(x: 0, y: 0, width: Self.size, height: Self.size))
    host.frame = bounds
    addSubview(host)
    marquee.wantsLayer = true
    marquee.isHidden = true
    addSubview(marquee)
    addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self))
    model.onChange = { [weak self] before in self?.boardChanged(from: before) }
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

  private func boardChanged(from before: Board) {
    if let t = turned, board.card(t) == nil { turned = nil }
    let live = Set(board.cards.map(\.id) + board.lanes.map(\.id))
    if !selection.isSubset(of: live) { selection = selection.intersection(live) }
    sync(from: before)
    onBoardChange?()
  }

  /// Brings lanes, card heights and card layers in line with the board; heights are measured
  /// again only for cards whose text or width differ from `before`.
  func sync(from before: Board? = nil) {
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
    func measure(_ c: Card) -> Double { Double(TextMetrics.frontHeight(c.text, width: CGFloat(c.w))) }
    if let prev = before?.cards, prev.count == board.cards.count, zip(prev, board.cards).allSatisfy({ $0.id == $1.id }) {
      for (p, c) in zip(prev, board.cards) where p.text != c.text || p.w != c.w { heights[c.id] = measure(c) }
    } else {
      heights = Dictionary(uniqueKeysWithValues: board.cards.map { ($0.id, measure($0)) })
    }
    if let e = editing, let c = board.card(e.id) { e.view.frame = editorFrame(c, back: e.back) }
    layoutCards()
  }

  private func makeLaneView(_ l: Lane) -> LaneView {
    let v = LaneView(lane: l)
    addSubview(v, positioned: .below, relativeTo: host)
    laneViews[l.id] = v
    return v
  }

  override func layout() {
    super.layout()
    layoutCards()
  }

  /// Gives a layer to each card near the viewport and takes it back from the rest, so the cost of
  /// scrolling and the memory follow what is on screen, not the size of the board. Moves animate
  /// with one easing curve, except for cards just shown or held by the pointer. When the scale
  /// changes, cards off screen keep their bitmaps until the zoom has settled for a moment, so a zoom
  /// step draws only what it shows; `settle` brings them all to the current scale.
  func layoutCards(settle: Bool = false) {
    // before it is in its scroll view the canvas counts as all visible; out of sight it keeps none
    guard enclosingScrollView != nil, let window, window.occlusionState.contains(.visible) else { return }
    // sharp at the current zoom, in steps of a quarter so a pinch does not redraw on every frame
    let scale = window.backingScaleFactor * max(0.25, (zoom * 4).rounded(.up) / 4)
    let v = visibleRect
    let near = v.insetBy(dx: -v.width / 4, dy: -v.height / 4)
    let dark = effectiveAppearance.isDark
    CATransaction.begin()
    CATransaction.setAnimationDuration(0.22)
    CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1))
    CATransaction.setDisableActions(NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
    var live = Set<String>()
    var lagging = false
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
      let s = isNew || settle || r.intersects(v) ? scale : l.contentsScale
      if s != scale { lagging = true }
      l.configure(look, selected: selection.contains(c.id), scale: s, appearance: effectiveAppearance)
    }
    for (id, l) in cardLayers where !live.contains(id) {
      l.recycle()
      cardLayers[id] = nil
      if pool.count < 64 { pool.append(l) }
    }
    // cards in the margin around the screen can wait a frame for their bitmaps; visible ones cannot
    let pending = cardLayers.values.filter { $0.needsDisplay() || ($0.deferred && $0.frame.intersects(v)) }
    prerender(pending.filter { $0.frame.intersects(v) })
    renderLater(pending.filter { !$0.frame.intersects(v) })
    CATransaction.commit()
    settling?.cancel()
    if lagging {
      let work = DispatchWorkItem { [weak self] in self?.layoutCards(settle: true) }
      settling = work
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
    }
  }

  /// Draws the bitmaps of several cards at once on all cores, as when a zoom step crosses to a new
  /// scale; the layers show them when Core Animation asks them to display.
  private func prerender(_ layers: [CardLayer]) {
    for l in layers where l.deferred {
      l.deferred = false
      l.setNeedsDisplay()
    }
    guard layers.count >= 4 else { return }
    let inputs = layers.map(\.input)
    let surfaces = Self.render(inputs)
    for (k, l) in layers.enumerated() {
      guard let i = inputs[k] else { continue }
      l.prepared = (i, surfaces[k])
      CardLayer.drawCount += 1
    }
  }

  /// Draws off the main thread; the layers show their bitmaps on a later frame, if they still fit.
  private func renderLater(_ layers: [CardLayer]) {
    let layers = layers.filter { !$0.deferred }
    guard !layers.isEmpty else { return }
    let inputs = layers.map(\.input)
    for l in layers { l.deferred = true }
    DispatchQueue.global(qos: .userInitiated).async {
      let surfaces = Self.render(inputs)
      DispatchQueue.main.async { [weak self] in
        for (k, l) in layers.enumerated() where l.deferred {
          l.deferred = false
          guard let i = inputs[k], l.input == i else {
            // changed while drawing: the next layout pass draws it again
            l.setNeedsDisplay()
            self?.needsLayout = true
            continue
          }
          l.prepared = (i, surfaces[k])
          l.setNeedsDisplay()
          CardLayer.drawCount += 1
        }
      }
    }
  }

  private static func render(_ inputs: [CardLayer.Input?]) -> [IOSurface?] {
    var surfaces = [IOSurface?](repeating: nil, count: inputs.count)
    surfaces.withUnsafeMutableBufferPointer { out in
      // worker threads drain no autorelease pool of their own; text drawing fills one
      DispatchQueue.concurrentPerform(iterations: inputs.count) { k in autoreleasepool { out[k] = inputs[k].flatMap(CardLayer.render) } }
    }
    return surfaces
  }

  /// Gives back every card layer and its bitmap. The window server may hold on to bitmaps it last
  /// showed; marked volatile, they stop counting against the app and the system can take them.
  func releaseCards() {
    for l in cardLayers.values {
      (l.contents as! IOSurface?)?.setPurgeable(.purgeableVolatile, oldState: nil)
      l.recycle()
    }
    cardLayers = [:]
    pool = []
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
