import AppKit
import BreezyKit

struct Drag {
  enum Kind { case cards, lane, resize, marquee }
  var kind: Kind
  var id: String?
  var start: NSPoint
  var origins: [Origin] = []
  var laneOrigin: Origin?
  var size = NSSize.zero
  var base: Set<String> = []
  var room: Room?
  var moved = false
}

extension CanvasView {
  override func mouseMoved(with event: NSEvent) {
    hovered = card(at: world(event))?.id
  }

  override func mouseDown(with event: NSEvent) {
    endEditing()
    window?.makeFirstResponder(self)
    let p = world(event)
    let shift = event.modifierFlags.contains(.shift)
    let option = event.modifierFlags.contains(.option)
    let hit = card(at: p)
    if let t = turned, hit?.id != t { turn(nil) }
    if event.clickCount == 2 { return doubleClick(at: p) }
    if let c = hit {
      if hitsFold(c, p) {
        selection = [c.id]
        return turn(turned == c.id ? nil : c.id)
      }
      if shift {
        selection.formSymmetricDifference([c.id])
        return
      }
      if option {
        selection = Set(board.pile(c.id, heightOf: height))
      } else if !selection.contains(c.id) {
        selection = [c.id]
      }
      let held = board.cards.filter { selection.contains($0.id) }
      model.begin()
      drag = Drag(kind: .cards, id: c.id, start: p, origins: held.map { Origin(id: $0.id, x: $0.x, y: $0.y) },
                  room: Room(base: board.layout(excluding: Set(held.map(\.id))), heightOf: height))
      return
    }
    if let l = lane(at: p) {
      let r = l.rect
      if p.x > r.x + r.w - 20 && p.y > r.y + r.h - 20 {
        selection = [l.id]
        model.begin()
        drag = Drag(kind: .resize, id: l.id, start: p, size: NSSize(width: r.w, height: r.h))
        return
      }
      if p.y < r.y + Metrics.laneHeader {
        if shift {
          selection.formSymmetricDifference([l.id])
          return
        }
        selection = [l.id]
        let carried = board.cardsInLane(l.id, heightOf: height).map { Origin(id: $0.id, x: $0.x, y: $0.y) }
        model.begin()
        drag = Drag(kind: .lane, id: l.id, start: p, origins: carried, laneOrigin: Origin(id: l.id, x: l.x, y: l.y))
        return
      }
    }
    if !shift { selection = [] }
    drag = Drag(kind: .marquee, start: p, base: selection)
  }

  override func mouseDragged(with event: NSEvent) {
    guard drag != nil else { return }
    dragPoint = event.locationInWindow
    dragged()
    edgeScroll()
  }

  /// Carries the drag to where the pointer is; the board may have scrolled under it.
  private func dragged() {
    guard var d = drag, let w = dragPoint else { return }
    let p = world(at: w)
    let dx = Double(p.x - d.start.x)
    let dy = Double(p.y - d.start.y)
    if d.kind == .marquee {
      let r = Rect(x: min(d.start.x, p.x), y: min(d.start.y, p.y), w: abs(dx), h: abs(dy))
      marquee.frame = doc(r)
      if marquee.isHidden {
        // coloured as it appears: the appearance callback does not come at launch
        tintMarquee()
        marquee.isHidden = false
      }
      selection = d.base.union(board.cardsInRect(r, heightOf: height).map(\.id))
      return
    }
    if !d.moved && hypot(dx, dy) * zoom > 3 {
      d.moved = true
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
    guard d.moved else { return }
    // what the pointer holds follows it exactly, set before the board's change lays it out
    func offset(_ o: Origin, _ x: Double?, _ y: Double?) -> CGSize {
      guard let x, let y else { return .zero }
      return CGSize(width: o.x + dx - x, height: o.y + dy - y)
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
        $0.resizeLane(id, w: d.size.width + dx, h: d.size.height + dy)
        if let l = $0.lane(id) {
          held.growth = CGSize(width: max(Metrics.laneMin, d.size.width + dx) - l.w, height: max(Metrics.laneMin, d.size.height + dy) - l.h)
        }
      }
    case .marquee: break
    }
    if board == before.0 && held != before.1 {
      placeLanes()
      layoutCards()
    }
  }

  /// Near or past the edge of the visible area a drag scrolls the board, slowly at first and
  /// faster the longer it stays there, as in Freeform.
  private func edgeScroll() {
    // a press that has not become a drag yet stays put
    guard let d = drag, d.moved || d.kind == .marquee, edgeDirection() != nil else { return stopEdgeScroll() }
    guard edgeScrolling == nil else { return }
    let link = displayLink(target: self, selector: #selector(edgeTick(_:)))
    link.add(to: .main, forMode: .common)
    let now = CACurrentMediaTime()
    edgeScrolling = (link, now, now)
  }

  func stopEdgeScroll() {
    edgeScrolling?.link.invalidate()
    edgeScrolling = nil
  }

  /// Which way the board scrolls for a pointer within `EdgeScroll.zone` points of an edge.
  private func edgeDirection() -> CGVector? {
    guard let clip = enclosingScrollView?.contentView, let p = dragPoint else { return nil }
    let a = clip.convert(clip.bounds, to: nil)
    let zone = CGFloat(EdgeScroll.zone)
    func dir(_ v: CGFloat, _ lo: CGFloat, _ hi: CGFloat) -> CGFloat { v - lo <= zone ? -1 : hi - v <= zone ? 1 : 0 }
    // the window's y grows upwards, the board's downwards
    let v = CGVector(dx: dir(p.x, a.minX, a.maxX), dy: -dir(p.y, a.minY, a.maxY))
    return v == .zero ? nil : v
  }

  @objc private func edgeTick(_ link: CADisplayLink) {
    guard var e = edgeScrolling, let dir = edgeDirection(), let sv = enclosingScrollView else { return stopEdgeScroll() }
    let ms = min(64, max(0, (link.timestamp - e.last) * 1000))
    e.last = link.timestamp
    edgeScrolling = e
    let d = CGFloat(EdgeScroll.speed(heldMs: (link.timestamp - e.since) * 1000) * ms) / zoom
    let clip = sv.contentView
    var b = clip.bounds
    b.origin.x += dir.dx * d
    b.origin.y += dir.dy * d
    clip.scroll(to: clip.constrainBoundsRect(b).origin)
    sv.reflectScrolledClipView(clip)
    dragged()
  }

  override func mouseUp(with event: NSEvent) {
    guard let d = drag else { return }
    drag = nil
    dragPoint = nil
    stopEdgeScroll()
    marquee.isHidden = true
    // what was held springs from the pointer to its place on the grid
    raised = []
    held = Held()
    switch d.kind {
    case .cards:
      if d.moved, let room = d.room {
        model.update { $0.land(Set(d.origins.map(\.id)), room: room) }
        NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now)
      } else if let id = d.id {
        selection = [id]
      }
      model.end("Move")
    case .lane: model.end("Move Lane")
    case .resize: model.end("Resize Lane")
    case .marquee: break
    }
    placeLanes()
    layoutCards()
  }

  /// The folded corner, which turns the card over.
  func hitsFold(_ c: Card, _ p: NSPoint) -> Bool {
    let ear = c.id == turned ? 24.0 : ((c.notes ?? "").isEmpty ? 0 : 16)
    let r = drawnRect(c)
    return ear > 0 && p.x > r.x + r.w - ear && p.y > r.y + r.h - ear
  }

}
