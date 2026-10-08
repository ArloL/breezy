import Foundation
@testable import BreezyKit

/// The server's rules, in memory.
final class FakeServer {
  var records: [String: Pulled] = [:]
  var version = 0
  /// Nil until the space's first write, and again after `wipe`.
  var epoch: String?

  func pull(since: Int) -> Page {
    let r = Array(records.values.filter { $0.version > since }.sorted { $0.version < $1.version }.prefix(SyncEngine.pageSize))
    return Page(records: r, cursor: r.last?.version ?? since, epoch: epoch)
  }

  func push(_ writes: [Write]) -> PushResult {
    var accepted: [Accepted] = [], refused: [Pulled] = []
    epoch = epoch ?? newID()
    for w in writes {
      if let stored = records[w.id], stored.version != w.base {
        refused.append(stored)
        continue
      }
      version += 1
      records[w.id] = Pulled(id: w.id, version: version, blob: w.blob)
      accepted.append(Accepted(id: w.id, version: version))
    }
    return PushResult(accepted: accepted, refused: refused, epoch: epoch)
  }

  /// The database as a backup holds it.
  func snapshot() -> (records: [String: Pulled], version: Int) { (records, version) }

  /// The backup put back, with a new epoch as the README says to give it.
  func restore(_ s: (records: [String: Pulled], version: Int)) {
    records = s.records
    version = s.version
    epoch = newID()
  }

  /// The space lost.
  func wipe() {
    records = [:]
    version = 0
    epoch = nil
  }

  /// Adds a record as another device would.
  func put(_ id: String, blob: String) {
    epoch = epoch ?? newID()
    version += 1
    records[id] = Pulled(id: id, version: version, blob: blob)
  }
}

final class FakeTransport: Transport {
  let server: FakeServer
  var online = true
  var failure: TransportError?
  var calls = 0
  /// Runs before each pull, as another part of the app might while a request is out.
  var beforePull: (() -> Void)?

  init(_ server: FakeServer) { self.server = server }

  func pull(since: Int) async throws -> Page {
    beforePull?()
    try check()
    return server.pull(since: since)
  }

  func push(_ writes: [Write]) async throws -> PushResult {
    try check()
    return server.push(writes)
  }

  private func check() throws {
    calls += 1
    if let failure { throw failure }
    if !online { throw TransportError.offline }
  }
}

let testServer = "https://example.com/breezy/sync.php"

@MainActor final class Device {
  let store = Store()
  let transport: FakeTransport
  let engine: SyncEngine

  init(_ server: FakeServer, joining invite: Invite? = nil) {
    let t = FakeTransport(server)
    transport = t
    engine = SyncEngine(store: store, transport: { _, _ in t })
    if let invite { store.join(invite) }
  }

  /// Changes board `id` as the app does.
  func edit(_ id: String, _ change: (inout Board) -> Void) {
    let old = store.board(id)
    var new = old
    change(&new)
    store.apply(Records.changes(from: old, to: new, board: id, orders: store.orders(of: id)))
  }
}

/// Two devices in one space with a board holding one card, both synced.
@MainActor func pair() async -> (FakeServer, Device, Device, String) {
  let server = FakeServer()
  let a = Device(server)
  let invite = a.store.startSyncing(server: testServer)
  let id = a.store.createBoard(title: "Plans", contents: board([card(newID(), 0, 0, "x")]))
  await a.engine.sync()
  let b = Device(server, joining: invite)
  await b.engine.sync()
  return (server, a, b, id)
}

struct SplitMix: RandomNumberGenerator {
  var state: UInt64

  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }
}
