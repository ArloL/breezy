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

/// WebRTC data channels to other connections, as `Direct` drives them; the app puts a web view behind it, tests a fake.
@MainActor public protocol PeerTransport: AnyObject {
  var onCandidate: ((String, IceCandidate?) -> Void)? { get set }
  var onState: ((String, PeerState) -> Void)? { get set }
  var onMessage: ((String, String) -> Void)? { get set }
  func create(_ peer: String)
  func offer(_ peer: String, restart: Bool, _ done: @escaping @MainActor (String?) -> Void)
  func answer(_ peer: String, offer: String, _ done: @escaping @MainActor (String?) -> Void)
  func accept(_ peer: String, answer: String, _ done: @escaping @MainActor (Bool) -> Void)
  func add(_ peer: String, candidate: IceCandidate)
  @discardableResult func send(_ peer: String, _ text: String) -> Bool
  func close(_ peer: String)
}

/// Direct data channels to a space's other connections, beside the relay, for cursors and live edits; see the WebRTC
/// design. Offers, answers and candidates go through the relay.
@MainActor public final class Direct {
  public static let openTimeout: TimeInterval = 10
  public static let restartDelay: TimeInterval = 2
  public static let maxRestarts = 3

  private final class Link {
    let offerer: Bool
    var open = false, everOpen = false, remote = false, ready = false, answering = false
    var since: Date
    var restarts = 0
    var restartAt: Date?
    var inbox: [IceCandidate] = []
    var outbox: [[String: JSONValue]] = []

    init(offerer: Bool, since: Date) {
      self.offerer = offerer
      self.since = since
    }
  }

  private let transport: PeerTransport
  private let now: () -> Date
  private let relay: (String, [String: JSONValue]) -> Void
  private let message: (String, String) -> Void
  private let change: () -> Void
  private var links: [String: Link] = [:]

  public init(transport: PeerTransport, now: @escaping () -> Date, relay: @escaping (String, [String: JSONValue]) -> Void,
              message: @escaping (String, String) -> Void, change: @escaping () -> Void) {
    self.transport = transport
    self.now = now
    self.relay = relay
    self.message = message
    self.change = change
    transport.onCandidate = { [weak self] in self?.gathered($0, $1) }
    transport.onState = { [weak self] in self?.state($0, $1) }
    transport.onMessage = { [weak self] id, text in
      guard let self, links[id]?.open == true else { return }
      self.message(id, text)
    }
  }

  public func isOpen(_ id: String) -> Bool { links[id]?.open ?? false }

  @discardableResult public func send(_ id: String, _ text: String) -> Bool { isOpen(id) && transport.send(id, text) }

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
      relay(id, ["t": .string("offer"), "sdp": .string(sdp)])
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
      transport.answer(from, offer: sdp) { [weak self] answer in
        l.answering = false
        guard let self, links[from] === l else { return }
        guard let answer else { return leave(from) }
        remoteSet(from, l)
        relay(from, ["t": .string("answer"), "sdp": .string(answer)])
        flushOut(from, l)
      }
    case "answer":
      guard let sdp = b["sdp"]?.string, let l, l.offerer else { return }
      transport.accept(from, answer: sdp) { [weak self] ok in
        guard let self, links[from] === l else { return }
        if ok { remoteSet(from, l) } else { leave(from) }
      }
    case "ice":
      guard let l, let c = b["candidate"]?.string else { return }
      let candidate = IceCandidate(candidate: c, mid: b["mid"]?.string, index: b["index"]?.number.map { Int($0) })
      if l.remote { transport.add(from, candidate: candidate) } else { l.inbox.append(candidate) }
    default:
      return
    }
  }

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
    let was = l.open
    l.open = s == .open
    if l.open {
      l.everOpen = true
      l.restarts = 0
    }
    if s == .failed, l.offerer, l.restarts < Self.maxRestarts, l.restartAt == nil { l.restartAt = now().addingTimeInterval(Self.restartDelay) }
    if was != l.open { change() }
  }

  /// About once a second: restarts what failed, and gives up on what never opened.
  public func tick() {
    let t = now()
    for (id, l) in links {
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
