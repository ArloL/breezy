import AppKit
import BreezyKit

extension CanvasView {
  /// Space: turns over the card under the pointer, else the selected one; turns back the one in hand.
  func turnCard() { core.turnCard() }

  /// Turns card `id` over, putting back the one in hand; nil just puts it back. The state changes at once so an editor
  /// can take focus; each card then grows out of its front into its back, or back into its front, on the camera's
  /// spring, so that it moves as one with the pan to show it, as iOS's zoom transitions grow out of where they start.
  /// Turned again on the way, it goes back from where it is, as fast as it was going. With reduced motion its faces
  /// cross-fade at its new size.
  func turn(_ id: String?) {
    let id = id.flatMap { board.card($0) == nil ? nil : $0 }
    guard id != turned else { return }
    let affected = [turned, id].compactMap { $0 }
    turned = id
    let fade = Spring.reduced
    for cid in affected {
      let to: Double = cid == id ? 1 : 0
      turns[cid] = (turns[cid]?.p ?? 1 - to, turns[cid]?.v ?? 0, to, fade)
    }
    if turnLink == nil {
      let l = displayLink(target: self, selector: #selector(turnFrame))
      l.add(to: .main, forMode: .common)
      turnLink = (l, CACurrentMediaTime())
    }
    layoutCards()
    // an edited card's own reveal keeps it, and its caret, in sight
    if let id, editing == nil { revealTurned(id) }
  }

  @objc private func turnFrame(_ link: CADisplayLink) {
    let dt = min(0.064, max(0, link.timestamp - (turnLink?.last ?? link.timestamp)))
    turnLink?.last = link.timestamp
    for (id, var t) in turns {
      if t.fade {
        t.p += (t.to > t.p ? 1 : -1) * min(abs(t.to - t.p), dt / 0.2)
      } else {
        Spring.camera.step(&t.p, &t.v, to: t.to, dt: dt)
      }
      turns[id] = abs(t.p - t.to) < 1e-3 && abs(t.v) < 1e-2 || board.card(id) == nil ? nil : t
    }
    if turns.isEmpty {
      turnLink?.link.invalidate()
      turnLink = nil
    }
    layoutCards()
  }

  /// Card `c` drawn `p` of the way from its front, 0, to its back, 1, from its top left.
  func turningRect(_ c: Card, _ p: Double) -> Rect {
    let f = frontRect(c), w = Metrics.backWidth, h = Double(TextMetrics.backHeight(c))
    return Rect(x: c.x, y: c.y, w: f.w + (w - f.w) * p, h: f.h + (h - f.h) * p)
  }

  /// Pans the least, on the camera's spring, to show turned card `id`'s back 48 pt in from the window's edges, less
  /// where it is too small for that, as the web app does; notes the pan.
  func revealTurned(_ id: String) {
    guard let c = board.card(id), let scroll = enclosingScrollView as? BoardScrollView else { return }
    // in screen points, as the pad is
    let v = visibleRect, z = Double(zoom), r = doc(drawnRect(c))
    let area = Rect(x: v.minX * z, y: v.minY * z, w: v.width * z, h: v.height * z)
    let s = Rect(x: r.minX * z, y: r.minY * z, w: r.width * z, h: r.height * z).revealShift(in: area, pad: 48)
    guard s != Vector() else { return }
    let why = r.width * z + 32 > area.w || r.height * z + 32 > area.h ? "too big" : "fits"
    core.flight.note(.decision, "reveal", ["path": .string("back"), "why": .string(why), "pan": .array([.number(s.dx.rounded()), .number(s.dy.rounded())])])
    scroll.springScroll(to: NSPoint(x: v.minX - s.dx / z, y: v.minY - s.dy / z))
  }

  /// A copy of card layer `l` as it looks now, to turn away or shrink away.
  func ghost(_ l: CardLayer) -> CALayer {
    let g = CALayer()
    let now = l.presentation() ?? l
    g.contents = l.contents
    g.contentsScale = l.contentsScale
    g.bounds = now.bounds
    g.position = now.position
    g.transform = now.transform
    g.zPosition = l.zPosition + 1
    g.shadowColor = l.shadowColor
    g.shadowOpacity = now.shadowOpacity
    g.shadowRadius = now.shadowRadius
    g.shadowOffset = now.shadowOffset
    g.shadowPath = l.shadowPath
    host.layer!.addSublayer(g)
    return g
  }
}
