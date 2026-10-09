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
  /// 2 when its presence says so: it reads compact bodies.
  public var v = 1
  public var board: String?
  /// Every board it shows; nil when its presence names only `board`.
  public var boards: [String]?
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

  /// Whether its presence shows `board`.
  func shows(_ board: String) -> Bool { boards?.contains(board) ?? (self.board == board) }
}

/// A WebSocket as `Live` uses it; tests put a fake in its place.
@MainActor public protocol LiveSocket: AnyObject {
  var onOpen: (() -> Void)? { get set }
  var onMessage: ((String) -> Void)? { get set }
  var onData: ((Data) -> Void)? { get set }
  /// With the close code: 1006 when the connection failed.
  var onClose: ((Int) -> Void)? { get set }
  func send(_ text: String)
  func sendData(_ data: Data)
  func close()
}

/// `LiveSocket` over `URLSessionWebSocketTask`, calling back on the main queue.
@MainActor public final class WebSocketTaskSocket: NSObject, LiveSocket, URLSessionWebSocketDelegate {
  public var onOpen: (() -> Void)?
  public var onMessage: ((String) -> Void)?
  public var onData: ((Data) -> Void)?
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
            self.onData?(d)
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

  public func sendData(_ data: Data) {
    guard !ended else { return }
    task.send(.data(data)) { _ in }
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
/// the multiplayer and lean sync designs. Bodies are sealed with the space key, so the relay reads none of them; a
/// version 2 channel carries compact bodies unsealed.
@MainActor public final class Live {
  public static let sendInterval: TimeInterval = 0.05
  public static let directSendInterval: TimeInterval = 0.008
  public static let heartbeat: TimeInterval = 5
  public static let cursorRepeat: TimeInterval = 0.1
  public static let presenceInterval: TimeInterval = 15
  public static let gone: TimeInterval = 30
  public static let holdGrace: TimeInterval = 1
  public static let idleCursor: TimeInterval = 60
  public static let maxBackoff: TimeInterval = 30
  public static let pingInterval: TimeInterval = 20
  public static let pongTimeout: TimeInterval = 10
  static let maxFrame = 65_536
  static let maxPushed = 60_000
  static let moving = ["pos", "size", "w"]
  /// Coordinates are kept this close to 0, so that playing back between two stays finite.
  static let limit = 1e7
  static let encoder: JSONEncoder = {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return e
  }()

  /// One way out, the open channels or the relay: its gate, its compact encoders, and what waits to go.
  private final class Pipe {
    enum Kind { case cursor, live }

    let direct: Bool
    let interval: TimeInterval
    let cursorEncoder = CursorEncoder(), liveEncoder = LiveEncoder()
    /// Who each encoder last sent to; another set starts from a keyframe.
    var to: [Kind: String] = [:]
    var cursor = false
    /// The cursor waiting is the channels' resend of the last one.
    var resend = false
    var live = false
    /// The next cursor goes to everyone: this device's cursor moved to another board.
    var everyone = false
    var sent = Date.distantPast, queued = false

    init(direct: Bool, interval: TimeInterval) {
      self.direct = direct
      self.interval = interval
    }

    /// What `encode` makes for `ids`, nil when the body cannot be put compactly.
    func compact(_ kind: Kind, _ ids: [String], _ encode: () throws -> Data) throws -> Data? {
      let key = ids.joined(separator: " ")
      if key != to[kind] { kind == .cursor ? cursorEncoder.reset() : liveEncoder.reset() }
      to[kind] = key
      do {
        return try encode()
      } catch is Compact.Failure {
        return nil
      } catch is Pack.Failure {
        return nil
      }
    }

    /// The next live body starts a gesture.
    func restart() {
      liveEncoder.reset()
      to[.live] = nil
    }
  }

  /// The latest live edit: what the gesture changed, and where its items were when it began.
  private struct LiveState {
    var board: String
    var items: [String: LiveFields]
    var caret: Caret?
    var starts: [String: [Double]]
  }

  /// A sender's compact decoders, one per pipe.
  private final class Decoders {
    let direct = LiveDecoder(), relay = LiveDecoder()
  }

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
  /// A peer pushed: its highest version, and its records when they came whole.
  public var onPushed: ((Int, Pushed?) -> Void)?
  public var onRefused: ((Set<String>) -> Void)?
  public var onUnauthorized: (() -> Void)?

  private let makeSocket: @MainActor (URL) -> LiveSocket
  private let now: () -> Date
  private let uptime: () -> Double
  private let schedule: (TimeInterval, @escaping @MainActor () -> Void) -> Void
  /// What `at` in this device's bodies counts from, in ms of `uptime`.
  let started: Double
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
  private var presence: (board: String?, boards: [String], selection: [String]) = (nil, [], [])
  private var cursor: Cursor?
  private var cursorBoard = ""
  private var presenceSent = Date.distantPast
  /// Cursors the channels have sent, which a later one keeps from being sent again.
  private var cursorSends = 0
  private var lastLive: LiveState?
  private let channels = Pipe(direct: true, interval: Live.directSendInterval)
  private let relayPipe = Pipe(direct: false, interval: Live.sendInterval)
  private var pipes: [Pipe] { [channels, relayPipe] }
  /// When a frame last reached the relay, which keeps this connection's holds there while it hears from it.
  private var relaySent = Date.distantPast
  private var storeCursor = 0
  private var seq = 0
  /// The other connections in the space, as the relay names them → when each joined or was last heard.
  private var roster: [String: Date] = [:]
  private var decoders: [String: Decoders] = [:]
  private(set) var direct: Direct?

  /// `schedule(0, …)` runs on the next turn.
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
    started = uptime()
    if let transport {
      direct = Direct(
        transport: transport, now: now, relay: { [weak self] to, b in self?.send(b, to: to) },
        message: { [weak self] from, m in
          switch m {
          case let .text(t): if let sealed = Base64URL.decode(t) { self?.opened(from, sealed, direct: true) }
          case let .bytes(d): self?.take(from, d, direct: true, compactOnly: true)
          }
        },
        change: { [weak self] in
          guard let self else { return }
          // a channel opened or closed: a peer moved between pipes, so each pipe's next body is a keyframe
          for p in pipes { p.to = [:] }
          onChange?()
        })
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
    for p in pipes { p.restart() }
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
      frame(["t": .string("auth"), "token": .string(Base64URL.encode(keys.relayToken)), "v": .number(2)])
    }
    s.onMessage = { [weak self, weak s] text in
      guard let self, let s, s === socket else { return }
      // anything from the relay shows the socket is alive
      pingWaiting = nil
      received(text)
    }
    s.onData = { [weak self, weak s] data in
      guard let self, let s, s === socket else { return }
      pingWaiting = nil
      if let f = Frames.parseRelayFrame(data) { opened(String(f.from), f.body, direct: false) }
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
    decoders = [:]
    holds = [:]
    roster = [:]
    direct?.reset()
    if had { onChange?() }
  }

  private func frame(_ f: [String: JSONValue]) {
    guard let socket, let data = Self.json(f) else { return }
    socket.send(String(decoding: data, as: UTF8.self))
    relaySent = now()
  }

  private static func json(_ body: [String: JSONValue]) -> Data? { try? encoder.encode(JSONValue.object(body)) }

  /// How long `n` bytes are as base64url.
  private static func b64Length(_ n: Int) -> Int { (n * 4 + 2) / 3 }

  /// `plain` sealed; nil when too big to send.
  private func seal(_ plain: Data) -> Data? {
    guard let sealed = try? keys.sealLive(plain), Self.b64Length(sealed.count) <= Self.maxFrame - 100 else { return nil }
    return sealed
  }

  /// The relay's number for connection `id`; nil for one it does not name with digits.
  private static func connNumber(_ id: String) -> Int? {
    id.count <= 10 && !id.isEmpty && id.allSatisfy { $0.isASCII && $0.isNumber } ? Int(id) : nil
  }

  /// Sealed `plain` through the relay to connection `to`, or to everyone else when nil, or `fallback` instead if that is
  /// over `maxPushed`; whether it went out.
  @discardableResult private func post(_ plain: Data, to: String?, fallback: Data? = nil) -> Bool {
    guard connected, let socket else { return false }
    let conn = to.flatMap(Self.connNumber)
    guard to == nil || conn != nil else { return false }
    var sealed = seal(plain)
    if let fallback, sealed.map({ Self.b64Length($0.count) > Self.maxPushed }) ?? true { sealed = seal(fallback) }
    guard let sealed else { return false }
    socket.sendData(Frames.relayFrame(to: conn, sealed))
    relaySent = now()
    return true
  }

  /// A JSON body to everyone else, or to connection `to`, or `fallback` instead if that is over `maxPushed`.
  @discardableResult private func send(_ body: [String: JSONValue], to: String? = nil, fallback: [String: JSONValue]? = nil) -> Bool {
    guard let plain = Self.json(body) else { return false }
    return post(plain, to: to, fallback: fallback.flatMap(Self.json))
  }

  // MARK: pipes

  /// Roster connections that see `board`, or all of them for nil: by their `boards`, else their `board`, and any not
  /// heard from yet.
  private func recipients(_ board: String?) -> [String] {
    roster.keys.sorted().filter { id in
      guard let board, let p = peers[id], p.person != nil else { return true }
      return p.shows(board)
    }
  }

  /// Whether peer `p` sees this device's cursor board, and the board of its gesture under way.
  private func watches(_ p: Peer) -> (cursor: Bool, live: Bool) {
    guard p.person != nil else { return (false, false) }
    return (!cursorBoard.isEmpty && p.shows(cursorBoard), !mine.isEmpty && lastLive.map { p.shows($0.board) } == true)
  }

  /// Peer `p` came to see this device's cursor or gesture, which `was` says it did not: they go again as they are now.
  /// A keyframe when it was not among its pipe's last recipients; a peer without presence was, so it gets a delta on
  /// what it was sent before.
  private func caughtUp(_ p: Peer, _ was: (cursor: Bool, live: Bool)) {
    let now = watches(p)
    for pipe in pipes {
      if now.cursor && !was.cursor { pipe.cursor = true }
      if now.live && !was.live { pipe.live = true }
      if pipe.cursor || pipe.live { run(pipe) }
    }
  }

  /// Flushes `pipe` at most every its interval: on the next turn when it may, so that a cursor and a live edit from one
  /// event go as one body, else once when it may again.
  private func run(_ pipe: Pipe) {
    guard !pipe.queued else { return }
    pipe.queued = true
    let wait = pipe.interval - now().timeIntervalSince(pipe.sent)
    // within a microsecond is now, as dates carry rounding
    schedule(wait > 1e-6 ? wait : 0) { [weak self, weak pipe] in
      guard let self, let pipe else { return }
      pipe.queued = false
      pipe.sent = now()
      // the encoders throw only for bad input, which `compact` takes
      try! flush(pipe)
    }
  }

  private func stamp() -> (seq: Int, at: Double, now: Date) {
    seq += 1
    return (seq, uptime() - started, now())
  }

  /// What waits on `pipe`: the latest live body for its board, with the cursor inside for compact recipients during a
  /// gesture, then the latest cursor for whom that did not reach.
  private func flush(_ pipe: Pipe) throws {
    guard connected else { return }
    let live = pipe.live ? lastLive : nil, cursor = pipe.cursor, everyone = cursor && pipe.everyone, resend = pipe.resend
    (pipe.live, pipe.cursor, pipe.resend) = (false, false, false)
    if cursor { pipe.everyone = false }
    // the channels never resend, so the last cursor, maybe a hide, goes once more when the pointer is still
    if cursor && pipe.direct && !resend {
      cursorSends += 1
      let n = cursorSends
      schedule(Self.cursorRepeat) { [weak self, weak pipe] in
        guard let self, let pipe, n == cursorSends, !pipe.cursor else { return }
        (pipe.cursor, pipe.resend) = (true, true)
        run(pipe)
      }
    }
    let c = self.cursor
    let fold = cursor && !everyone && !mine.isEmpty && live != nil && c?.board == live?.board ? c.map { [$0.x, $0.y] } : nil
    var folded: [String] = []
    if let live {
      let json: [String: JSONValue] = [
        "t": .string("live"), "board": .string(live.board), "items": .object(Self.trimmed(live.items, by: 100).mapValues(JSONValue.object)),
        "caret": Self.caretJSON(live.caret),
      ]
      let body = LiveBody(board: live.board, items: live.items, starts: live.starts, caret: live.caret, cursor: fold)
      folded = try emit(pipe, .live, recipients(live.board), json) { s in
        try pipe.liveEncoder.encode(body, seq: s.seq, at: s.at, now: s.now)
      }
    }
    guard cursor else { return }
    let json: [String: JSONValue] = [
      "t": .string("cursor"), "board": .string(cursorBoard),
      "x": c.map { .number(Self.round($0.x, 100)) } ?? .null, "y": c.map { .number(Self.round($0.y, 100)) } ?? .null,
    ]
    let board = cursorBoard
    try emit(pipe, .cursor, recipients(everyone ? nil : cursorBoard), json, folded: fold != nil ? folded : []) { s in
      try pipe.cursorEncoder.encode(seq: s.seq, at: s.at, x: c?.x, y: c?.y, board: board, now: s.now)
    }
  }

  /// A cursor or live body to those of `ids` on `pipe`, but `folded`, which had it inside the live body: compact where
  /// they read it, else JSON; who got it compact.
  @discardableResult private func emit(
    _ pipe: Pipe, _ kind: Pipe.Kind, _ ids: [String], _ json: [String: JSONValue], folded: [String] = [],
    compact encode: ((seq: Int, at: Double, now: Date)) throws -> Data
  ) throws -> [String] {
    let ids = ids.filter { (direct?.isOpen($0) ?? false) == pipe.direct && !folded.contains($0) }
    // whoever this pipe's encoder last sent to missed this body, unless it came inside the live body
    if ids.isEmpty && folded.isEmpty { pipe.to[kind] = nil }
    guard !ids.isEmpty else { return [] }
    let s = stamp()
    let plain = { () -> Data? in
      var b = json
      b["at"] = .number(Self.round(s.at, 10))
      b["seq"] = .number(Double(s.seq))
      return Self.json(b)
    }
    if pipe.direct, let direct {
      let v2 = ids.filter { direct.version($0) == 2 }, v1 = ids.filter { direct.version($0) != 2 }
      if v2.isEmpty && folded.isEmpty { pipe.to[kind] = nil }
      let bytes = v2.isEmpty ? nil : try pipe.compact(kind, v2) { try encode(s) }
      if let bytes { for id in v2 { direct.sendBytes(id, bytes) } }
      if !v1.isEmpty, let sealed = plain().flatMap(seal) {
        for id in v1 { direct.send(id, Base64URL.encode(sealed)) }
      }
      return bytes == nil ? [] : v2
    }
    let to = ids.count == 1 ? ids[0] : nil
    if ids.allSatisfy({ peers[$0]?.v == 2 }) {
      guard let bytes = try pipe.compact(kind, ids, { try encode(s) }) else { return [] }
      post(bytes, to: to)
      return ids
    }
    // its compact encoder's last body did not reach these
    pipe.to[kind] = nil
    if let p = plain() { post(p, to: to) }
    return []
  }

  // MARK: receiving

  private static func pushed(_ b: [String: JSONValue], version: Int) -> Pushed? {
    guard let list = b["records"]?.array else { return nil }
    var records: [Pulled] = []
    for r in list {
      guard let o = r.object, let id = o["id"]?.string, let blob = o["blob"]?.string, let v = integral(o["version"]?.number) else { return nil }
      records.append(Pulled(id: id, version: v, blob: blob))
    }
    return Pushed(version: version, epoch: b["epoch"]?.string, records: records)
  }

  private static func holds(_ v: JSONValue?) -> [String: Set<String>] {
    (v?.object ?? [:]).mapValues { Set(($0.array ?? []).compactMap(\.string)) }
  }

  private static func cursor(_ v: JSONValue?) -> Cursor? {
    guard let o = v?.object, let board = o["board"]?.string, let x = o["x"]?.number, let y = o["y"]?.number, x.isFinite, y.isFinite
    else { return nil }
    return Cursor(board: board, x: clamped(x), y: clamped(y))
  }

  private static func clamped(_ v: Double) -> Double { min(limit, max(-limit, v)) }

  /// `v` to the nearest `1 / by`, halves up, as the web rounds.
  private static func round(_ v: Double, _ by: Double) -> Double { (v * by + 0.5).rounded(.down) / by }

  /// `items` with their moving fields clamped, and rounded to `1 / by` when given.
  private static func trimmed(_ items: [String: LiveFields], by: Double? = nil) -> [String: LiveFields] {
    func fit(_ v: JSONValue) -> JSONValue {
      guard let n = v.number, n.isFinite else { return v }
      return .number(by.map { round(clamped(n), $0) } ?? clamped(n))
    }
    return items.mapValues { f in
      var out = f
      for k in moving { if let v = f[k] { out[k] = v.array.map { .array($0.map(fit)) } ?? fit(v) } }
      return out
    }
  }

  private static func caretJSON(_ c: Caret?) -> JSONValue {
    c.map { .object(["id": .string($0.id), "back": .bool($0.back), "at": .number(Double($0.at))]) } ?? .null
  }

  private static func numbers(_ v: JSONValue?) -> [Double]? {
    if let n = v?.number, n.isFinite { return [clamped(n)] }
    guard let a = v?.array else { return nil }
    let ns = a.compactMap(\.number)
    return !a.isEmpty && ns.count == a.count && ns.allSatisfy(\.isFinite) ? ns.map(clamped) : nil
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
      decoders[who] = nil
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
      guard let from = m["from"]?.string, let body = m["body"]?.string.flatMap(Base64URL.decode) else { return }
      opened(from, body, direct: false)
    }
  }

  /// A sealed body from connection `from`, through the relay or, `direct`, over its channel.
  private func opened(_ from: String, _ sealed: Data, direct isDirect: Bool) {
    guard let plain = try? keys.openLive(sealed) else { return }
    take(from, plain, direct: isDirect)
  }

  /// A body from connection `from`, compact or JSON; a channel carries only cursors and live edits, and a version 2
  /// channel only compact ones.
  private func take(_ from: String, _ plain: Data, direct isDirect: Bool, compactOnly: Bool = false) {
    guard connected else { return }
    var b: [String: JSONValue]?
    if Compact.isCompact(plain) {
      let d = decoders[from] ?? Decoders()
      decoders[from] = d
      b = (isDirect ? d.direct : d.relay).decode(plain, overlay: peers[from]?.overlay ?? [:])
    } else if !compactOnly {
      b = try? JSONDecoder().decode([String: JSONValue].self, from: plain)
    }
    guard let b else { return }
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
    // a body older than one already taken from this connection, over either pipe, is dropped
    guard !["cursor", "live"].contains(b["t"]?.string) || Self.fresh(&p, b) else {
      peers[from] = p
      return
    }
    switch b["t"]?.string {
    case "presence":
      guard let device = b["device"]?.string, Base64URL.decode(device)?.count == 16 else { return }
      let was = watches(p)
      p.person = Person(device: device, name: String((b["name"]?.string ?? "").prefix(100)))
      p.v = (b["v"]?.number ?? 1) >= 2 ? 2 : 1
      p.board = b["board"]?.string
      p.boards = b["boards"]?.array?.compactMap(\.string)
      p.selection = (b["selection"]?.array ?? []).compactMap(\.string)
      // a cursor not heard yet, as a newcomer gets it; later ones come as cursor messages, so a faded one stays faded
      if b["cursor"] != nil, p.cursorAt == nil {
        p.cursor = Self.cursor(b["cursor"])
        p.cursorAt = t
      }
      caughtUp(p, was)
    case "cursor":
      moved(&p, Self.cursor(.object(b)), at: at, arrival: arrival)
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
      // a cursor inside a live body counts as a cursor body with its seq
      if let board, let xy = b["cursor"]?.array, xy.count == 2,
         let c = Self.cursor(.object(["board": .string(board), "x": xy[0], "y": xy[1]])),
         let n = Self.integral(b["seq"]?.number), n > p.seqs["cursor"] ?? 0 {
        p.seqs["cursor"] = n
        moved(&p, c, at: at, arrival: arrival)
      }
    case "pushed":
      guard let v = Self.integral(b["version"]?.number), v >= 0 else { return }
      p.awaiting = max(p.awaiting, v)
      peers[from] = p
      onPushed?(v, Self.pushed(b, version: v))
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

  /// Peer `p`'s cursor is at `c`, or hidden for nil, as of its sender's `at`.
  private func moved(_ p: inout Peer, _ c: Cursor?, at: Double, arrival: Double) {
    if c == nil || c?.board != p.cursor?.board { p.cursorTrack = nil }
    if let c {
      if p.cursorTrack == nil { p.cursorTrack = Track() }
      p.cursorTrack!.push(at: at, arrival: arrival, value: [c.x, c.y])
    }
    p.cursor = c
    p.cursorAt = now()
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

  /// About once a second: forgets the silent, fades still cursors, repeats presence, tells the relay a holder is still
  /// here, and checks that the relay still answers.
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
        decoders[conn] = nil
        changed = true
      } else if p.cursor != nil, t.timeIntervalSince(p.cursorAt ?? t) > Self.idleCursor {
        p.cursor = nil
        peers[conn] = p
        changed = true
      }
    }
    // a holder the relay has not heard from lately, as live edits may go only direct, keeps its holds there
    if connected && !mine.isEmpty && t.timeIntervalSince(relaySent) >= Self.heartbeat { frame(["t": .string("alive")]) }
    if peers.values.contains(where: { !$0.unheld.isEmpty }) {
      dropReleased()
      changed = true
    }
    if connected && t.timeIntervalSince(presenceSent) >= Self.presenceInterval { sendPresence() }
    direct?.tick()
    if changed { onChange?() }
  }

  // MARK: sending

  /// Where this device is: `board`, every board it shows (`boards`, `board` alone by default), and what it selected.
  public func setPresence(board: String?, boards: [String]? = nil, selection: [String]) {
    let boards = boards ?? board.map { [$0] } ?? []
    guard board != presence.board || boards != presence.boards || selection != presence.selection else { return }
    presence = (board, boards, selection)
    sendPresence()
  }

  private func sendPresence(to: String? = nil) {
    guard connected else { return }
    if to == nil { presenceSent = now() }
    send([
      "t": .string("presence"), "v": .number(2), "device": .string(me.device), "name": .string(me.name),
      "board": presence.board.map(JSONValue.string) ?? .null, "boards": .array(presence.boards.map(JSONValue.string)),
      "selection": .array(presence.selection.map(JSONValue.string)),
      "cursor": cursor.map {
        .object(["board": .string($0.board), "x": .number(Self.round($0.x, 100)), "y": .number(Self.round($0.y, 100))])
      } ?? .null,
    ], to: to)
  }

  /// This device's pointer on `board`; nil hides it. Each pipe sends the latest when its gate lets it; none while nobody
  /// else is here, as a newcomer gets it with the presence sent when it joins.
  public func sendCursor(board: String, x: Double?, y: Double?) {
    cursor = if let x, let y, x.isFinite, y.isFinite { Cursor(board: board, x: Self.clamped(x), y: Self.clamped(y)) } else { nil }
    if board != cursorBoard { for p in pipes { p.everyone = true } }
    cursorBoard = board
    guard !roster.isEmpty else { return }
    for p in pipes {
      (p.cursor, p.resend) = (true, false)
      run(p)
    }
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
    for p in pipes { p.restart() }
    if connected { frame(["t": .string("release")]) }
  }

  /// What the gesture under way changed of what it holds, and where the held items were when it began (`starts`, as
  /// `[x, y]`); each pipe sends the latest when its gate lets it.
  public func sendLive(board: String, items: [String: LiveFields], caret: Caret?, starts: [String: [Double]] = [:]) {
    lastLive = LiveState(board: board, items: Self.trimmed(items), caret: caret, starts: starts)
    guard !roster.isEmpty else { return }
    for p in pipes {
      p.live = true
      run(p)
    }
  }

  /// Announces a push with its records, or without them when they would not fit a frame.
  public func sendPushed(_ p: Pushed) {
    let bare: [String: JSONValue] = ["t": .string("pushed"), "version": .number(Double(p.version))]
    var full = bare
    if let epoch = p.epoch { full["epoch"] = .string(epoch) }
    full["records"] = .array(p.records.map { .object(["id": .string($0.id), "version": .number(Double($0.version)), "blob": .string($0.blob)]) })
    send(full, fallback: bare)
  }

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
