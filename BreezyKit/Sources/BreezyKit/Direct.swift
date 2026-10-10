import Foundation

/// A candidate address for a direct connection, as WebRTC gathers it.
public struct IceCandidate: Equatable, Sendable {
  public var candidate: String
  public var mid: String?
  public var index: Int?

  public init(candidate: String, mid: String?, index: Int?) {
    self.candidate = candidate
    self.mid = mid
    self.index = index
  }
}

public enum PeerState: String, Sendable { case open, closed, failed }

public enum PeerMessage: Equatable, Sendable { case text(String), bytes(Data) }

/// WebRTC data channels to other connections, as `Direct` drives them; the app puts a web view behind it, tests a fake.
@MainActor public protocol PeerTransport: AnyObject {
  var onCandidate: ((String, IceCandidate?) -> Void)? { get set }
  var onState: ((String, PeerState) -> Void)? { get set }
  var onMessage: ((String, PeerMessage) -> Void)? { get set }
  func create(_ peer: String)
  func offer(_ peer: String, restart: Bool, _ done: @escaping @MainActor (String?) -> Void)
  func answer(_ peer: String, offer: String, _ done: @escaping @MainActor (String?) -> Void)
  func accept(_ peer: String, answer: String, _ done: @escaping @MainActor (Bool) -> Void)
  func add(_ peer: String, candidate: IceCandidate)
  @discardableResult func send(_ peer: String, _ text: String) -> Bool
  @discardableResult func sendBytes(_ peer: String, _ data: Data) -> Bool
  func close(_ peer: String)
}

/// Direct data channels to a space's other connections, beside the relay, for cursors and live edits; see the WebRTC
/// design. Offers, answers and candidates go through the relay.
@MainActor public final class Direct {
  public static let openTimeout: TimeInterval = 10
  public static let restartDelay: TimeInterval = 2
  public static let maxRestarts = 3
  /// A version 2 channel beats every tick; once its other side has beaten, this long without hearing anything closes it,
  /// as ICE takes about 30 s to notice a network that went.
  public static let silence: TimeInterval = 2.5
  /// Not compact, so devices from before the beat drop it.
  public static let beat = Data([0])

  private final class Link {
    let offerer: Bool
    var version = 1
    /// `up` is the transport's open, `open` that and not silent.
    var up = false, open = false, everOpen = false, beats = false, remote = false, ready = false, answering = false
    var since: Date, heardAt: Date
    var restarts = 0
    var restartAt: Date?
    var inbox: [IceCandidate] = []
    var outbox: [[String: JSONValue]] = []

    init(offerer: Bool, since: Date) {
      self.offerer = offerer
      self.since = since
      heardAt = since
    }
  }

  private let transport: PeerTransport
  private let now: () -> Date
  private let relay: (String, [String: JSONValue]) -> Void
  private let message: (String, PeerMessage) -> Void
  private let change: () -> Void
  private var links: [String: Link] = [:]

  /// `message` is what came direct: text on a version 1 link, bytes on a version 2 one.
  public init(transport: PeerTransport, now: @escaping () -> Date, relay: @escaping (String, [String: JSONValue]) -> Void,
              message: @escaping (String, PeerMessage) -> Void, change: @escaping () -> Void) {
    self.transport = transport
    self.now = now
    self.relay = relay
    self.message = message
    self.change = change
    transport.onCandidate = { [weak self] in self?.gathered($0, $1) }
    transport.onState = { [weak self] in self?.state($0, $1) }
    transport.onMessage = { [weak self] id, m in
      guard let self, let l = links[id], l.up else { return }
      l.heardAt = now()
      let beat = m == .bytes(Self.beat)
      if beat { l.beats = true }
      if !l.open { opened(l, true) }
      if beat { return }
      switch m {
      case .text where l.version == 1, .bytes where l.version == 2: self.message(id, m)
      default: return
      }
    }
  }

  public func isOpen(_ id: String) -> Bool { links[id]?.open ?? false }

  /// 2 when the other side's offer or answer said so, else 1.
  public func version(_ id: String) -> Int { links[id]?.version ?? 1 }

  @discardableResult public func send(_ id: String, _ text: String) -> Bool { isOpen(id) && transport.send(id, text) }

  @discardableResult public func sendBytes(_ id: String, _ data: Data) -> Bool { isOpen(id) && transport.sendBytes(id, data) }

  /// This connection is new to the space: it offers to each of `ids`, so two sides never offer at once.
  public func welcome(_ ids: [String]) {
    reset()
    for id in ids { offer(id, link(id, offerer: true)) }
  }

  private func link(_ id: String, offerer: Bool) -> Link {
    transport.create(id)
    let l = Link(offerer: offerer, since: now())
    links[id] = l
    return l
  }

  private func offer(_ id: String, _ l: Link, restart: Bool = false) {
    l.ready = false
    l.remote = false
    transport.offer(id, restart: restart) { [weak self] sdp in
      guard let self, links[id] === l else { return }
      guard let sdp else { return leave(id) }
      relay(id, ["t": .string("offer"), "sdp": .string(sdp), "v": .number(2)])
      flushOut(id, l)
    }
  }

  /// An offer, answer or candidate from connection `from`, through the relay.
  public func heard(_ from: String, _ b: [String: JSONValue]) {
    let l = links[from]
    switch b["t"]?.string {
    case "offer":
      guard let sdp = b["sdp"]?.string, l?.offerer != true, l?.answering != true else { return }
      let l = l ?? link(from, offerer: false)
      l.since = now()
      l.ready = false
      l.remote = false
      l.answering = true
      l.version = Self.version(of: b)
      transport.answer(from, offer: sdp) { [weak self] answer in
        l.answering = false
        guard let self, links[from] === l else { return }
        guard let answer else { return leave(from) }
        remoteSet(from, l)
        relay(from, ["t": .string("answer"), "sdp": .string(answer), "v": .number(2)])
        flushOut(from, l)
      }
    case "answer":
      guard let sdp = b["sdp"]?.string, let l, l.offerer else { return }
      transport.accept(from, answer: sdp) { [weak self] ok in
        guard let self, links[from] === l else { return }
        guard ok else { return leave(from) }
        l.version = Self.version(of: b)
        remoteSet(from, l)
      }
    case "ice":
      guard let l, let c = b["candidate"]?.string else { return }
      let candidate = IceCandidate(candidate: c, mid: b["mid"]?.string, index: b["index"]?.number.flatMap { Int(exactly: $0) })
      if l.remote { transport.add(from, candidate: candidate) } else { l.inbox.append(candidate) }
    default:
      return
    }
  }

  private static func version(of b: [String: JSONValue]) -> Int { (b["v"]?.number ?? 1) >= 2 ? 2 : 1 }

  private func remoteSet(_ id: String, _ l: Link) {
    l.remote = true
    let inbox = l.inbox
    l.inbox = []
    for c in inbox { transport.add(id, candidate: c) }
  }

  /// A candidate this side gathered: after its offer or answer has gone, never before.
  private func gathered(_ id: String, _ c: IceCandidate?) {
    guard let l = links[id] else { return }
    let body: [String: JSONValue] = [
      "t": .string("ice"), "candidate": c.map { .string($0.candidate) } ?? .null,
      "mid": c?.mid.map(JSONValue.string) ?? .null, "index": c?.index.map { .number(Double($0)) } ?? .null,
    ]
    if l.ready { relay(id, body) } else { l.outbox.append(body) }
  }

  private func flushOut(_ id: String, _ l: Link) {
    l.ready = true
    let out = l.outbox
    l.outbox = []
    for b in out { relay(id, b) }
  }

  private func state(_ id: String, _ s: PeerState) {
    guard let l = links[id] else { return }
    l.up = s == .open
    opened(l, l.up)
    if s == .failed, l.offerer, l.restarts < Self.maxRestarts, l.restartAt == nil { l.restartAt = now().addingTimeInterval(Self.restartDelay) }
  }

  private func opened(_ l: Link, _ open: Bool) {
    let was = l.open
    l.open = open
    if open {
      l.everOpen = true
      l.restarts = 0
      l.heardAt = now()
    }
    if was != open { change() }
  }

  /// About once a second: beats, closes what went silent, restarts what failed or went silent, and gives up on what never
  /// opened.
  public func tick() {
    let t = now()
    for (id, l) in links {
      if l.up, l.version == 2 { transport.sendBytes(id, Self.beat) }
      if l.open, l.beats, t.timeIntervalSince(l.heardAt) >= Self.silence {
        opened(l, false)
        if l.offerer, l.restarts < Self.maxRestarts, l.restartAt == nil { l.restartAt = t }
      }
      if let at = l.restartAt, t >= at {
        l.restartAt = nil
        l.restarts += 1
        l.since = t
        offer(id, l, restart: true)
      } else if !l.everOpen, l.restartAt == nil, t.timeIntervalSince(l.since) >= Self.openTimeout {
        leave(id)
      }
    }
  }

  public func leave(_ id: String) {
    guard let l = links.removeValue(forKey: id) else { return }
    transport.close(id)
    if l.open { change() }
  }

  public func reset() { for id in links.keys.sorted() { leave(id) } }
}
