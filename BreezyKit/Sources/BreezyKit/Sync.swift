import Foundation

public struct Pulled: Codable, Equatable, Sendable {
  public var id: String
  public var version: Int
  public var blob: String
  /// Written before the space's epoch last changed, so as a restored backup has it.
  public var stale: Bool?
}

public struct Page: Codable, Equatable, Sendable {
  public var records: [Pulled]
  public var cursor: Int
  /// Nil for a space the server doesn't have.
  public var epoch: String?
  /// The live layer's relay, when the server names one.
  public var relay: String? = nil
}

public struct Write: Codable, Equatable, Sendable {
  public var id: String
  public var base: Int
  public var blob: String
}

public struct Accepted: Codable, Equatable, Sendable {
  public var id: String
  public var version: Int
}

public struct PushResult: Codable, Equatable, Sendable {
  public var accepted: [Accepted]
  public var refused: [Pulled]
  public var epoch: String?
  /// The live layer's relay, when the server names one.
  public var relay: String? = nil
  /// With `since`: what the server holds after it, without this push's own writes.
  public var records: [Pulled]? = nil
  /// With `records`: the cursor they bring the device to.
  public var cursor: Int? = nil
}

/// A push the server took, as announced to the other devices.
public struct Pushed: Equatable, Sendable {
  public var version: Int
  public var epoch: String?
  public var records: [Pulled]

  public init(version: Int, epoch: String?, records: [Pulled]) {
    self.version = version
    self.epoch = epoch
    self.records = records
  }
}

public enum TransportError: Error, Equatable {
  case offline, unreachable, unauthorized, tooLarge
}

/// The server's two calls; see server/sync.php. A push with `since` and `epoch` also returns what the server holds
/// after `since`, unless its epoch is another.
public protocol Transport {
  func pull(since: Int) async throws -> Page
  func push(_ writes: [Write], since: Int?, epoch: String?) async throws -> PushResult
}

public struct HTTPTransport: Transport {
  let server: URL
  let space: String
  let token: String
  let send: (URLRequest) async throws -> (Data, URLResponse)
  static let deflateAbove = 1024

  /// `send` makes the request: `session`'s, unless the fuzzer forwards it.
  public init?(
    server: String, space: String, token: Data, session: URLSession = .shared,
    send: ((URLRequest) async throws -> (Data, URLResponse))? = nil
  ) {
    guard let url = URL(string: server) else { return nil }
    self.server = url
    self.space = space
    self.token = Base64URL.encode(token)
    self.send = send ?? { try await session.data(for: $0) }
  }

  public func pull(since: Int) async throws -> Page {
    let data = try await request([URLQueryItem(name: "since", value: String(since))], body: nil)
    return try JSONDecoder().decode(Page.self, from: data)
  }

  public func push(_ writes: [Write], since: Int?, epoch: String?) async throws -> PushResult {
    struct Body: Encodable {
      var writes: [Write]
      var since: Int?
      var epoch: String?
    }
    // sorted, so that the same push is the same bytes
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys]
    let data = try await request([], body: e.encode(Body(writes: writes, since: since, epoch: epoch)))
    return try JSONDecoder().decode(PushResult.self, from: data)
  }

  private func request(_ query: [URLQueryItem], body: Data?) async throws -> Data {
    var c = URLComponents(url: server, resolvingAgainstBaseURL: false)!
    c.queryItems = (c.queryItems ?? []) + [URLQueryItem(name: "space", value: space)] + query
    var r = URLRequest(url: c.url!, timeoutInterval: 20)
    r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    if var body {
      r.httpMethod = "POST"
      r.setValue("application/json", forHTTPHeaderField: "Content-Type")
      if body.count > Self.deflateAbove, let deflated = try? (body as NSData).compressed(using: .zlib) as Data {
        body = deflated
        r.setValue("deflate", forHTTPHeaderField: "Content-Encoding")
      }
      r.httpBody = body
    }
    let data: Data, response: URLResponse
    do {
      (data, response) = try await send(r)
    } catch let e as URLError where [.notConnectedToInternet, .networkConnectionLost, .dataNotAllowed].contains(e.code) {
      throw TransportError.offline
    } catch {
      throw TransportError.unreachable
    }
    switch (response as? HTTPURLResponse)?.statusCode {
    case 200: return data
    case 401: throw TransportError.unauthorized
    case 413: throw TransportError.tooLarge
    default: throw TransportError.unreachable
    }
  }
}

public struct SyncStatus: Equatable, Sendable {
  public enum State: Equatable, Sendable { case local, synced, offline, unreachable, notInSpace }
  public var state: State = .local
  public var at: Date?
  public var waiting = 0
  public var unreadable = 0
  public var held = 0
  public var tooLong = 0

  /// As the menus show it, a line each.
  public func lines(now: Date = Date()) -> [String] {
    func count(_ n: Int, _ one: String, _ many: String) -> String { "\(n) \(n == 1 ? one : many)" }
    var out: [String]
    switch state {
    case .local: out = ["Not syncing"]
    case .synced:
      let minutes = Int(now.timeIntervalSince(at ?? now) / 60)
      out = [minutes < 1 ? "Synced just now" : "Synced \(minutes) min ago"]
    case .offline: out = [waiting == 0 ? "Offline" : "Offline — \(count(waiting, "change", "changes")) waiting"]
    case .unreachable: out = ["Can’t reach server"]
    case .notInSpace: out = ["Not in this space any more"]
    }
    if unreadable > 0 { out.append(count(unreadable, "unreadable change", "unreadable changes")) }
    if held > 0 { out.append("Update Breezy to see all changes") }
    if tooLong > 0 { out.append("Card too long to sync") }
    return out
  }
}

/// Pulls what changed after the store's cursor, merges it, and pushes what is pending, one cycle at
/// a time; see the sync design.
@MainActor public final class SyncEngine {
  public nonisolated static let pageSize = 500
  public nonisolated static let maxBlob = 65_536
  static let maxRequest = 900_000
  static let encoder: JSONEncoder = {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return e
  }()

  public let store: Store
  public private(set) var status = SyncStatus()
  public var onStatus: ((SyncStatus) -> Void)?
  /// Called before merging, so that edits not yet in the store get there first.
  public var flushLocal: (() -> Void)?
  /// The relay the server last named; nil until it names one.
  public private(set) var relay: String?
  public var onRelay: ((String?) -> Void)?
  /// After a push the server took, with the highest version it gave and the accepted writes.
  public var onPushed: ((Pushed) -> Void)?
  /// With the store's cursor once the records up to it are in: after each page taken, and after pushed records.
  public var onPulled: ((Int) -> Void)?
  /// Just before a push goes.
  public var onPushing: (() -> Void)?
  /// Whether a gesture others follow live is under way: what it changed so far waits for its end.
  public var holdBack: (() -> Bool)?
  /// When a cycle last ended synced.
  public private(set) var lastSynced: Date?
  private let makeTransport: (SpaceState, SpaceKeys) -> Transport?
  private let now: () -> Date
  private var running: Task<Void, Never>?
  private var again = false, stopped = false, heldTried = false
  private var failures = 0, tooLong = 0
  /// Ids whose newer server record cannot be decoded; their local edits wait instead of being resent.
  private var blocked: Set<String> = []
  private var retryAt: Date?
  /// Counts `changed` timers; only the latest, and only before a cycle begins, syncs.
  private var soon = 0
  private let schedule: Schedule
  /// The cycle running, and when it began.
  private var current: Task<Void, Never>?
  private var cycleAt = Date.distantPast
  private var restarting = false
  /// A request of the cycle running that has taken this long when the network changes is given up on.
  static let stale: TimeInterval = 1

  public init(
    store: Store, now: @escaping () -> Date = Date.init,
    transport: @escaping (SpaceState, SpaceKeys) -> Transport? = { s, k in HTTPTransport(server: s.server ?? "", space: s.space ?? "", token: k.token) },
    schedule: @escaping Schedule = afterOnMain
  ) {
    self.store = store
    self.now = now
    makeTransport = transport
    self.schedule = schedule
  }

  /// One cycle; a call during a cycle runs another after it, and returns when that one ends.
  public func sync() async {
    // this cycle, or the one after the one running, takes what changed so far
    soon += 1
    if let running {
      again = true
      return await running.value
    }
    let task = Task {
      repeat {
        again = false
        let c = Task { await self.cycle() }
        current = c
        cycleAt = now()
        await c.value
        current = nil
      } while again
      // in the same turn as the last check of `again`, so that a call either repeats this loop or starts a new one
      running = nil
    }
    running = task
    await task.value
  }

  /// A cycle a second from now, once however many changes come meanwhile.
  public func changed() {
    // the gesture's end syncs
    if holdBack?() == true { return }
    soon += 1
    let n = soon
    schedule(1) { [weak self] in
      guard let self, soon == n else { return }
      Task { await self.sync() }
    }
  }

  /// The network is back, or may have changed: a cycle now, without waiting out a back-off. When it `changed`, a request
  /// of the cycle running that has taken over `stale` is given up on, as it may be on a connection the change left dead.
  public func retryNow(changed: Bool = true) {
    guard !stopped else { return }
    failures = 0
    retryAt = nil
    if changed, current != nil, now().timeIntervalSince(cycleAt) >= Self.stale {
      restarting = true
      current?.cancel()
    }
    Task { await sync() }
  }

  /// Whether a change made now goes to the server at once, rather than after a back-off or a gesture's end.
  public var pushesNow: Bool {
    store.state.invite != nil && !stopped && (retryAt.map { $0 <= now() } ?? true) && holdBack?() != true
  }

  /// Forgets a back-off and a refused token, as after joining a space.
  public func reset() {
    failures = 0
    retryAt = nil
    stopped = false
    heldTried = false
    blocked = []
  }

  private func cycle() async {
    let state = store.state
    guard let keys = try? SpaceKeys(state: state), let transport = makeTransport(state, keys) else { return update(.local) }
    guard !stopped, retryAt.map({ $0 <= now() }) ?? true else { return }
    let space = state.space
    func same() -> Bool { store.state.space == space }
    restarting = false
    do {
      flushLocal?()
      if !heldTried {
        heldTried = true
        retryHeld(keys)
      }
      let ready = state.resync || state.epoch == nil || holdBack?() == true ? nil : outgoing(keys)
      let combined = ready?.writes.isEmpty == false
      var first = combined ? ready : nil
      if !combined { guard try await pullAll(transport, keys, same) else { return } }
      var refusals = 0
      for _ in 0..<10 where holdBack?() != true {
        flushLocal?()
        let out = first ?? outgoing(keys)
        first = nil
        if out.writes.isEmpty { break }
        let request = combined ? store.state.cursor : nil
        let result = try await transport.push(out.writes, since: request, epoch: combined ? store.state.epoch : nil)
        guard same() else { return }
        if store.note(epoch: result.epoch) {
          again = true
          return
        }
        for a in result.accepted { if let r = out.sent[a.id] { store.accepted(a.id, version: a.version, record: r) } }
        note(relay: result.relay)
        if let top = result.accepted.map(\.version).max() {
          let records = result.accepted.compactMap { a in out.blobs[a.id].map { Pulled(id: a.id, version: a.version, blob: $0) } }
          onPushed?(Pushed(version: top, epoch: result.epoch, records: records))
        }
        if !result.refused.isEmpty {
          flushLocal?()
          var mergeable = false
          var items: [Incoming] = []
          for r in result.refused {
            if let i = decode(r, keys) {
              items.append(i)
              mergeable = true
            } else {
              blocked.insert(r.id)
            }
          }
          store.merge(items)
          if mergeable { refusals += 1 }
          if refusals == 3 { throw TransportError.unreachable }
        }
        if combined, let request, let records = result.records {
          let cursor = result.cursor ?? store.state.cursor
          let own = result.accepted.filter { $0.version > request && $0.version <= cursor }.count
          let page = Page(records: records, cursor: cursor, epoch: result.epoch, relay: result.relay)
          switch takePage(page, keys, same, own: own) {
          case .stop: return
          case .again:
            again = true
            return
          case .more:
            onPulled?(store.state.cursor)
            guard try await pullAll(transport, keys, same) else { return }
          case .done: onPulled?(store.state.cursor)
          }
        }
      }
      failures = 0
      retryAt = nil
      lastSynced = now()
      update(.synced)
    } catch TransportError.unauthorized {
      guard same() else { return }
      stopped = true
      update(.notInSpace)
    } catch {
      guard same() else { return }
      if restarting {
        restarting = false
        again = true
        return
      }
      failures += 1
      retryAt = now().addingTimeInterval(min(60, 5 * pow(2, Double(failures - 1))))
      update(error as? TransportError == .offline ? .offline : .unreachable)
    }
  }

  private enum Taken { case stop, again, more, done }

  /// Takes a page of records: `.stop` if the space changed, `.again` if the epoch did, `.more` if the page was full,
  /// counting `own` writes left out of it.
  private func takePage(_ page: Page, _ keys: SpaceKeys, _ same: () -> Bool, own: Int = 0) -> Taken {
    guard same() else { return .stop }
    note(relay: page.relay)
    if store.note(epoch: page.epoch) { return .again }
    flushLocal?()
    store.merge(page.records.compactMap { decode($0, keys) })
    store.advance(to: page.cursor)
    return page.records.count + own < Self.pageSize ? .done : .more
  }

  /// Pulls to the end; false if the space changed meanwhile.
  private func pullAll(_ transport: Transport, _ keys: SpaceKeys, _ same: () -> Bool) async throws -> Bool {
    while true {
      switch takePage(try await transport.pull(since: store.state.cursor), keys, same) {
      case .stop: return false
      case .done:
        onPulled?(store.state.cursor)
        store.resynced()
        return true
      case .more: onPulled?(store.state.cursor)
      case .again: continue
      }
    }
  }

  /// Takes the records another device just pushed as the page after the cursor, without a pull; false, changing
  /// nothing, when they do not follow on from what this one has. Waits for a running cycle.
  public func receivePushed(_ p: Pushed) async -> Bool {
    while let running { await running.value }
    let state = store.state
    guard state.space != nil, !state.resync, let epoch = state.epoch, p.epoch == epoch, !p.records.isEmpty,
          let keys = try? SpaceKeys(state: state) else { return false }
    let page = p.records.sorted { $0.version < $1.version }
    guard zip(page, page.dropFirst()).allSatisfy({ $1.version == $0.version + 1 }), state.cursor >= page[0].version - 1 else { return false }
    let last = page[page.count - 1].version
    if state.cursor >= last {
      onPulled?(state.cursor)
      return true
    }
    flushLocal?()
    if !planted("pushed-skip") { store.merge(page.compactMap { decode($0, keys) }) }
    store.advance(to: last)
    onPulled?(store.state.cursor)
    return true
  }

  /// A WebSocket over TLS, or plain to this computer for trying the relay out, as `Invite.validServer` has it.
  static func validRelay(_ s: String) -> Bool {
    guard let u = URL(string: s), let host = u.host?.lowercased(), !host.isEmpty else { return false }
    let scheme = u.scheme?.lowercased()
    return scheme == "wss" || (scheme == "ws" && ["localhost", "127.0.0.1"].contains(host))
  }

  private func note(relay r: String?) {
    let valid = r.flatMap { Self.validRelay($0) ? $0 : nil }
    guard valid != relay else { return }
    relay = valid
    store.note(relay: valid)
    onRelay?(valid)
  }

  /// Names the relay the store kept, so that the live layer connects at once rather than after the first sync.
  public func noteStoredRelay() {
    note(relay: store.state.relay)
  }

  private func decode(_ p: Pulled, _ keys: SpaceKeys) -> Incoming? {
    guard let id = Base64URL.decode(p.id), let blob = Base64URL.decode(p.blob), let plain = try? keys.open(blob, id: id),
          let record = try? JSONDecoder().decode(Record.self, from: plain) else {
      store.noteUnreadable()
      return nil
    }
    guard record.format <= Record.format else {
      store.hold(p.id, version: p.version, blob: p.blob)
      return nil
    }
    return Incoming(id: p.id, version: p.version, record: record, stale: p.stale ?? false)
  }

  /// Records held for a newer Breezy, which this one may now read.
  private func retryHeld(_ keys: SpaceKeys) {
    var ready: [Incoming] = []
    for (id, h) in store.state.held {
      store.release(id)
      if let r = decode(Pulled(id: id, version: h.version, blob: h.blob), keys) { ready.append(r) }
    }
    store.merge(ready)
  }

  private struct Outgoing {
    var writes: [Write] = []
    var sent: [String: Record] = [:]
    /// The sealed blob of each write, as base64url.
    var blobs: [String: String] = [:]
  }

  private func outgoing(_ keys: SpaceKeys) -> Outgoing {
    // before reading what is pending, so that a push holds every edit sent before it began
    onPushing?()
    var out = Outgoing(), size = 0
    tooLong = 0
    for p in store.pending where !blocked.contains(p.id) {
      guard let id = Base64URL.decode(p.id), id.count == 16, let plain = try? Self.encoder.encode(p.record),
            let blob = try? keys.seal(plain, id: id) else { continue }
      guard blob.count <= Self.maxBlob else {
        tooLong += 1
        continue
      }
      let w = Write(id: p.id, base: p.base, blob: Base64URL.encode(blob))
      size += w.blob.count + 64
      if size > Self.maxRequest { break }
      out.writes.append(w)
      out.sent[p.id] = p.record
      out.blobs[p.id] = w.blob
    }
    return out
  }

  private func update(_ state: SyncStatus.State) {
    status = SyncStatus(
      state: state, at: state == .synced ? now() : status.at, waiting: store.pending.count,
      unreadable: store.state.unreadable, held: store.state.held.count, tooLong: tooLong)
    onStatus?(status)
  }
}
