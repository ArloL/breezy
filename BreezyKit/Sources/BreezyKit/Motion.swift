import Foundation

/// A spring of mass 1, set as the web prototype's Motion sets one: from how long it takes to look
/// settled and how much it overshoots.
public struct Spring: Equatable, Sendable {
  public var stiffness: Double
  public var damping: Double

  public init(stiffness: Double, damping: Double) {
    self.stiffness = stiffness
    self.damping = damping
  }

  public init(visualDuration d: Double, bounce: Double = 0) {
    let k = pow(2 * .pi / (1.2 * d), 2)
    self.init(stiffness: k, damping: 2 * max(1 - bounce, 0.05) * k.squareRoot())
  }

  /// Critically damped, settling in about `response` seconds, as the web camera's moves do.
  public init(response: Double) {
    let k = pow(2 * .pi / response, 2)
    self.init(stiffness: k, damping: 2 * k.squareRoot())
  }

  /// Layout moves, like UIKit's default spring.
  public static let settle = Spring(visualDuration: 0.35)
  /// A lift pops slightly, as a drag lift on iOS does.
  public static let lift = Spring(visualDuration: 0.25, bounce: 0.35)
  /// Turning a card over.
  public static let turn = Spring(visualDuration: 0.45, bounce: 0.2)
  /// The zoom capsule.
  public static let bar = Spring(visualDuration: 0.35, bounce: 0.15)
  /// Moves the app makes with the camera.
  public static let camera = Spring(response: 0.4)

  /// One step of `dt` seconds towards `target` from `value` at velocity `v` per second.
  public func step(_ value: inout Double, _ v: inout Double, to target: Double, dt: Double) {
    var left = dt
    while left > 0 {
      let h = min(left, 0.004)
      v += (-stiffness * (value - target) - damping * v) * h
      value += v * h
      left -= h
    }
  }

  /// Progress from 0 to 1 sampled `fps` times a second, until it has settled.
  public func curve(fps: Double = 120) -> [Double] {
    var x = 0.0, v = 0.0, out = [0.0]
    while abs(1 - x) > 1e-3 || abs(v) > 1e-2 {
      step(&x, &v, to: 1, dt: 1 / fps)
      out.append(x)
    }
    out[out.count - 1] = 1
    return out
  }
}

/// Edge auto-scroll, as measured in Freeform: a narrow zone; a crawl for most of a second, then a
/// sharp speed-up.
public enum EdgeScroll {
  public static let zone = 24.0
  /// Speeds in pt/ms by milliseconds held, from the distances Freeform scrolled after 0.25 to 0.9 s.
  private static let curve: [(ms: Double, speed: Double)] = [(0, 0.045), (375, 0.085), (550, 0.13), (650, 0.15), (750, 0.35), (850, 1.1), (950, 1.5)]

  /// The speed in pt/ms once the pointer has stayed in the zone for `heldMs`.
  public static func speed(heldMs: Double) -> Double {
    guard let i = curve.firstIndex(where: { $0.ms > heldMs }) else { return curve.last!.speed }
    let (t0, v0) = curve[max(i - 1, 0)], (t1, v1) = curve[i]
    return v0 + (v1 - v0) * (heldMs - t0) / (t1 - t0)
  }
}
