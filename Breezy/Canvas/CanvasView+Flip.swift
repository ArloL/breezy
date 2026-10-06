import AppKit
import BreezyKit

extension CanvasView {
  /// Space: turns over the card under the pointer, else the selected one; turns back the one in hand.
  func turnCard() {
    let ids = Array(selection)
    let id = hovered ?? (ids.count == 1 && board.card(ids[0]) != nil ? ids[0] : nil)
    turn(id == turned ? nil : id)
  }

  /// Lifts card `id` and turns it over, putting back the one in hand; nil just puts it back. The
  /// state changes at once so an editor can take focus; copies of the old faces swing away while
  /// the new faces swing in.
  func turn(_ id: String?) {
    let id = id.flatMap { board.card($0) == nil ? nil : $0 }
    guard id != turned else { return }
    let affected = [turned, id].compactMap { $0 }
    let animate = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    let ghosts = animate ? affected.compactMap { cardLayers[$0].map(ghost) } : []
    turned = id
    layoutCards()
    guard animate else { return }
    let half = 0.13
    var p = CATransform3DIdentity
    p.m34 = -1 / 1000
    for g in ghosts {
      let a = CABasicAnimation(keyPath: "transform")
      a.fromValue = p
      a.toValue = CATransform3DRotate(p, .pi / 2, 0, 1, 0)
      a.duration = half
      a.timingFunction = CAMediaTimingFunction(name: .easeIn)
      a.fillMode = .forwards
      a.isRemovedOnCompletion = false
      CATransaction.begin()
      CATransaction.setCompletionBlock { g.removeFromSuperlayer() }
      g.add(a, forKey: "flip")
      CATransaction.commit()
    }
    for cid in affected {
      guard let l = cardLayers[cid] else { continue }
      let a = CABasicAnimation(keyPath: "transform")
      a.fromValue = CATransform3DRotate(p, -.pi / 2, 0, 1, 0)
      a.toValue = p
      a.duration = half
      a.beginTime = CACurrentMediaTime() + half
      a.timingFunction = CAMediaTimingFunction(name: .easeOut)
      a.fillMode = .backwards
      l.add(a, forKey: "flip")
    }
  }

  /// A copy of card layer `l` as it looks now, for the turn animation.
  private func ghost(_ l: CardLayer) -> CALayer {
    let g = CALayer()
    g.contents = l.contents
    g.contentsScale = l.contentsScale
    g.frame = l.frame
    g.zPosition = l.zPosition + 1
    g.shadowColor = l.shadowColor
    g.shadowOpacity = l.shadowOpacity
    g.shadowRadius = l.shadowRadius
    g.shadowOffset = l.shadowOffset
    g.shadowPath = l.shadowPath
    host.layer!.addSublayer(g)
    return g
  }
}
