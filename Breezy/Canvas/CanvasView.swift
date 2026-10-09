import AppKit
import BreezyKit
import IOSurface

/// The cards or lane a drag holds, and how far they are drawn from where the board keeps them.
struct Held: Equatable {
  var ids: Set<String> = []
  var offset = CGSize.zero
  /// A resized lane's size beyond the grid.
  var growth = CGSize.zero
}

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
      onSelection?()
    }
  }
  /// The card showing its back.
  var turned: String?
  /// Cards lifted by a drag: above the others, a little larger.
  var raised: Set<String> = []
  /// What the pointer holds, which follows it exactly; the board keeps it on the grid, where it
  /// lands on release.
  var held = Held()
  /// Cards just added to the board, which grow in when they first show.
  var appearing: Set<String> = []
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
  /// Where the pointer is during a drag, in window coordinates.
  var dragPoint: NSPoint?
  var edgeScrolling: (link: CADisplayLink, since: CFTimeInterval, last: CFTimeInterval)?
  /// The card under the pointer, for Space.
  var hovered: String?
  /// Brings cards to the exact scale once a zoom has settled.
  var settling: DispatchWorkItem?
  /// The zoom of the last layout pass; when it changes, a zoom is under way.
  var laidOutZoom: CGFloat?
  /// The elements last handed out, kept alive while assistive apps query them.
  var accessibilityElements: [NSAccessibilityElement] = []
  /// What others do on this board.
  var presence = CanvasPresence() { didSet { if presence != oldValue { presenceChanged(from: oldValue) } } }
  let presenceView = PresenceView()
  /// This Mac's pointer over the board, in world points; nil when it left.
  var onPointer: ((NSPoint?) -> Void)?
  /// After the selection changes, for others to see.
  var onSelection: (() -> Void)?

  init(model: BoardModel) {
    self.model = model
    super.init(frame: NSRect(x: 0, y: 0, width: Self.size, height: Self.size))
    host.frame = bounds
    addSubview(host)
    marquee.wantsLayer = true
    marquee.layer?.borderWidth = 1
    marquee.isHidden = true
    addSubview(marquee)
    presenceView.frame = bounds
    addSubview(presenceView)
    addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    model.onChange = { [weak self] before in self?.boardChanged(from: before) }
    sync()
  }

  required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }
  override var acceptsFirstResponder: Bool { true }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  var zoom: CGFloat { enclosingScrollView?.magnification ?? 1 }

  // MARK: geometry

  func world(_ event: NSEvent) -> NSPoint { world(at: event.locationInWindow) }

  func world(at windowPoint: NSPoint) -> NSPoint {
    let p = convert(windowPoint, from: nil)
    return NSPoint(x: p.x - Self.origin, y: p.y - Self.origin)
  }

  func doc(_ r: Rect) -> NSRect { NSRect(x: r.x + Self.origin, y: r.y + Self.origin, width: r.w, height: r.h) }

  /// Moves a point to the nearest whole pixel on screen; one conversion for many points.
  func pixelGrid() -> (NSPoint) -> NSPoint {
    let o = convertToBacking(NSPoint.zero), u = convertToBacking(NSPoint(x: 1, y: 1))
    let kx = u.x - o.x, ky = u.y - o.y
    return { p in NSPoint(x: ((o.x + p.x * kx).rounded() - o.x) / kx, y: ((o.y + p.y * ky).rounded() - o.y) / ky) }
  }

  /// `r` moved to the nearest whole pixel on screen.
  func pixelAligned(_ r: NSRect) -> NSRect { NSRect(origin: pixelGrid()(r.origin), size: r.size) }

  var visibleWorldCentre: NSPoint { NSPoint(x: visibleRect.midX - Self.origin, y: visibleRect.midY - Self.origin) }

  /// The front's height: stacking uses it for turned cards too.
  func height(_ id: String) -> Double { heights[id] ?? 2 * Metrics.grid }

  /// Stacks `b` as this canvas would, measuring only cards whose text or width changed.
  func restack(_ b: inout Board) {
    let shown = Dictionary(board.cards.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    var h: [String: Double] = [:]
    for c in b.cards {
      let old = shown[c.id]
      h[c.id] = old?.text == c.text && old?.w == c.w ? height(c.id) : Double(TextMetrics.frontHeight(c.text, width: CGFloat(c.w)))
    }
    b.gravity { h[$0] ?? 2 * Metrics.grid }
  }

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
    if before.cards.count != board.cards.count || !zip(before.cards, board.cards).allSatisfy({ $0.id == $1.id }) {
      let now = Set(board.cards.map(\.id)), then = Set(before.cards.map(\.id))
      appearing = now.subtracting(then)
      // a deleted card shrinks and fades while the others close up
      if !Spring.reduced {
        for id in then.subtracting(now) {
          guard let l = cardLayers[id] else { continue }
          let g = ghost(l)
          g.vanish { g.removeFromSuperlayer() }
        }
      }
    }
    if let t = turned, board.card(t) == nil { turned = nil }
    let live = Set(board.cards.map(\.id) + board.lanes.map(\.id))
    if !selection.isSubset(of: live) { selection = selection.intersection(live) }
    sync(from: before)
    onBoardChange?()
  }

  /// Brings lanes, card heights and card layers in line with the board; heights are measured
  /// again only for cards whose text or width differ from `before`.
  func sync(from before: Board? = nil) {
    placeLanes(appearing: before != nil)
    func measure(_ c: Card) -> Double { Double(TextMetrics.frontHeight(c.text, width: CGFloat(c.w))) }
    if let prev = before?.cards, prev.count == board.cards.count, zip(prev, board.cards).allSatisfy({ $0.id == $1.id }) {
      for (p, c) in zip(prev, board.cards) where p.text != c.text || p.w != c.w { heights[c.id] = measure(c) }
    } else {
      heights = Dictionary(uniqueKeysWithValues: board.cards.map { ($0.id, measure($0)) })
    }
    layoutCards()
  }

  /// Places the lanes: those the pointer does not hold spring to their new places; when
  /// `appearing`, new lanes grow in and deleted ones shrink away.
  func placeLanes(appearing: Bool = false) {
    let animate = !Spring.reduced
    var live = Set<String>()
    for l in board.lanes {
      live.insert(l.id)
      let isNew = laneViews[l.id] == nil
      let v = laneViews[l.id] ?? makeLaneView(l)
      v.lane = l
      v.ringColour = (presence.taken[l.id] ?? presence.seen[l.id])?.nsColour
      let old = v.layer?.position
      v.frame = laneFrame(l)
      guard animate, let layer = v.layer else { continue }
      if isNew {
        if appearing { layer.appear() }
      } else if held.ids.contains(l.id) {
        layer.stopMoving()
      } else {
        // in the layer's coordinates, which AppKit may flip
        if let old { layer.springMove(from: CGSize(width: old.x - layer.position.x, height: old.y - layer.position.y)) }
      }
    }
    for (id, v) in laneViews where !live.contains(id) {
      laneViews[id] = nil
      if animate, appearing, let layer = v.layer {
        layer.vanish { v.removeFromSuperview() }
      } else {
        v.removeFromSuperview()
      }
    }
  }

  func laneFrame(_ l: Lane) -> NSRect {
    guard held.ids.contains(l.id) else { return doc(l.rect) }
    let r = doc(l.rect)
    return NSRect(x: r.minX + held.offset.width, y: r.minY + held.offset.height,
                  width: r.width + held.growth.width, height: r.height + held.growth.height)
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
  /// scrolling and the memory follow what is on screen, not the size of the board. Moves spring,
  /// except for cards just shown or held by the pointer; new cards grow in. While the zoom
  /// changes, bitmaps are drawn in steps of a quarter, so a pinch does not redraw on every frame,
  /// and cards off screen keep theirs, so a zoom step draws only what it shows. Once the zoom has
  /// settled for a moment, `settle` draws them all at the exact scale, one bitmap pixel per screen
  /// pixel, as the editor draws its text.
  func layoutCards(settle: Bool = false) {
    // before it is in its scroll view the canvas counts as all visible; out of sight it keeps none
    guard enclosingScrollView != nil, let window, window.occlusionState.contains(.visible) else { return }
    let backing = window.backingScaleFactor
    func step(_ scale: CGFloat) -> CGFloat { backing * max(0.25, (scale / backing * 4).rounded(.up) / 4) }
    let exact = backing * zoom
    let zooming = !settle && laidOutZoom.map { $0 != zoom } ?? false
    laidOutZoom = zoom
    let scale = zooming ? step(exact) : exact
    if let e = editing, let c = board.card(e.id) { e.view.place(editorFrame(c, back: e.back)) }
    let grid = pixelGrid()
    let v = visibleRect
    let near = v.insetBy(dx: -v.width / 4, dy: -v.height / 4)
    let dark = effectiveAppearance.isDark
    let animate = !Spring.reduced
    CATransaction.begin()
    var live = Set<String>()
    var lagging = false
    for (i, c) in board.cards.enumerated() {
      var r = doc(drawnRect(c))
      let isHeld = held.ids.contains(c.id)
      if isHeld { r = r.offsetBy(dx: held.offset.width, dy: held.offset.height) }
      guard r.intersects(near) else { continue }
      live.insert(c.id)
      let isNew = cardLayers[c.id] == nil
      let l = cardLayers[c.id] ?? takeLayer(c.id)
      l.zPosition = CGFloat(i) + (raised.contains(c.id) ? 1e6 : 0) + (c.id == turned ? 2e6 : 0)
      // cards off screen wait for the zoom to settle; on screen, a bitmap a step covers will do
      let keep = !isNew && !settle && (!r.intersects(v) || zooming && step(l.contentsScale) == scale)
      let s = keep ? l.contentsScale : scale
      if s != exact { lagging = true }
      let f = NSRect(origin: grid(r.origin), size: NSSize(width: (r.width * s).rounded(.up) / s, height: (r.height * s).rounded(.up) / s))
      // a new pixel grid moves the layer a fraction of a pixel, the card not at all; a size snaps
      let old = l.rect
      l.rect = r
      // not the frame, which a lift's scale would distort
      l.bounds = CGRect(origin: .zero, size: f.size)
      l.position = CGPoint(x: f.midX, y: f.midY)
      if isHeld {
        l.stopMoving()
      } else if animate, !isNew, let old {
        l.springMove(from: CGSize(width: old.minX - r.minX, height: old.minY - r.minY))
      }
      l.setLifted(raised.contains(c.id), animated: animate && !isNew)
      if isNew && animate && appearing.contains(c.id) { l.appear() }
      let look = CardLayer.Look(card: c, back: c.id == turned, editing: c.id == editingID, dark: dark)
      let ring: CardLayer.Ring? = selection.contains(c.id) ? CardLayer.Ring(colour: Theme.cg(Theme.accent, in: effectiveAppearance), width: 2)
        : presence.taken[c.id].map { CardLayer.Ring(colour: $0.nsColour.cgColor, width: 2) }
        ?? presence.seen[c.id].map { CardLayer.Ring(colour: $0.nsColour.cgColor, width: 1) }
      l.configure(look, size: r.size, ring: ring, scale: s, appearance: effectiveAppearance)
    }
    appearing = []
    for (id, l) in cardLayers where !live.contains(id) {
      l.recycle()
      cardLayers[id] = nil
      if pool.count < 64 { pool.append(l) }
    }
    // cards in the margin can wait a frame or two for their bitmaps, and so can visible cards that
    // only change scale, showing the old bitmap stretched; others are drawn now
    let pending = cardLayers.values.filter { $0.needsDisplay() || ($0.deferred && !$0.refining && $0.frame.intersects(v)) }
    let now = pending.filter { $0.frame.intersects(v) && !$0.refining }
    prerender(now)
    renderLater(pending.filter { !$0.frame.intersects(v) || $0.refining })
    CATransaction.commit()
    settling?.cancel()
    if lagging {
      let work = DispatchWorkItem { [weak self] in self?.layoutCards(settle: true) }
      settling = work
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
    }
    showPresence()
  }

  private func presenceChanged(from old: CanvasPresence) {
    let taken = Set(presence.taken.keys)
    if !selection.isDisjoint(with: taken) { selection.subtract(taken) }
    if presence.taken != old.taken || presence.seen != old.seen {
      placeLanes()
      layoutCards()
    } else {
      showPresence()
    }
  }

  /// Puts others' cursors and the names over what they hold where the board shows them.
  func showPresence() {
    var marks = presence.cursors.map {
      PresenceView.Mark(key: "cursor " + $0.key, kind: .cursor, person: $0.person, rect: NSRect(x: $0.x + Self.origin, y: $0.y + Self.origin, width: 0, height: 0))
    }
    for (id, person) in presence.taken {
      guard let r = board.card(id).map(drawnRect) ?? board.lane(id)?.rect else { continue }
      let d = doc(r)
      marks.append(PresenceView.Mark(key: "label " + id, kind: .label, person: person, rect: NSRect(x: d.minX - 4, y: d.minY - 6, width: 0, height: 0)))
    }
    presenceView.show(marks, zoom: zoom)
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
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let surfaces = Self.render(inputs)
      DispatchQueue.main.async {
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
    tintMarquee()
    layoutCards()
  }

  /// The selection box's colours for the current appearance.
  func tintMarquee() {
    marquee.layer?.borderColor = Theme.cg(Theme.accent, in: effectiveAppearance)
    marquee.layer?.backgroundColor = Theme.cg(Theme.accent.withAlphaComponent(0.08), in: effectiveAppearance)
  }
}
