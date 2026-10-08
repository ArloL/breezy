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
  /// state changes at once so an editor can take focus; the card turns in one springy flip, copies
  /// of the old faces showing until halfway and the new faces after.
  func turn(_ id: String?) {
    let id = id.flatMap { board.card($0) == nil ? nil : $0 }
    guard id != turned else { return }
    let affected = [turned, id].compactMap { $0 }
    let animate = !Spring.reduced
    let ghosts = animate ? affected.compactMap { cardLayers[$0].map(ghost) } : []
    turned = id
    layoutCards()
    guard animate else { return }
    let curve = Spring.turn.curve()
    let duration = Double(curve.count - 1) / 120
    // each face shows only on its side of halfway
    let half = Double(curve.firstIndex { $0 >= 0.5 }!) / Double(curve.count - 1)
    func flip(_ l: CALayer, from: CGFloat, to: CGFloat, shown: [Float]) -> CAAnimationGroup {
      var p = l.transform
      p.m34 = -1 / 1000
      let turn = CAKeyframeAnimation(keyPath: "transform")
      turn.values = curve.map { NSValue(caTransform3D: CATransform3DRotate(p, from + (to - from) * $0, 0, 1, 0)) }
      let face = CAKeyframeAnimation(keyPath: "opacity")
      face.values = shown
      face.keyTimes = [0, NSNumber(value: half), 1]
      face.calculationMode = .discrete
      let g = CAAnimationGroup()
      g.animations = [turn, face]
      g.duration = duration
      return g
    }
    for g in ghosts {
      CATransaction.begin()
      CATransaction.setCompletionBlock { g.removeFromSuperlayer() }
      let a = flip(g, from: 0, to: .pi, shown: [1, 0])
      a.fillMode = .forwards
      a.isRemovedOnCompletion = false
      g.add(a, forKey: "flip")
      CATransaction.commit()
    }
    for cid in affected {
      guard let l = cardLayers[cid] else { continue }
      l.add(flip(l, from: -.pi, to: 0, shown: [0, 1]), forKey: "flip")
    }
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
