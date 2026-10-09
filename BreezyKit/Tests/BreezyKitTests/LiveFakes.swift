import Foundation
@testable import BreezyKit

/// Time and timers under a test's control.
@MainActor final class Clock {
  var now = Date(timeIntervalSinceReferenceDate: 0)
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
    /// Its network is gone without a close: nothing it sends arrives, and nothing reaches it.
    var halfOpen = false

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
  var pings = 0
  /// Sockets opened so far.
  var opened = 0

  func connect(_ url: URL) -> LiveSocket {
    let s = Socket(relay: self)
    sockets.append(s)
    opened += 1
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
    queue.append { [weak s] in if let s, !s.halfOpen { s.onMessage?(text) } }
  }

  private var holds: [String: [String]] {
    Dictionary(uniqueKeysWithValues: sockets.filter { $0.authed && !$0.holds.isEmpty }.map { ($0.id, $0.holds) })
  }

  private func announce() { for s in sockets where s.authed { deliver(s, ["t": "holds", "holds": holds]) } }

  func received(_ s: Socket, _ text: String) {
    guard sockets.contains(where: { $0 === s }), !s.halfOpen else { return }
    if text == "ping" {
      pings += 1
      queue.append { [weak s] in if let s, !s.halfOpen { s.onMessage?("pong") } }
      return
    }
    guard let m = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { return }
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

  /// Hands everyone else a frame `from` sent before, again.
  func resend(_ f: (from: String, text: String)) {
    guard let s = sockets.first(where: { $0.id == f.from }) else { return }
    received(s, f.text)
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

/// A PeerTransport that records what Direct asks of it. Answers and accepts complete at once, or on `release()` while
/// `deferred`; `onOffer` candidates are gathered while an offer is made, as a browser may.
@MainActor final class FakePeerTransport: PeerTransport {
  var onCandidate: ((String, IceCandidate?) -> Void)?
  var onState: ((String, PeerState) -> Void)?
  var onMessage: ((String, String) -> Void)?
  var log: [String] = []
  var sent: [(id: String, text: String)] = []
  var deferred = false
  var waiting: [() -> Void] = []
  var onOffer: [IceCandidate] = []
  /// Steps ("offer", "answer", "accept") that fail.
  var fail: Set<String> = []

  func create(_ peer: String) { log.append("create \(peer)") }

  func offer(_ peer: String, restart: Bool, _ done: @escaping @MainActor (String?) -> Void) {
    log.append("offer \(peer)\(restart ? " restart" : "")")
    for c in onOffer { onCandidate?(peer, c) }
    done(fail.contains("offer") ? nil : "offer-sdp \(peer)")
  }

  func answer(_ peer: String, offer: String, _ done: @escaping @MainActor (String?) -> Void) {
    log.append("answer \(peer) \(offer)")
    later { [self] in done(fail.contains("answer") ? nil : "answer-sdp \(peer)") }
  }

  func accept(_ peer: String, answer: String, _ done: @escaping @MainActor (Bool) -> Void) {
    log.append("accept \(peer) \(answer)")
    later { [self] in done(!fail.contains("accept")) }
  }

  func add(_ peer: String, candidate: IceCandidate) { log.append("add \(peer) \(candidate.candidate)") }

  func send(_ peer: String, _ text: String) -> Bool {
    sent.append((peer, text))
    return true
  }

  func close(_ peer: String) { log.append("close \(peer)") }

  private func later(_ work: @escaping () -> Void) { if deferred { waiting.append(work) } else { work() } }

  func release() {
    let w = waiting
    waiting = []
    w.forEach { $0() }
  }
}
