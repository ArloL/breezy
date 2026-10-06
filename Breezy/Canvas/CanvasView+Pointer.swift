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
      raised = Set(held.map(\.id))
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
    guard var d = drag else { return }
    autoscroll(with: event)
    let p = world(event)
    let dx = Double(p.x - d.start.x)
    let dy = Double(p.y - d.start.y)
    if d.kind == .marquee {
      let r = Rect(x: min(d.start.x, p.x), y: min(d.start.y, p.y), w: abs(dx), h: abs(dy))
      marquee.frame = doc(r)
      marquee.isHidden = false
      selection = d.base.union(board.cardsInRect(r, heightOf: height).map(\.id))
      return
    }
    d.moved = d.moved || hypot(dx, dy) * zoom > 3
    drag = d
    guard d.moved else { return }
    switch d.kind {
    case .cards: model.update { $0.moveCards(d.origins, dx: dx, dy: dy, room: d.room) }
    case .lane: if let o = d.laneOrigin { model.update { $0.moveLane(o, cards: d.origins, dx: dx, dy: dy) } }
    case .resize: if let id = d.id { model.update { $0.resizeLane(id, w: d.size.width + dx, h: d.size.height + dy) } }
    case .marquee: break
    }
  }

  override func mouseUp(with event: NSEvent) {
    guard let d = drag else { return }
    drag = nil
    marquee.isHidden = true
    switch d.kind {
    case .cards:
      raised = []
      if d.moved, let room = d.room {
        model.update { $0.land(Set(d.origins.map(\.id)), room: room) }
      } else if let id = d.id {
        selection = [id]
      }
      model.end("Move")
      layoutCards()
    case .lane: model.end("Move Lane")
    case .resize: model.end("Resize Lane")
    case .marquee: break
    }
  }

  /// The folded corner, which turns the card over.
  func hitsFold(_ c: Card, _ p: NSPoint) -> Bool {
    let ear = c.id == turned ? 24.0 : ((c.notes ?? "").isEmpty ? 0 : 16)
    let r = drawnRect(c)
    return ear > 0 && p.x > r.x + r.w - ear && p.y > r.y + r.h - ear
  }

}
