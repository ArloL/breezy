import Foundation

/// Someone in a space: a device, the name its person goes by, and the colour that device shows in.
public struct Person: Equatable, Sendable {
  public static let palette: [UInt32] = [0xe5484d, 0xf76b15, 0x12a594, 0x8e4ec6, 0x3e63dd, 0xe93d82, 0xad7f58, 0x00a2c7]
  public var device: String
  public var name: String

  public init(device: String, name: String) {
    self.device = device
    self.name = name
  }

  public var colour: UInt32 { Self.palette[Int(Base64URL.decode(device)?.first ?? 0) % Self.palette.count] }

  /// One or two letters for avatars.
  public var initials: String {
    let s = name.split(whereSeparator: \.isWhitespace).prefix(2).compactMap { $0.first.map { String($0).uppercased() } }.joined()
    return s.isEmpty ? "?" : s
  }

  var hex: String { String(format: "#%06x", colour) }
}

/// Where someone's pointer is, in board coordinates.
public struct Cursor: Equatable, Sendable {
  public var board: String
  public var x: Double
  public var y: Double

  public init(board: String, x: Double, y: Double) {
    self.board = board
    self.x = x
    self.y = y
  }
}

/// Where someone's caret is in the card they edit: a UTF-16 offset into its front, or into its notes.
public struct Caret: Equatable, Sendable {
  public var id: String
  public var back: Bool
  public var at: Int

  public init(id: String, back: Bool, at: Int) {
    self.id = id
    self.back = back
    self.at = at
  }
}

/// Another connection to the space, as its messages describe it.
public struct Peer: Equatable, Sendable {
  /// Nil until its first presence.
  public var person: Person?
  public var board: String?
  public var selection: [String] = []
  public var cursor: Cursor?
  public var heard: Date
  var cursorAt: Date?
  public var overlay: [String: LiveFields] = [:]
  public var overlayBoard: String?
  public var caret: Caret?
  /// A version it pushed that this device has not pulled yet; its overlay stays until then.
  var awaiting = 0
  /// The last `seq` taken of each kind of body.
  var seqs: [String: Int] = [:]
  var cursorTrack: Track?
  /// Tracks of the overlay's moving fields, keyed "id field".
  var motion: [String: Track] = [:]
  /// Overlay ids whose live body last came, at this time, while it did not hold them.
  var unheld: [String: Date] = [:]
}

/// A WebSocket as `Live` uses it; tests put a fake in its place.
@MainActor public protocol LiveSocket: AnyObject {
  var onOpen: (() -> Void)? { get set }
  var onMessage: ((String) -> Void)? { get set }
  /// With the close code: 1006 when the connection failed.
  var onClose: ((Int) -> Void)? { get set }
  func send(_ text: String)
  func close()
}

/// `LiveSocket` over `URLSessionWebSocketTask`, calling back on the main queue.
@MainActor public final class WebSocketTaskSocket: NSObject, LiveSocket, URLSessionWebSocketDelegate {
  public var onOpen: (() -> Void)?
  public var onMessage: ((String) -> Void)?
  public var onClose: ((Int) -> Void)?
  private var session: URLSession!
  private var task: URLSessionWebSocketTask!
  private var ended = false

  public init(url: URL) {
    super.init()
    session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
    task = session.webSocketTask(with: url)
    task.resume()
    receive()
  }

  private func receive() {
    task.receive { [weak self] result in
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let self, !self.ended else { return }
          switch result {
          case .success(.string(let s)):
            self.onMessage?(s)
            self.receive()
          case .success(.data(let d)):
            self.onMessage?(String(decoding: d, as: UTF8.self))
            self.receive()
          case .success:
            self.receive()
          case .failure:
            self.end(self.task.closeCode == .invalid ? 1006 : self.task.closeCode.rawValue)
          }
        }
      }
    }
  }

  public func send(_ text: String) {
    guard !ended else { return }
    task.send(.string(text)) { _ in }
  }

  /// Closes from this side, without `onClose`.
  public func close() {
    guard !ended else { return }
    ended = true
    task.cancel(with: .normalClosure, reason: nil)
    session.invalidateAndCancel()
  }

  private func end(_ code: Int) {
    guard !ended else { return }
    ended = true
    session.invalidateAndCancel()
    onClose?(code)
  }

  public nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    MainActor.assumeIsolated { if !ended { onOpen?() } }
  }

  public nonisolated func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
  ) {
    MainActor.assumeIsolated { end(closeCode.rawValue) }
  }

  public nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    MainActor.assumeIsolated { end(1006) }
  }
}

/// A space's live layer over its relay: who is here and where, what they hold, and their edits as they happen; see
/// the multiplayer design. Bodies are sealed with the space key, so the relay reads none of them.
@MainActor public final class Live {
  public static let sendInterval: TimeInterval = 0.05
  public static let directSendInterval: TimeInterval = 0.008
  public static let heartbeat: TimeInterval = 5
  public static let presenceInterval: TimeInterval = 15
  public static let gone: TimeInterval = 30
  public static let holdGrace: TimeInterval = 1
  public static let idleCursor: TimeInterval = 60
  public static let maxBackoff: TimeInterval = 30
  public static let pingInterval: TimeInterval = 20
  public static let pongTimeout: TimeInterval = 10
  static let maxFrame = 65_536
  static let moving = ["pos", "size", "w"]
  static let encoder: JSONEncoder = {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return e
  }()

  public let relay: String
  public let space: String
  let keys: SpaceKeys
  public var me: Person { didSet { if me != oldValue { sendPresence() } } }
  public private(set) var id: String?
  public var connected: Bool { id != nil }
  public private(set) var peers: [String: Peer] = [:]
  public private(set) var holds: [String: Set<String>] = [:]
  /// What this connection holds, or has asked to.
  public private(set) var mine: Set<String> = []
  public var onChange: (() -> Void)?
  public var onPushed: ((Int) -> Void)?
  public var onRefused: ((Set<String>) -> Void)?
  public var onUnauthorized: (() -> Void)?

  private let makeSocket: @MainActor (URL) -> LiveSocket
  private let now: () -> Date
  private let uptime: () -> Double
  private let schedule: (TimeInterval, @escaping @MainActor () -> Void) -> Void
  private var socket: LiveSocket?
  private var wanted = false
  private var failures = 0
  private var retrying = false
  /// After the relay refused the token: this layer stays closed. A new one comes when the server names another relay,
  /// or at the next launch.
  private var stopped = false
  private var pingSent = Date.distantPast
  /// When a ping went out that nothing has answered yet.
  private var pingWaiting: Date?
  private var presence: (board: String?, selection: [String]) = (nil, [])
  private var cursor: Cursor?
  private var cursorBoard = ""
  private var presenceSent = Date.distantPast
  private var cursorSent = Date.distantPast, cursorQueued = false
  private var liveSent = Date.distantPast, liveQueued = false
  private var lastLive: [String: JSONValue]?
  /// When a frame last reached the relay, which keeps this connection's holds there while it hears from it.
  private var relaySent = Date.distantPast
  private var storeCursor = 0
  private var seq = 0
  /// The other connections in the space, as the relay names them → when each joined or was last heard.
  private var roster: [String: Date] = [:]
  private var direct: Direct?

  public init(
    relay: String, space: String, keys: SpaceKeys, me: Person,
    socket: @escaping @MainActor (URL) -> LiveSocket = { WebSocketTaskSocket(url: $0) },
    now: @escaping () -> Date = Date.init,
    uptime: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime * 1000 },
    schedule: @escaping (TimeInterval, @escaping @MainActor () -> Void) -> Void = { delay, work in
      DispatchQueue.main.asyncAfter(deadline: .now() + delay) { MainActor.assumeIsolated(work) }
    },
    transport: PeerTransport? = nil
  ) {
    self.relay = relay
    self.space = space
    self.keys = keys
    self.me = me
    makeSocket = socket
    self.now = now
    self.uptime = uptime
    self.schedule = schedule
    if let transport {
      direct = Direct(
        transport: transport, now: now, relay: { [weak self] to, b in self?.send(b, to: to) },
        message: { [weak self] from, text in self?.opened(from, text, direct: true) }, change: { [weak self] in self?.onChange?() })
    }
  }

  // MARK: connection

  /// Opens unless open already, waiting to retry, or refused for good.
  public func connect() {
    wanted = true
    if socket == nil && !retrying && !stopped { open() }
  }

  /// Closes, holding nothing: the relay drops a closed connection's holds.
  public func close() {
    wanted = false
    mine = []
    lastLive = nil
    let s = socket
    socket = nil
    s?.close()
    reset()
  }

  private func open() {
    guard var c = URLComponents(string: relay) else { return }
    c.queryItems = (c.queryItems ?? []) + [URLQueryItem(name: "space", value: space)]
    guard let url = c.url else { return }
    let s = makeSocket(url)
    socket = s
    s.onOpen = { [weak self, weak s] in
      guard let self, let s, s === socket else { return }
      frame(["t": .string("auth"), "token": .string(Base64URL.encode(keys.relayToken))])
    }
    s.onMessage = { [weak self, weak s] text in
      guard let self, let s, s === socket else { return }
      received(text)
    }
    s.onClose = { [weak self, weak s] code in
      guard let self, let s, s === socket else { return }
      dropped(code)
    }
  }

  /// The socket closed with `code`, or was given up on: reconnects after a back-off, unless the token was refused.
  private func dropped(_ code: Int) {
    socket = nil
    reset()
    if code == 4001 {
      stopped = true
      onUnauthorized?()
      return
    }
    guard wanted else { return }
    let delay = min(Self.maxBackoff, pow(2, Double(failures)))
    failures += 1
    retrying = true
    schedule(delay) { [weak self] in
      guard let self else { return }
      retrying = false
      guard wanted, socket == nil, !stopped else { return }
      open()
    }
  }

  private func reset() {
    let had = connected || !peers.isEmpty || !holds.isEmpty
    id = nil
    pingWaiting = nil
    peers = [:]
    holds = [:]
    roster = [:]
    direct?.reset()
    if had { onChange?() }
  }

  private func frame(_ f: [String: JSONValue]) {
    guard let socket, let data = try? Self.encoder.encode(JSONValue.object(f)) else { return }
    socket.send(String(decoding: data, as: UTF8.self))
    relaySent = now()
  }

  /// `body` sealed, as base64url; nil when too big to send.
  private func seal(_ body: [String: JSONValue]) -> String? {
    guard let plain = try? Self.encoder.encode(JSONValue.object(body)), let sealed = try? keys.sealLive(plain) else { return nil }
    let b = Base64URL.encode(sealed)
    return b.count <= Self.maxFrame - 100 ? b : nil
  }

  /// A sealed body to everyone else, or to connection `to`.
  @discardableResult private func send(_ body: [String: JSONValue], to: String? = nil) -> Bool {
    guard connected, let b = seal(body) else { return false }
    var f: [String: JSONValue] = ["body": .string(b)]
    if let to { f["to"] = .string(to) }
    frame(f)
    return true
  }

  /// Whether every other connection has an open channel.
  var allDirect: Bool { !roster.isEmpty && roster.keys.allSatisfy { direct?.isOpen($0) == true } }
  private var gateInterval: TimeInterval { allDirect ? Self.directSendInterval : Self.sendInterval }

  /// A cursor or live body, stamped with this device's time and the next sequence number: over every open channel, and
  /// to the relay unless all are open; `relayOnly` for the holder's heartbeat, which keeps the holds there.
  @discardableResult private func sendFast(_ body: [String: JSONValue], relayOnly: Bool = false) -> Bool {
    guard connected else { return false }
    var b = body
    seq += 1
    b["at"] = .number(uptime())
    b["seq"] = .number(Double(seq))
    guard let sealed = seal(b) else { return false }
    if !relayOnly { for id in roster.keys.sorted() { direct?.send(id, sealed) } }
    if relayOnly || !allDirect { frame(["body": .string(sealed)]) }
    return true
  }

  // MARK: receiving

  private static func holds(_ v: JSONValue?) -> [String: Set<String>] {
    (v?.object ?? [:]).mapValues { Set(($0.array ?? []).compactMap(\.string)) }
  }

  private static func cursor(_ v: JSONValue?) -> Cursor? {
    guard let o = v?.object, let board = o["board"]?.string, let x = o["x"]?.number, let y = o["y"]?.number, x.isFinite, y.isFinite
    else { return nil }
    return Cursor(board: board, x: x, y: y)
  }

  private static func numbers(_ v: JSONValue?) -> [Double]? {
    if let n = v?.number, n.isFinite { return [n] }
    guard let a = v?.array else { return nil }
    let ns = a.compactMap(\.number)
    return !a.isEmpty && ns.count == a.count && ns.allSatisfy(\.isFinite) ? ns : nil
  }

  /// `v` as an Int when it is a whole number within ±2^53.
  private static func integral(_ v: Double?) -> Int? {
    guard let v, v == v.rounded(), abs(v) <= 9_007_199_254_740_992 else { return nil }
    return Int(v)
  }

  /// Whether `b` is newer than the last body of its kind from this peer, over either pipe; one without `seq` is.
  private static func fresh(_ p: inout Peer, _ b: [String: JSONValue]) -> Bool {
    guard let t = b["t"]?.string, let n = integral(b["seq"]?.number) else { return true }
    guard n > p.seqs[t] ?? 0 else { return false }
    p.seqs[t] = n
    return true
  }

  private static func caret(_ v: JSONValue?) -> Caret? {
    guard let o = v?.object, let id = o["id"]?.string, let back = o["back"]?.bool, let at = integral(o["at"]?.number), at >= 0 else { return nil }
    return Caret(id: id, back: back, at: at)
  }

  private func received(_ text: String) {
    // anything from the relay shows the socket is alive
    pingWaiting = nil
    guard text != "pong", let m = try? JSONDecoder().decode([String: JSONValue].self, from: Data(text.utf8)) else { return }
    switch m["t"]?.string {
    case "welcome":
      id = m["id"]?.string
      failures = 0
      pingSent = now()
      holds = Self.holds(m["holds"])
      roster = Dictionary((m["peers"]?.array ?? []).compactMap(\.string).map { ($0, now()) }) { a, _ in a }
      direct?.welcome(roster.keys.sorted())
      sendPresence()
      if !mine.isEmpty { frame(["t": .string("hold"), "ids": .array(mine.sorted().map(JSONValue.string))]) }
      onChange?()
    case "join":
      guard let who = m["id"]?.string else { return }
      roster[who] = now()
      sendPresence(to: who)
    case "leave":
      guard let who = m["id"]?.string else { return }
      peers[who] = nil
      holds[who] = nil
      roster[who] = nil
      direct?.leave(who)
      onChange?()
    case "holds":
      holds = Self.holds(m["holds"])
      dropReleased()
      onChange?()
    case "refused":
      let ids = Set((m["ids"]?.array ?? []).compactMap(\.string))
      if !ids.isEmpty { onRefused?(ids) }
    default:
      guard let from = m["from"]?.string, let body = m["body"]?.string else { return }
      opened(from, body, direct: false)
    }
  }

  /// A sealed body from connection `from`, through the relay or, `direct`, over its channel, which carries only cursors
  /// and live edits.
  private func opened(_ from: String, _ body: String, direct isDirect: Bool) {
    guard connected, let sealed = Base64URL.decode(body), let plain = try? keys.openLive(sealed),
          let b = try? JSONDecoder().decode([String: JSONValue].self, from: plain)
    else { return }
    roster[from] = now()
    switch b["t"]?.string {
    case "offer", "answer", "ice": if !isDirect { direct?.heard(from, b) }
    case "cursor", "live": heard(from, b)
    default: if !isDirect { heard(from, b) }
    }
  }

  private func heard(_ from: String, _ b: [String: JSONValue]) {
    let t = now()
    var p = peers[from] ?? Peer(heard: t)
    p.heard = t
    let arrival = uptime()
    let at = b["at"]?.number ?? arrival
    guard !["cursor", "live"].contains(b["t"]?.string) || Self.fresh(&p, b) else {
      peers[from] = p
      return
    }
    switch b["t"]?.string {
    case "presence":
      guard let device = b["device"]?.string, Base64URL.decode(device)?.count == 16 else { return }
      p.person = Person(device: device, name: String((b["name"]?.string ?? "").prefix(100)))
      p.board = b["board"]?.string
      p.selection = (b["selection"]?.array ?? []).compactMap(\.string)
      // a cursor not heard yet, as a newcomer gets it; later ones come as cursor messages, so a faded one stays faded
      if b["cursor"] != nil, p.cursorAt == nil {
        p.cursor = Self.cursor(b["cursor"])
        p.cursorAt = t
      }
    case "cursor":
      let c = Self.cursor(.object(b))
      if c == nil || c?.board != p.cursor?.board { p.cursorTrack = nil }
      if let c {
        if p.cursorTrack == nil { p.cursorTrack = Track() }
        p.cursorTrack!.push(at: at, arrival: arrival, value: [c.x, c.y])
      }
      p.cursor = c
      p.cursorAt = t
    case "live":
      let board = b["board"]?.string
      if board != p.overlayBoard { p.motion = [:] }
      p.overlayBoard = board
      for (id, f) in b["items"]?.object ?? [:] {
        guard let f = f.object else { continue }
        p.overlay[id, default: [:]].merge(f.filter { Records.liveFieldNames.contains($0.key) || $0.key == "kind" }) { $1 }
        p.unheld[id] = holds[from]?.contains(id) == true ? nil : t
        for k in Self.moving {
          guard let v = Self.numbers(f[k]) else { continue }
          // a value of another length than the track's cannot be played back with it
          if let last = p.motion["\(id) \(k)"]?.samples.last, last.value.count != v.count { continue }
          p.motion["\(id) \(k)", default: Track()].push(at: at, arrival: arrival, value: v)
        }
      }
      p.caret = Self.caret(b["caret"])
    case "pushed":
      guard let v = Self.integral(b["version"]?.number), v >= 0 else { return }
      p.awaiting = max(p.awaiting, v)
      peers[from] = p
      onPushed?(v)
      dropReleased()
      onChange?()
      return
    default:
      return
    }
    peers[from] = p
    dropReleased()
    onChange?()
  }

  /// Overlays of items no longer held go, unless their holder pushed a version not pulled yet. One not held yet stays
  /// `holdGrace` after its last live body, as that may come direct before the relay says it is held.
  private func dropReleased() {
    let t = now()
    for (conn, var p) in peers {
      guard p.awaiting <= storeCursor else { continue }
      p.awaiting = 0
      let held = holds[conn] ?? []
      for id in p.overlay.keys {
        if held.contains(id) {
          p.unheld[id] = nil
        } else if let since = p.unheld[id], t.timeIntervalSince(since) < Self.holdGrace {
          continue
        } else {
          p.overlay[id] = nil
          p.unheld[id] = nil
        }
      }
      p.motion = p.motion.filter { p.overlay[String($0.key.prefix { $0 != " " })] != nil }
      if held.isEmpty && p.unheld.isEmpty { p.caret = nil }
      peers[conn] = p
    }
  }

  /// The store pulled up to `cursor`: overlays waiting for it can go.
  public func noteCursor(_ cursor: Int) {
    storeCursor = max(storeCursor, cursor)
    dropReleased()
    onChange?()
  }

  /// About once a second: forgets the silent, fades still cursors, repeats presence and a holder's live fields, and
  /// checks that the relay still answers.
  public func tick() {
    let t = now()
    if connected, let p = pingWaiting, t.timeIntervalSince(p) >= Self.pongTimeout {
      let s = socket
      dropped(1006)
      s?.close()
      return
    }
    if connected && pingWaiting == nil && t.timeIntervalSince(pingSent) >= Self.pingInterval {
      pingSent = t
      pingWaiting = t
      socket?.send("ping")
    }
    var changed = false
    // a connection that never speaks, such as one in another space with this one's token, would keep every cursor on
    // the relay
    for (who, heard) in roster where t.timeIntervalSince(heard) >= Self.gone {
      roster[who] = nil
      direct?.leave(who)
      changed = true
    }
    for (conn, var p) in peers {
      if t.timeIntervalSince(p.heard) > Self.gone {
        peers[conn] = nil
        changed = true
      } else if p.cursor != nil, t.timeIntervalSince(p.cursorAt ?? t) > Self.idleCursor {
        p.cursor = nil
        peers[conn] = p
        changed = true
      }
    }
    // a holder the relay has not heard from lately: live edits that go only direct do not reach it
    if connected && !mine.isEmpty && t.timeIntervalSince(relaySent) >= Self.heartbeat {
      relaySent = t
      if lastLive == nil || !sendFast(lastLive!, relayOnly: true) {
        sendFast(["t": .string("live"), "board": .string(presence.board ?? cursorBoard), "items": .object([:]), "caret": .null], relayOnly: true)
      }
    }
    if peers.values.contains(where: { !$0.unheld.isEmpty }) {
      dropReleased()
      changed = true
    }
    if connected && t.timeIntervalSince(presenceSent) >= Self.presenceInterval { sendPresence() }
    direct?.tick()
    if changed { onChange?() }
  }

  // MARK: sending

  public func setPresence(board: String?, selection: [String]) {
    guard board != presence.board || selection != presence.selection else { return }
    presence = (board, selection)
    sendPresence()
  }

  private func sendPresence(to: String? = nil) {
    guard connected else { return }
    if to == nil { presenceSent = now() }
    send([
      "t": .string("presence"), "device": .string(me.device), "name": .string(me.name), "colour": .string(me.hex),
      "board": presence.board.map(JSONValue.string) ?? .null, "selection": .array(presence.selection.map(JSONValue.string)),
      "cursor": cursor.map { .object(["board": .string($0.board), "x": .number($0.x), "y": .number($0.y)]) } ?? .null,
    ], to: to)
  }

  /// This device's pointer on `board`; nil hides it. At most every 50 ms, and the last one always goes; none while
  /// nobody else is here, as a newcomer gets it with the presence sent when it joins.
  public func sendCursor(board: String, x: Double?, y: Double?) {
    cursor = x.flatMap { x in y.map { Cursor(board: board, x: x, y: $0) } }
    cursorBoard = board
    guard !peers.isEmpty else { return }
    let wait = gateInterval - now().timeIntervalSince(cursorSent)
    if wait <= 0 { return flushCursor() }
    guard !cursorQueued else { return }
    cursorQueued = true
    schedule(wait) { [weak self] in
      self?.cursorQueued = false
      self?.flushCursor()
    }
  }

  private func flushCursor() {
    cursorSent = now()
    sendFast(["t": .string("cursor"), "board": .string(cursorBoard), "x": cursor.map { .number($0.x) } ?? .null, "y": cursor.map { .number($0.y) } ?? .null])
  }

  /// Asks the relay for `ids`; `onRefused` tells if someone else has any. Asked again after a reconnect.
  public func hold(_ ids: Set<String>) {
    let fresh = ids.subtracting(mine)
    guard !fresh.isEmpty else { return }
    mine.formUnion(fresh)
    if connected { frame(["t": .string("hold"), "ids": .array(fresh.sorted().map(JSONValue.string))]) }
  }

  public func release() {
    guard !mine.isEmpty else { return }
    mine = []
    lastLive = nil
    if connected { frame(["t": .string("release")]) }
  }

  /// What the gesture under way changed of what it holds; at most every 50 ms, and repeated every 5 s while held, which
  /// keeps the holds even while nobody else is here to be sent the rest.
  public func sendLive(board: String, items: [String: LiveFields], caret: Caret?) {
    lastLive = [
      "t": .string("live"), "board": .string(board), "items": .object(items.mapValues(JSONValue.object)),
      "caret": caret.map { .object(["id": .string($0.id), "back": .bool($0.back), "at": .number(Double($0.at))]) } ?? .null,
    ]
    guard !peers.isEmpty else { return }
    let wait = gateInterval - now().timeIntervalSince(liveSent)
    if wait <= 0 { return flushLive() }
    guard !liveQueued else { return }
    liveQueued = true
    schedule(wait) { [weak self] in
      self?.liveQueued = false
      self?.flushLive()
    }
  }

  private func flushLive() {
    guard let l = lastLive else { return }
    liveSent = now()
    sendFast(l)
  }

  public func sendPushed(_ version: Int) { send(["t": .string("pushed"), "version": .number(Double(version))]) }

  // MARK: what others do

  /// "Direct with 1 of 2 people", for the status lines, while anyone else is here.
  public var directStatus: String? {
    let people = roster.keys
    guard !people.isEmpty else { return nil }
    let open = people.filter { direct?.isOpen($0) == true }.count
    return "Direct with \(open) of \(people.count) \(people.count == 1 ? "person" : "people")"
  }

  /// Ids another connection holds.
  public var taken: Set<String> { Set(holds.filter { $0.key != id }.values.joined()) }

  /// Who holds `id`, if another connection does.
  public func holder(of item: String) -> Person? {
    guard let conn = holds.first(where: { $0.key != id && $0.value.contains(item) })?.key else { return nil }
    return peers[conn]?.person ?? Person(device: "", name: "")
  }

  /// Others' live fields on `board` as they play back now, leaving out what this device holds: its own gesture draws
  /// from its model.
  public func overlay(on board: String) -> [String: LiveFields] {
    let t = uptime()
    var out: [String: LiveFields] = [:]
    for p in peers.values where p.overlayBoard == board {
      for (id, f) in p.overlay where !mine.contains(id) {
        var shown = f
        for k in Self.moving where f[k] != nil {
          guard let v = p.motion["\(id) \(k)"]?.sample(t) else { continue }
          shown[k] = k == "w" ? .number(v[0]) : .array(v.map(JSONValue.number))
        }
        out[id] = shown
      }
    }
    return out
  }

  public func cursors(on board: String) -> [(key: String, person: Person, cursor: Cursor)] {
    let t = uptime()
    return peers.compactMap { k, p in
      guard let person = p.person, let c = p.cursor, c.board == board else { return nil }
      let v = p.cursorTrack?.sample(t) ?? [c.x, c.y]
      return (k, person, Cursor(board: board, x: v[0], y: v[1]))
    }.sorted { $0.key < $1.key }
  }

  /// Whether any cursor or live edit on `board` is still playing back, so that it draws again next frame.
  public func animating(on board: String) -> Bool {
    let t = uptime()
    return peers.values.contains { p in
      (p.cursor?.board == board && p.cursorTrack?.playing(t) == true) || (p.overlayBoard == board && p.motion.values.contains { $0.playing(t) })
    }
  }

  public func carets(on board: String) -> [(key: String, person: Person, caret: Caret)] {
    peers.compactMap { k, p in
      guard let person = p.person, let c = p.caret, p.overlayBoard == board else { return nil }
      return (k, person, c)
    }.sorted { $0.key < $1.key }
  }

  /// The people on `board`, once each and not this device's, by name.
  public func people(on board: String?) -> [Person] {
    var byDevice: [String: Person] = [:]
    for p in peers.values { if let person = p.person, p.board == board, person.device != me.device { byDevice[person.device] = person } }
    return byDevice.values.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
  }

  /// What the people on `board` have selected, and who.
  public func selections(on board: String) -> [String: Person] {
    var out: [String: Person] = [:]
    for p in peers.values where p.board == board {
      guard let person = p.person else { continue }
      for id in p.selection { out[id] = person }
    }
    return out
  }
}
