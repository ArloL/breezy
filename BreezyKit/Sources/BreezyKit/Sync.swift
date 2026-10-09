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
}

public enum TransportError: Error, Equatable {
  case offline, unreachable, unauthorized, tooLarge
}

/// The server's two calls; see server/sync.php.
public protocol Transport {
  func pull(since: Int) async throws -> Page
  func push(_ writes: [Write]) async throws -> PushResult
}

public struct HTTPTransport: Transport {
  let server: URL
  let space: String
  let token: String
  let session: URLSession

  public init?(server: String, space: String, token: Data, session: URLSession = .shared) {
    guard let url = URL(string: server) else { return nil }
    self.server = url
    self.space = space
    self.token = Base64URL.encode(token)
    self.session = session
  }

  public func pull(since: Int) async throws -> Page {
    let data = try await send([URLQueryItem(name: "since", value: String(since))], body: nil)
    return try JSONDecoder().decode(Page.self, from: data)
  }

  public func push(_ writes: [Write]) async throws -> PushResult {
    let data = try await send([], body: JSONEncoder().encode(["writes": writes]))
    return try JSONDecoder().decode(PushResult.self, from: data)
  }

  private func send(_ query: [URLQueryItem], body: Data?) async throws -> Data {
    var c = URLComponents(url: server, resolvingAgainstBaseURL: false)!
    c.queryItems = (c.queryItems ?? []) + [URLQueryItem(name: "space", value: space)] + query
    var r = URLRequest(url: c.url!, timeoutInterval: 20)
    r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    if let body {
      r.httpMethod = "POST"
      r.httpBody = body
      r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let data: Data, response: URLResponse
    do {
      (data, response) = try await session.data(for: r)
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
  /// After a push the server took, with the highest version it gave.
  public var onPushed: ((Int) -> Void)?
  /// After the pulls of a cycle, with the store's cursor.
  public var onPulled: ((Int) -> Void)?
  /// When a cycle last ended synced.
  public private(set) var lastSynced: Date?
  private let makeTransport: (SpaceState, SpaceKeys) -> Transport?
  private let now: () -> Date
  private var running = false, again = false, stopped = false, heldTried = false
  private var failures = 0, tooLong = 0
  /// Ids whose newer server record cannot be decoded; their local edits wait instead of being resent.
  private var blocked: Set<String> = []
  private var retryAt: Date?
  private var soon: Task<Void, Never>?

  public init(
    store: Store, now: @escaping () -> Date = Date.init,
    transport: @escaping (SpaceState, SpaceKeys) -> Transport? = { s, k in HTTPTransport(server: s.server ?? "", space: s.space ?? "", token: k.token) }
  ) {
    self.store = store
    self.now = now
    makeTransport = transport
  }

  /// One cycle; a call during a cycle runs another after it.
  public func sync() async {
    if running {
      again = true
      return
    }
    running = true
    defer { running = false }
    repeat {
      again = false
      await cycle()
    } while again
  }

  /// A cycle a second from now, once however many changes come meanwhile.
  public func changed() {
    soon?.cancel()
    soon = Task { [weak self] in
      try? await Task.sleep(for: .seconds(1))
      guard !Task.isCancelled else { return }
      await self?.sync()
    }
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
    do {
      flushLocal?()
      if !heldTried {
        heldTried = true
        retryHeld(keys)
      }
      while true {
        let page = try await transport.pull(since: store.state.cursor)
        guard same() else { return }
        note(relay: page.relay)
        if store.note(epoch: page.epoch) { continue }
        flushLocal?()
        store.merge(page.records.compactMap { decode($0, keys) })
        store.advance(to: page.cursor)
        if page.records.count < Self.pageSize {
          store.resynced()
          break
        }
      }
      onPulled?(store.state.cursor)
      var refusals = 0
      for _ in 0..<10 {
        flushLocal?()
        let (writes, sent) = outgoing(keys)
        if writes.isEmpty { break }
        let result = try await transport.push(writes)
        guard same() else { return }
        if store.note(epoch: result.epoch) {
          again = true
          return
        }
        for a in result.accepted { if let r = sent[a.id] { store.accepted(a.id, version: a.version, record: r) } }
        note(relay: result.relay)
        if let top = result.accepted.map(\.version).max() { onPushed?(top) }
        if result.refused.isEmpty { continue }
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
      failures += 1
      retryAt = now().addingTimeInterval(min(60, 5 * pow(2, Double(failures - 1))))
      update(error as? TransportError == .offline ? .offline : .unreachable)
    }
  }

  private func note(relay r: String?) {
    let valid = r.flatMap { $0.hasPrefix("wss://") || $0.hasPrefix("ws://") ? $0 : nil }
    guard valid != relay else { return }
    relay = valid
    onRelay?(valid)
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

  private func outgoing(_ keys: SpaceKeys) -> ([Write], [String: Record]) {
    var writes: [Write] = [], sent: [String: Record] = [:], size = 0
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
      writes.append(w)
      sent[p.id] = p.record
    }
    return (writes, sent)
  }

  private func update(_ state: SyncStatus.State) {
    status = SyncStatus(
      state: state, at: state == .synced ? now() : status.at, waiting: store.pending.count,
      unreadable: store.state.unreadable, held: store.state.held.count, tooLong: tooLong)
    onStatus?(status)
  }
}
