import Foundation

/// One sender's samples of one value, played back a little late so that it moves smoothly; see the WebRTC design.
/// Times are ms: `at` on the sender's clock, `arrival` and `now` on this device's.
public struct Track: Equatable, Sendable {
  public static let window = 2000.0
  public static let pause = 250.0
  public static let minDelay = 8.0
  public static let maxDelay = 150.0

  struct Sample: Equatable, Sendable {
    var at: Double
    var arrival: Double
    var value: [Double]
  }

  var samples: [Sample] = []
  public private(set) var offset = 0.0
  public private(set) var delay = Track.minDelay

  public init() {}

  private func recent(_ upTo: Double) -> [Sample] { samples.filter { $0.arrival > upTo - Self.window } }

  /// The lower median of the gaps between consecutive `at` up to `pause`; 0 without any.
  private static func interval(_ s: [Sample]) -> Double {
    let gaps = zip(s, s.dropFirst()).map { $1.at - $0.at }.filter { $0 <= pause }.sorted()
    return gaps.isEmpty ? 0 : gaps[(gaps.count - 1) / 2]
  }

  /// What the sender had at its time `at`, arriving at `arrival`; older than the last, it is dropped.
  public mutating func push(at: Double, arrival: Double, value: [Double]) {
    if let last = samples.last {
      guard at > last.at else { return }
      // after a pause the value sat still until just before this sample, rather than drifting all the way
      if arrival - last.arrival > Self.pause {
        let hold = at - Self.interval(recent(last.arrival))
        if hold > last.at && hold < at { samples.append(Sample(at: hold, arrival: arrival - (at - hold), value: last.value)) }
      }
    }
    samples.append(Sample(at: at, arrival: arrival, value: value))
    let r = recent(arrival)
    samples.removeFirst(max(0, samples.count - r.count - 2))
    offset = r.map { $0.arrival - $0.at }.min()!
    let late = r.map { $0.arrival - $0.at - offset }.sorted()
    let jitter = late[(late.count * 9 + 9) / 10 - 1]
    delay = min(Self.maxDelay, max(Self.minDelay, Self.interval(r) + jitter))
  }

  /// The value at `now`, played back `delay` late, between the samples either side; never past the last.
  public func sample(_ now: Double) -> [Double] {
    guard let first = samples.first, let last = samples.last else { return [] }
    let t = now - offset - delay
    if t <= first.at { return first.value }
    for i in 1..<samples.count where t < samples[i].at {
      let a = samples[i - 1], b = samples[i], k = (t - a.at) / (b.at - a.at)
      return zip(a.value, b.value).map { $0 + ($1 - $0) * k }
    }
    return last.value
  }

  /// Whether playback has yet to reach the last sample.
  public func playing(_ now: Double) -> Bool { samples.last.map { now - offset - delay < $0.at } ?? false }
}
