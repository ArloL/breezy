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

/// The relay's rules, in memory, with its frames: short ids, binary bodies to v2 sockets and JSON to older ones. What
/// sockets send is delivered when `run` is called, which also runs the timers due now, as a next turn would. `old` acts
/// as the relay before the lean sync design: UUID ids, JSON only, binary frames dropped unread.
@MainActor final class FakeRelay {
  final class Socket: LiveSocket {
    var onOpen: (() -> Void)?
    var onMessage: ((String) -> Void)?
    var onData: ((Data) -> Void)?
    var onClose: ((Int) -> Void)?
    let id: String
    weak var relay: FakeRelay?
    var authed = false
    /// 2 when its auth said so: bodies reach it as binary frames, else as JSON.
    var v = 1
    var holds: [String] = []
    /// When the relay last read a frame from it, which keeps its holds.
    var last = Date.distantPast
    /// Its network is gone without a close: nothing it sends arrives, and nothing reaches it.
    var halfOpen = false

    init(relay: FakeRelay, id: String) {
      self.relay = relay
      self.id = id
    }

    func send(_ text: String) { relay?.queue.append { [weak self] in if let self { self.relay?.received(self, text) } } }
    func sendData(_ data: Data) { relay?.queue.append { [weak self] in if let self { self.relay?.received(self, data) } } }
    func close() { relay?.queue.append { [weak self] in if let self { self.relay?.drop(self, code: nil) } } }
  }

  /// A frame a socket sent: JSON text or binary.
  struct Frame {
    var from: String
    var text: String?
    var bytes: Data?
  }

  let clock: Clock?
  let old: Bool
  var sockets: [Socket] = []
  var queue: [() -> Void] = []
  /// The space's token, set by the first `auth`.
  var token: String?
  /// Every frame received, in order.
  var frames: [Frame] = []
  var pings = 0
  /// Sockets opened so far.
  var opened = 0

  init(clock: Clock? = nil, old: Bool = false) {
    self.clock = clock
    self.old = old
  }

  private var now: Date { clock?.now ?? Date() }

  func connect(_ url: URL) -> LiveSocket {
    opened += 1
    let s = Socket(relay: self, id: old ? UUID().uuidString.lowercased() : String(opened))
    s.last = now
    sockets.append(s)
    queue.append { s.onOpen?() }
    return s
  }

  func run() {
    repeat {
      while !queue.isEmpty { queue.removeFirst()() }
      clock?.advance(0)
    } while !queue.isEmpty
  }

  /// Closes `s` from the relay's side, as a dropped network does with 1006.
  func kick(_ s: Socket, code: Int) { drop(s, code: code) }

  /// Lets `s`'s holds lapse, as after 10 s without a message.
  func lapse(_ s: Socket) {
    s.holds = []
    announce()
  }

  /// Lets the holds of those silent for over 10 s lapse, as the relay's alarm does.
  func sweep() {
    for s in sockets where s.authed && !s.holds.isEmpty && now.timeIntervalSince(s.last) > 10 { lapse(s) }
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

  /// A device's binary frame: 0x00 then the body to everyone else, or 0x01, leb(to), then the body to one.
  func received(_ s: Socket, _ data: Data) {
    guard sockets.contains(where: { $0 === s }), !s.halfOpen else { return }
    frames.append(Frame(from: s.id, bytes: data))
    guard !old else { return }
    s.last = now
    guard s.authed else { return drop(s, code: 4001) }
    guard let f = Self.parse(data) else { return }
    forward(s, bytes: f.body, text: nil, to: f.to.map { String($0) })
  }

  /// A device's frame: whom it is for, nil for everyone else, and the body; nil if malformed.
  static func parse(_ data: Data) -> (to: Int?, body: Data)? {
    let b = [UInt8](data)
    switch b.first {
    case 0: return (nil, Data(b.dropFirst()))
    case 1: return Frames.readLeb(Data(b), 1).map { ($0.value, Data(b[$0.next...])) }
    default: return nil
    }
  }

  func received(_ s: Socket, _ text: String) {
    guard sockets.contains(where: { $0 === s }), !s.halfOpen else { return }
    if text == "ping" {
      pings += 1
      queue.append { [weak s] in if let s, !s.halfOpen { s.onMessage?("pong") } }
      return
    }
    guard let m = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { return }
    frames.append(Frame(from: s.id, text: text))
    s.last = now
    guard s.authed else {
      guard m["t"] as? String == "auth", let t = m["token"] as? String, token == nil || token == t else { return drop(s, code: 4001) }
      token = t
      s.authed = true
      s.v = m["v"] as? Int == 2 && !old ? 2 : 1
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
      forward(s, bytes: nil, text: body, to: m["to"] as? String)
    }
  }

  /// A body from `s`, as bytes or base64url text, to `to` or everyone else: binary to v2 sockets, JSON to older ones.
  private func forward(_ s: Socket, bytes: Data?, text: String?, to: String?) {
    for x in others(s) where to == nil || to == x.id {
      if x.v == 2 {
        guard let body = bytes ?? text.flatMap(Base64URL.decode) else { continue }
        let frame = Frames.leb(Int(s.id)!) + body
        queue.append { [weak x] in if let x, !x.halfOpen { x.onData?(frame) } }
      } else {
        deliver(x, ["from": s.id, "body": text ?? Base64URL.encode(bytes!)])
      }
    }
  }

  /// Hands everyone else a frame `f` sent before, again.
  func resend(_ f: Frame) {
    guard let s = sockets.first(where: { $0.id == f.from }) else { return }
    if let b = f.bytes { received(s, b) } else if let t = f.text { received(s, t) }
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

/// A device from before the lean sync design on the fake relay: auth without `v`, JSON frames, and JSON bodies sealed
/// with the space key, with `colour` and without `v` or `boards`.
@MainActor final class OldDevice {
  let relay: FakeRelay
  let keys: SpaceKeys
  let name: String
  let device: String
  var id: String?
  var board: String?
  /// Bodies heard, opened.
  var heard: [(from: String, body: [String: JSONValue])] = []
  /// Bodies that opened but were not JSON.
  var unreadable = 0
  private var socket: LiveSocket?

  init(_ relay: FakeRelay, keys: SpaceKeys, name: String = "Old", device: String = newID()) {
    self.relay = relay
    self.keys = keys
    self.name = name
    self.device = device
  }

  func connect() {
    let s = relay.connect(URL(string: "wss://relay.example/")!)
    socket = s
    s.onOpen = { [unowned self] in
      s.send(#"{"t":"auth","token":"\#(Base64URL.encode(keys.relayToken))"}"#)
    }
    s.onMessage = { [unowned self] text in
      guard let m = try? JSONDecoder().decode([String: JSONValue].self, from: Data(text.utf8)) else { return }
      if m["t"]?.string == "welcome" {
        id = m["id"]?.string
      } else if m["t"]?.string == "join", let who = m["id"]?.string {
        presence(board, to: who)
      } else if let from = m["from"]?.string, let sealed = m["body"]?.string.flatMap(Base64URL.decode),
                let plain = try? keys.openLive(sealed) {
        if let b = try? JSONDecoder().decode([String: JSONValue].self, from: plain) { heard.append((from, b)) } else { unreadable += 1 }
      }
    }
  }

  func send(_ body: [String: JSONValue], to: String? = nil) {
    let sealed = try! keys.sealLive(JSONEncoder().encode(JSONValue.object(body)))
    var f: [String: JSONValue] = ["body": .string(Base64URL.encode(sealed))]
    if let to { f["to"] = .string(to) }
    socket?.send(String(decoding: try! JSONEncoder().encode(JSONValue.object(f)), as: UTF8.self))
  }

  func presence(_ board: String?, to: String? = nil) {
    self.board = board
    send([
      "t": .string("presence"), "device": .string(device), "name": .string(name),
      "colour": .string(String(format: "#%06x", Person(device: device, name: name).colour)), "board": board.map(JSONValue.string) ?? .null,
      "selection": .array([]), "cursor": .null,
    ], to: to)
  }

  /// The last body of type `t` heard.
  func last(_ t: String) -> [String: JSONValue]? { heard.last { $0.body["t"]?.string == t }?.body }
}

/// A PeerTransport that records what Direct asks of it. Answers and accepts complete at once, or on `release()` while
/// `deferred`; `onOffer` candidates are gathered while an offer is made, as a browser may.
@MainActor final class FakePeerTransport: PeerTransport {
  var onCandidate: ((String, IceCandidate?) -> Void)?
  var onState: ((String, PeerState) -> Void)?
  var onMessage: ((String, PeerMessage) -> Void)?
  var log: [String] = []
  var sent: [(id: String, message: PeerMessage)] = []
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

  var added: [IceCandidate] = []

  func add(_ peer: String, candidate: IceCandidate) {
    added.append(candidate)
    log.append("add \(peer) \(candidate.candidate)")
  }

  func send(_ peer: String, _ text: String) -> Bool {
    sent.append((peer, .text(text)))
    return true
  }

  func sendBytes(_ peer: String, _ data: Data) -> Bool {
    sent.append((peer, .bytes(data)))
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
