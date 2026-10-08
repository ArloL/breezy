import AppKit
import BreezyKit

extension Spring {
  func animation(_ keyPath: String) -> CASpringAnimation {
    let a = CASpringAnimation(keyPath: keyPath)
    a.mass = 1
    a.stiffness = stiffness
    a.damping = damping
    a.duration = a.settlingDuration
    return a
  }

  static var reduced: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
}

extension CALayer {
  private static var moves = 0

  /// Shows the layer `delta` away from where it now is and springs it there. Springs add up, so a
  /// move that changes its mind redirects smoothly.
  func springMove(from delta: CGSize) {
    guard delta != .zero else { return }
    let a = Spring.settle.animation("position")
    a.isAdditive = true
    a.fromValue = NSValue(point: NSPoint(x: delta.width, y: delta.height))
    a.toValue = NSValue(point: .zero)
    Self.moves += 1
    add(a, forKey: "move\(Self.moves)")
  }

  func stopMoving() {
    for k in animationKeys() ?? [] where k.hasPrefix("move") { removeAnimation(forKey: k) }
  }

  /// Scales by `s` about the layer's centre, wherever its anchor is.
  func scaledAboutCentre(_ s: CGFloat) -> CATransform3D {
    let dx = (0.5 - anchorPoint.x) * bounds.width, dy = (0.5 - anchorPoint.y) * bounds.height
    return CATransform3DTranslate(CATransform3DScale(CATransform3DMakeTranslation(dx, dy, 0), s, s, 1), -dx, -dy, 0)
  }

  /// Grows in from 0.9× while fading in.
  func appear() {
    let f = CABasicAnimation(keyPath: "opacity")
    f.fromValue = 0
    f.toValue = 1
    f.duration = 0.2
    add(f, forKey: "appear-fade")
    let s = Spring.settle.animation("transform")
    s.fromValue = NSValue(caTransform3D: CATransform3DConcat(scaledAboutCentre(0.9), transform))
    s.toValue = NSValue(caTransform3D: transform)
    add(s, forKey: "appear-grow")
  }

  /// Shrinks to 0.9× and fades out, then `done`.
  func vanish(_ done: @escaping () -> Void) {
    CATransaction.begin()
    CATransaction.setCompletionBlock(done)
    let f = CABasicAnimation(keyPath: "opacity")
    f.toValue = 0
    f.duration = 0.2
    let s = Spring.settle.animation("transform")
    s.toValue = NSValue(caTransform3D: CATransform3DConcat(scaledAboutCentre(0.9), transform))
    for a in [f, s] as [CAPropertyAnimation] {
      a.fillMode = .forwards
      a.isRemovedOnCompletion = false
      add(a, forKey: "vanish-\(a.keyPath!)")
    }
    CATransaction.commit()
  }
}
