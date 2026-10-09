import Foundation
@testable import BreezyKit

/// The server's rules, in memory.
final class FakeServer {
  typealias Backup = (records: [String: Pulled], written: [String: String], version: Int)
  var records: [String: Pulled] = [:]
  /// The epoch each record was written in.
  var written: [String: String] = [:]
  var version = 0
  /// Nil until the space's first write, and again after `wipe`.
  var epoch: String?
  /// What the server names as its relay, if anything.
  var relay: String?

  func pull(since: Int) -> Page {
    let r = records.values.filter { $0.version > since }.sorted { $0.version < $1.version }.prefix(SyncEngine.pageSize)
    return Page(records: r.map(marked), cursor: r.last?.version ?? since, epoch: epoch, relay: relay)
  }

  func push(_ writes: [Write]) -> PushResult {
    var accepted: [Accepted] = [], refused: [Pulled] = []
    let epoch = epoch ?? newID()
    self.epoch = epoch
    for w in writes {
      if let stored = records[w.id], stored.version != w.base {
        refused.append(marked(stored))
        continue
      }
      version += 1
      records[w.id] = Pulled(id: w.id, version: version, blob: w.blob)
      written[w.id] = epoch
      accepted.append(Accepted(id: w.id, version: version))
    }
    return PushResult(accepted: accepted, refused: refused, epoch: epoch, relay: relay)
  }

  private func marked(_ r: Pulled) -> Pulled {
    var r = r
    if written[r.id] != epoch { r.stale = true }
    return r
  }

  /// The database as a backup holds it.
  func snapshot() -> Backup { (records, written, version) }

  /// The backup put back, with a new epoch as the README says to give it.
  func restore(_ b: Backup) {
    (records, written, version) = b
    epoch = newID()
  }

  /// The space lost.
  func wipe() {
    (records, written, version, epoch) = ([:], [:], 0, nil)
  }

  /// Adds a record as another device would.
  func put(_ id: String, blob: String) {
    epoch = epoch ?? newID()
    version += 1
    records[id] = Pulled(id: id, version: version, blob: blob)
    written[id] = epoch
  }
}

final class FakeTransport: Transport {
  let server: FakeServer
  var online = true
  var failure: TransportError?
  var calls = 0
  /// Runs before each pull, as another part of the app might while a request is out.
  var beforePull: (() -> Void)?
  /// Runs before each push, as another device might sync meanwhile.
  var beforePush: (() async -> Void)?

  init(_ server: FakeServer) { self.server = server }

  func pull(since: Int) async throws -> Page {
    beforePull?()
    try check()
    return server.pull(since: since)
  }

  func push(_ writes: [Write]) async throws -> PushResult {
    await beforePush?()
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

/// Two devices in one space with a board holding one card, both synced; `ids` names the board and the card.
@MainActor func pair(ids: () -> String = newID) async -> (FakeServer, Device, Device, String) {
  let server = FakeServer()
  let a = Device(server)
  let invite = a.store.startSyncing(server: testServer)
  let id = ids()
  var changes = Records.changes(from: Board(), to: board([card(ids(), 0, 0, "x")]), board: id, orders: [:])
  changes[id] = .fields(Records.board(title: "Plans").fields)
  a.store.apply(changes)
  await a.engine.sync()
  let b = Device(server, joining: invite)
  await b.engine.sync()
  return (server, a, b, id)
}

/// Ids from a seeded generator, so that a run replays.
func seededIDs(_ seed: UInt64) -> () -> String {
  var rng = SplitMix(state: seed)
  return { Base64URL.encode(Data((0..<16).map { _ in UInt8.random(in: 0...255, using: &rng) })) }
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
