import BreezyKit
import Foundation

/// One Swift device: `Spaces` in its own directory, on the host's virtual clock, with its HTTP, relay sockets and
/// direct channels through the hub, and at most one board open, as the apps run it with `Collab`. Its ids, secrets and
/// nonces come from its seed.
@MainActor final class SimDevice {
  /// What the fuzzer's checks need of a card's height, the same in both languages: 72 + 24 per line of its text.
  static func height(_ text: String) -> Double { 72 + 24 * Double(text.utf16.filter { $0 == 10 }.count + 1) }

  let index: Int
  private unowned let host: SimHost
  let directory: URL
  private let random: SplitMix
  private(set) var spaces: Spaces!

  private struct Timer {
    var id: Int
    var due: Double
    var work: @MainActor () -> Void
  }
  private var timers: [Timer] = []
  private var timerCount = 0

  var requests: [Int: Request] = [:]
  var requestCount = 0
  private var sockets: [Int: SimSocket] = [:]
  /// The transport that made each channel, by peer.
  var peers: [String: SimPeer] = [:]
  private var calls: [Int: @MainActor (JSONValue) -> Void] = [:]
  private var callCount = 0

  private let holds = GestureHolds()
  private var collabs: [ObjectIdentifier: Collab] = [:]
  private struct Open {
    var id: String
    var group: Spaces.Group
    var model: BoardModel
    var binding: BoardBinding
    var session: Collab.Session
  }
  private var open: Open?
  /// Where a press's items stood: a lane and the cards it carries, or cards.
  private var pressed: (lane: Origin?, cards: [Origin], room: Room?)?
  private var visible = true

  init(_ index: Int, me: Person, seed: UInt64, directory: URL, host: SimHost) throws {
    self.index = index
    self.host = host
    self.directory = directory
    random = SplitMix(seed)
    try run {
      spaces = try Spaces(
        directory: directory, me: me,
        transport: { [weak self] s, k in
          HTTPTransport(server: s.server ?? "", space: s.space ?? "", token: k.token) { r in
            guard let self else { throw URLError(.cancelled) }
            return try await self.send(r)
          }
        },
        socket: { [unowned self] url in
          let s = SimSocket(sockets.count + 1, url: url, device: self)
          sockets[s.id] = s
          return s
        },
        peerTransport: { [unowned self] in SimPeer(device: self) },
        now: { [unowned self] in now }, uptime: { [unowned host] in host.t }, schedule: { [weak self] delay, work in
          self?.after(delay * 1000, work)
        })
    }
    spaces.flushLocal = { [weak self] in self?.open?.binding.flush() }
    spaces.onChange = { [weak self] _, boards, remote in
      guard let self, let o = open, boards.contains(o.id) else { return }
      if o.group.store.title(of: o.id) == nil { return close() }
      if remote { o.binding.pull() }
    }
    spaces.onLive = { [weak self] g in self?.showLive(g) }
    every(1000) { [unowned self] in for g in spaces.spaces { collab(g).tick() } }
    every(5000) { [unowned self] in spaces.syncAll(polling: true) }
  }

  // MARK: clock

  var now: Date { Date(timeIntervalSince1970: (host.t + host.skew[index, default: 0]) / 1000) }

  /// Runs `body` with this device's randomness, which tasks it starts keep.
  func run<T>(_ body: () throws -> T) rethrows -> T {
    try Randomness.$source.withValue(random.bytes, operation: body)
  }

  @discardableResult func after(_ ms: Double, _ work: @escaping @MainActor () -> Void) -> Int {
    timerCount += 1
    timers.append(Timer(id: timerCount, due: host.t + max(0, ms.isFinite ? ms : 0), work: work))
    return timerCount
  }

  func cancelTimer(_ id: Int) { timers.removeAll { $0.id == id } }

  private func every(_ ms: Double, _ work: @escaping @MainActor () -> Void) {
    after(ms) { [weak self] in
      work()
      self?.every(ms, work)
    }
  }

  /// When the earliest timer is due.
  var next: Double? { timers.map(\.due).min() }

  /// Takes the earliest timer due by `t`, the first set among those due at once.
  func due(by t: Double) -> (@MainActor () -> Void)? {
    let key = { (i: Int) in (self.timers[i].due, self.timers[i].id) }
    guard let i = timers.indices.filter({ timers[$0].due <= t }).min(by: { key($0) < key($1) }) else { return nil }
    return timers.remove(at: i).work
  }

  // MARK: hub

  func emit(_ ev: String, _ fields: Fields) {
    host.emit(fields.merging(["ev": .string(ev), "dev": .int(index)]) { a, _ in a })
  }

  func call(_ done: @escaping @MainActor (JSONValue) -> Void) -> Int {
    callCount += 1
    calls[callCount] = done
    return callCount
  }

  func peerDone(_ c: JSONValue) throws {
    calls.removeValue(forKey: try c.int("call"))?(c["value"] ?? .null)
  }

  func socket(_ cmd: String, _ c: JSONValue) throws {
    try sockets[try c.int("sock")]?.heard(cmd, c)
  }

  func peer(_ cmd: String, _ c: JSONValue) throws {
    let id = try c.string("peer")
    try peers[id]?.heard(cmd, id, c)
  }

  // MARK: operations

  func op(_ o: JSONValue) throws -> JSONValue {
    let name = try o.string("op")
    switch name {
    case "newSpace":
      let g = spaces.newSpace(server: try o.string("server"), name: try o.string("name"))
      spaces.syncAll()
      return .object(["invite": try Self.json(g.store.invite)])
    case "join":
      let i = try o.required("invite")
      spaces.join(
        Invite(server: try i.string("server"), space: try i.string("space"), secret: try i.string("secret"), name: i["name"]?.string))
      spaces.syncAll()
    case "createBoard":
      guard let g = spaces.spaces.first else { throw SimError("no space") }
      return .object(["board": .string(g.store.createBoard(title: try o.string("title")))])
    case "open":
      close()
      guard let id = o["board"]?.string else { return .object(["opened": .bool(false)]) }
      return .object(["opened": .bool(openBoard(id))])
    case "show":
      visible = o["visible"]?.bool ?? true
      for g in spaces.spaces { showLive(g) }
      if visible { spaces.retryAll() }
    case "retry": spaces.retryAll(changed: o["changed"]?.bool ?? false)
    case "resync":
      for g in spaces.spaces {
        g.engine.reset()
        Task { await g.engine.sync() }
      }
    default: return try edit(name, o)
    }
    return .null
  }

  /// An operation on the open board; nothing without one.
  private func edit(_ name: String, _ o: JSONValue) throws -> JSONValue {
    guard let open else { return .null }
    let model = open.model
    switch name {
    case "addCard", "addLane":
      let (x, y) = (try o.number("x"), try o.number("y"))
      var id = ""
      let card = name == "addCard"
      model.perform(card ? "New Card" : "New Lane") { id = card ? $0.addCard(x: x, y: y) : $0.addLane(x: x, y: y) }
      return .object(["id": .string(id)])
    case "color":
      let ids = Set(items(model.board.cards.map(\.id), try o.int("n"), try o.int("count")))
      let color = try o.int("color")
      model.perform("Colour") { $0.setColor(ids, color) }
    case "delete":
      let ids = Set(items(model.board.cards.map(\.id), try o.int("n"), try o.int("count")))
      model.perform("Delete") {
        $0.remove(ids)
        $0.gravity(heights($0))
      }
    case "type":
      let taken = open.group.live?.taken ?? []
      // as the apps, which begin, then hold, and edit nothing someone else holds
      guard !model.inGesture, let id = items(model.board.cards.map(\.id), try o.int("n"), 1).first, !taken.contains(id) else { break }
      let text = try o.string("text")
      let half = String(decoding: Array(text.utf16.prefix((text.utf16.count + 1) / 2)), as: UTF16.self)
      model.begin()
      open.session.hold([id])
      model.update { $0.setText(id, half) }
      model.update { $0.setText(id, text) }
      model.end("Edit")
    case "press":
      guard !model.inGesture else { break }
      let taken = open.group.live?.taken ?? []
      let b = model.board
      let (n, count) = (try o.int("n"), try o.int("count"))
      let ids: [String]
      if o["lane"]?.bool == true {
        guard let lid = items(b.lanes.map(\.id), n, 1).first, let lane = b.lane(lid) else { break }
        let carried = b.cardsInLane(lid, heightOf: heights(b))
        ids = [lid] + carried.map(\.id)
        guard !ids.contains(where: taken.contains) else { break }
        pressed = (Origin(id: lid, x: lane.x, y: lane.y), carried.map { Origin(id: $0.id, x: $0.x, y: $0.y) }, nil)
      } else {
        ids = items(b.cards.map(\.id), n, count)
        guard let first = ids.first, !taken.contains(first) else { break }
        // others make way while the cards move, and they land on release, as in the apps
        let room = Room(base: b.layout(excluding: Set(ids)), heightOf: heights(b))
        pressed = (nil, ids.compactMap { b.card($0) }.map { Origin(id: $0.id, x: $0.x, y: $0.y) }, room)
      }
      model.begin()
      open.session.hold(Set(ids))
    case "drag":
      guard model.inGesture, let pressed else { break }
      let (dx, dy) = (try o.number("dx"), try o.number("dy"))
      model.update { b in
        if let lane = pressed.lane {
          b.moveLane(lane, cards: pressed.cards, dx: dx, dy: dy)
        } else {
          b.moveCards(pressed.cards, dx: dx, dy: dy, room: pressed.room)
        }
      }
    case "release":
      let p = pressed
      pressed = nil
      if let p, let room = p.room, model.inGesture { model.update { $0.land(Set(p.cards.map(\.id)), room: room) } }
      model.end(p?.lane == nil ? "Move" : "Move Lane")
    case "cancel":
      pressed = nil
      model.cancel()
    case "cursor": open.group.live?.sendCursor(board: open.id, x: o["x"]?.number, y: o["y"]?.number)
    case "undo": if model.undoManager.canUndo { model.undoManager.undo() }
    case "redo": if model.undoManager.canRedo { model.undoManager.redo() }
    default: throw SimError("unknown op \(name)")
    }
    return .null
  }

  /// `count` of `ids`, at most all, sorted, from the `n`th on, wrapping, so that both languages pick the same.
  private func items(_ ids: [String], _ n: Int, _ count: Int) -> [String] {
    let sorted = ids.sorted()
    guard !sorted.isEmpty else { return [] }
    let start = ((n % sorted.count) + sorted.count) % sorted.count
    return (0..<min(max(count, 0), sorted.count)).map { sorted[(start + $0) % sorted.count] }
  }

  private func heights(_ b: Board) -> HeightOf {
    let h = Dictionary(b.cards.map { ($0.id, Self.height($0.text)) }) { a, _ in a }
    return { h[$0] ?? Self.height("") }
  }

  private func openBoard(_ id: String) -> Bool {
    guard let g = spaces.group(of: id) else { return false }
    var b = g.store.board(id)
    b.gravity(heights(b))
    let model = BoardModel(board: b)
    let binding = BoardBinding(id: id, model: model, store: g.store) { [weak self] delay, work in self?.after(delay * 1000, work) }
    binding.restack = { [weak self] b in
      guard let self else { return }
      b.gravity(heights(b))
    }
    open = Open(id: id, group: g, model: model, binding: binding, session: collab(g).open(id, model: model, binding: binding))
    showLive(g)
    // as the apps do on opening a board
    Task { await g.engine.sync() }
    return true
  }

  private func close() {
    guard let o = open else { return }
    open = nil
    pressed = nil
    o.binding.flush()
    o.session.close()
    showLive(o.group)
  }

  private func collab(_ g: Spaces.Group) -> Collab {
    if let c = collabs[ObjectIdentifier(g)] { return c }
    let c = Collab(group: g, holds: holds)
    collabs[ObjectIdentifier(g)] = c
    return c
  }

  /// Connects `g`'s live layer while the app shows, and says which board it shows.
  private func showLive(_ g: Spaces.Group) {
    guard let live = g.live else { return }
    guard visible else { return live.close() }
    live.connect()
    let board = open.flatMap { $0.group === g ? $0.id : nil }
    live.setPresence(board: board, boards: board.map { [$0] } ?? [], selection: [])
  }

  // MARK: state

  func snapshot() -> JSONValue { Snapshot.of(spaces, shown: open.map { ($0.id, $0.model, $0.group.store) }) }

  private static func json(_ invite: Invite?) throws -> JSONValue {
    guard let i = invite else { throw SimError("not syncing") }
    return .object([
      "server": .string(i.server), "space": .string(i.space), "secret": .string(i.secret), "name": .optional(i.name),
    ])
  }
}

/// SplitMix64, as the hub's rng.mjs and the tests have it.
final class SplitMix: @unchecked Sendable {
  private var state: UInt64

  init(_ seed: UInt64) { state = seed }

  func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }

  /// Little-endian, 8 bytes per draw.
  @Sendable func bytes(_ count: Int) -> Data {
    var d = Data(capacity: count + 8)
    while d.count < count { withUnsafeBytes(of: next().littleEndian) { d.append(contentsOf: $0) } }
    return d.prefix(count)
  }
}
