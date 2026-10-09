import Foundation
@testable import BreezyKit

/// Time and timers under a test's control.
@MainActor final class Clock {
  var now = Date(timeIntervalSince1970: 1_000_000)
  private var timers: [(at: Date, work: @MainActor () -> Void)] = []

  func schedule(_ delay: TimeInterval, _ work: @escaping @MainActor () -> Void) {
    timers.append((now.addingTimeInterval(delay), work))
  }

  /// Moves time on by `seconds`, running the timers due meanwhile, earliest first.
  func advance(_ seconds: TimeInterval) {
    let end = now.addingTimeInterval(seconds)
    while let i = timers.indices.filter({ timers[$0].at <= end }).min(by: { timers[$0].at < timers[$1].at }) {
      let t = timers.remove(at: i)
      now = max(now, t.at)
      t.work()
    }
    now = end
  }
}

/// The relay's rules, in memory. What sockets send is delivered when `run` is called.
@MainActor final class FakeRelay {
  final class Socket: LiveSocket {
    var onOpen: (() -> Void)?
    var onMessage: ((String) -> Void)?
    var onClose: ((Int) -> Void)?
    let id = UUID().uuidString
    weak var relay: FakeRelay?
    var authed = false
    var holds: [String] = []

    init(relay: FakeRelay) { self.relay = relay }

    func send(_ text: String) { relay?.queue.append { [weak self] in if let self { self.relay?.received(self, text) } } }
    func close() { relay?.queue.append { [weak self] in if let self { self.relay?.drop(self, code: nil) } } }
  }

  var sockets: [Socket] = []
  var queue: [() -> Void] = []
  /// The space's token, set by the first `auth`.
  var token: String?
  /// Every frame received, in order.
  var frames: [(from: String, text: String)] = []

  func connect(_ url: URL) -> LiveSocket {
    let s = Socket(relay: self)
    sockets.append(s)
    queue.append { s.onOpen?() }
    return s
  }

  func run() { while !queue.isEmpty { queue.removeFirst()() } }

  /// Closes `s` from the relay's side, as a dropped network does with 1006.
  func kick(_ s: Socket, code: Int) { drop(s, code: code) }

  /// Lets `s`'s holds lapse, as after 10 s without a message.
  func lapse(_ s: Socket) {
    s.holds = []
    announce()
  }

  private func others(_ s: Socket) -> [Socket] { sockets.filter { $0 !== s && $0.authed } }

  private func deliver(_ s: Socket, _ m: [String: Any]) {
    let text = String(decoding: try! JSONSerialization.data(withJSONObject: m), as: UTF8.self)
    queue.append { [weak s] in s?.onMessage?(text) }
  }

  private var holds: [String: [String]] {
    Dictionary(uniqueKeysWithValues: sockets.filter { $0.authed && !$0.holds.isEmpty }.map { ($0.id, $0.holds) })
  }

  private func announce() { for s in sockets where s.authed { deliver(s, ["t": "holds", "holds": holds]) } }

  func received(_ s: Socket, _ text: String) {
    guard sockets.contains(where: { $0 === s }),
          let m = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { return }
    frames.append((s.id, text))
    guard s.authed else {
      guard m["t"] as? String == "auth", let t = m["token"] as? String, token == nil || token == t else { return drop(s, code: 4001) }
      token = t
      s.authed = true
      let o = others(s)
      deliver(s, ["t": "welcome", "id": s.id, "peers": o.map(\.id), "holds": holds])
      for x in o { deliver(x, ["t": "join", "id": s.id]) }
      return
    }
    switch m["t"] as? String {
    case "hold":
      let ids = m["ids"] as? [String] ?? []
      let taken = Set(others(s).flatMap(\.holds))
      let refused = ids.filter(taken.contains)
      guard refused.isEmpty else { return deliver(s, ["t": "refused", "ids": refused]) }
      s.holds = Array(Set(s.holds + ids)).sorted()
      announce()
    case "release":
      guard !s.holds.isEmpty else { return }
      s.holds = []
      announce()
    default:
      guard let body = m["body"] as? String else { return }
      let to = m["to"] as? String
      for x in others(s) where to == nil || to == x.id { deliver(x, ["from": s.id, "body": body]) }
    }
  }

  func drop(_ s: Socket, code: Int?) {
    guard let i = sockets.firstIndex(where: { $0 === s }) else { return }
    sockets.remove(at: i)
    if s.authed {
      for x in sockets where x.authed { deliver(x, ["t": "leave", "id": s.id]) }
      if !s.holds.isEmpty { announce() }
    }
    if let code { queue.append { s.onClose?(code) } }
  }
}
