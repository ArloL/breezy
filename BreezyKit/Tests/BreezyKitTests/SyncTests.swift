import Foundation
import Testing
@testable import BreezyKit

@MainActor @Test func aJoiningDeviceGetsTheBoards() async {
  let (_, a, b, id) = await pair()
  #expect(b.store.boards.map(\.title) == ["Plans"])
  #expect(b.store.board(id) == a.store.board(id))
  #expect(a.engine.status.state == .synced)
  #expect(a.store.pending.isEmpty && b.store.pending.isEmpty)
}

@MainActor @Test func editsToDifferentFieldsOfACardCombine() async {
  let (_, a, b, id) = await pair()
  let c = a.store.board(id).cards[0].id
  a.edit(id) { $0.setColor([c], 3) }
  b.edit(id) { $0.setText(c, "y") }
  await a.engine.sync()
  await b.engine.sync()
  await a.engine.sync()
  for d in [a, b] {
    #expect(d.store.board(id).cards.map(\.color) == [3])
    #expect(d.store.board(id).cards.map(\.text) == ["y"])
  }
}

@MainActor @Test func textEditedOnBothSidesEndsAsTwoCards() async {
  let (_, a, b, id) = await pair()
  let c = a.store.board(id).cards[0].id
  a.edit(id) { $0.setText(c, "from a") }
  b.edit(id) { $0.setText(c, "from b") }
  await a.engine.sync()
  await b.engine.sync()
  await a.engine.sync()
  for d in [a, b] { #expect(d.store.board(id).cards.map(\.text).sorted() == ["from a", "from b"]) }
}

@MainActor @Test func offlineChangesWaitAndAreCounted() async {
  let (_, a, _, id) = await pair()
  a.transport.online = false
  a.edit(id) { $0.addCard(x: 0, y: 0) }
  await a.engine.sync()
  #expect(a.engine.status.state == .offline)
  #expect(a.engine.status.lines() == ["Offline — 1 change waiting"])
  a.transport.online = true
  let calls = a.transport.calls
  await a.engine.sync()
  #expect(a.transport.calls == calls)
  a.engine.reset()
  await a.engine.sync()
  #expect(a.engine.status.state == .synced)
  #expect(a.engine.status.lines() == ["Synced just now"])
  #expect(a.store.pending.isEmpty)
}

@MainActor @Test func aRefusedTokenStopsSyncing() async {
  let (_, a, _, _) = await pair()
  a.transport.failure = .unauthorized
  await a.engine.sync()
  #expect(a.engine.status.lines() == ["Not in this space any more"])
  let calls = a.transport.calls
  await a.engine.sync()
  #expect(a.transport.calls == calls)
}

@MainActor @Test func anUnreachableServerIsSaidSo() async {
  let (_, a, _, _) = await pair()
  a.transport.failure = .unreachable
  await a.engine.sync()
  #expect(a.engine.status.lines() == ["Can’t reach server"])
}

@MainActor @Test func anUnreadableRecordIsSkippedAndCounted() async {
  let (server, a, _, _) = await pair()
  server.put(newID(), blob: "AAAA")
  await a.engine.sync()
  #expect(a.store.state.unreadable == 1)
  #expect(a.store.state.cursor == server.version)
  #expect(a.engine.status.lines().contains("1 unreadable change"))
}

@MainActor @Test func aRecordFromANewerBreezyWaits() async throws {
  let (server, a, _, _) = await pair()
  let keys = try SpaceKeys(state: a.store.state)
  let id = newID()
  let plain = try JSONEncoder().encode(Record(["format": .number(2), "kind": .string("board"), "title": .string("Later")]))
  server.put(id, blob: Base64URL.encode(try keys.seal(plain, id: Base64URL.decode(id)!)))
  await a.engine.sync()
  #expect(a.store.state.held[id] != nil)
  #expect(!a.store.boards.map(\.title).contains("Later"))
  #expect(a.engine.status.lines().contains("Update Breezy to see all changes"))
}

@MainActor @Test func aCardTooLongToSyncStaysHere() async {
  let (_, a, _, id) = await pair()
  let c = a.store.board(id).cards[0].id
  a.edit(id) { $0.setText(c, String(repeating: "x", count: 70_000)) }
  await a.engine.sync()
  #expect(a.engine.status.lines().contains("Card too long to sync"))
  #expect(a.store.pending.map(\.id) == [c])
}

@MainActor @Test func pullsComeInPages() async {
  let server = FakeServer()
  let a = Device(server)
  let invite = a.store.startSyncing(server: testServer)
  let cards = (0..<600).map { card(newID(), 0, Double($0) * 24) }
  let id = a.store.createBoard(title: "Big", contents: board(cards))
  await a.engine.sync()
  let b = Device(server, joining: invite)
  await b.engine.sync()
  #expect(b.store.board(id).cards.count == 600)
}

@MainActor @Test func localEditsAreFlushedBeforeAMerge() async {
  let (_, a, b, id) = await pair()
  let c = a.store.board(id).cards[0].id
  b.edit(id) { $0.setText(c, "theirs") }
  await b.engine.sync()
  var flushed = 0
  a.engine.flushLocal = { flushed += 1 }
  await a.engine.sync()
  #expect(flushed >= 2)
  #expect(a.store.board(id).card(c)?.text == "theirs")
}

@MainActor @Test func fourDevicesEndTheSame() async {
  let server = FakeServer()
  let first = Device(server)
  let invite = first.store.startSyncing(server: testServer)
  let id = first.store.createBoard(title: "Plans")
  await first.engine.sync()
  let devices = [first] + (0..<3).map { _ in Device(server, joining: invite) }
  var rng = SplitMix(state: 42)
  for _ in 0..<300 {
    let d = devices[Int.random(in: 0..<4, using: &rng)]
    switch Int.random(in: 0..<10, using: &rng) {
    case 0:
      d.transport.online.toggle()
    case 1...3:
      d.engine.reset()
      await d.engine.sync()
    default:
      let pick = Int.random(in: 0..<6, using: &rng)
      let n = Int.random(in: 0..<1000, using: &rng)
      d.edit(id) { b in
        let i = b.cards.isEmpty ? nil : n % b.cards.count
        switch (pick, i) {
        case (0, _): b.addCard(x: Double(n % 20) * 24, y: 0)
        case (1, let i?): b.setText(b.cards[i].id, "t\(n)")
        case (2, let i?): b.setColor([b.cards[i].id], n % 5 + 1)
        case (3, let i?): b.moveCards([Origin(id: b.cards[i].id, x: b.cards[i].x, y: b.cards[i].y)], dx: 24, dy: 24)
        case (4, let i?): b.remove([b.cards[i].id])
        case (5, let i?):
          let c = b.cards.remove(at: i)
          b.cards.append(c)
        default: break
        }
      }
    }
  }
  for d in devices {
    d.transport.online = true
    d.engine.reset()
  }
  for _ in 0..<3 { for d in devices { await d.engine.sync() } }
  let expected = devices[0].store.board(id)
  for d in devices {
    #expect(d.store.pending.isEmpty)
    #expect(d.store.board(id) == expected)
  }
}

@MainActor @Test func aRefusalWeCannotReadLeavesTheEditWaiting() async throws {
  let (server, a, _, id) = await pair()
  let c = a.store.board(id).cards[0].id
  a.edit(id) { $0.setText(c, "mine") }
  let keys = try SpaceKeys(state: a.store.state)
  let plain = try JSONEncoder().encode(Record(["format": .number(2), "kind": .string("card")]))
  server.put(c, blob: Base64URL.encode(try keys.seal(plain, id: Base64URL.decode(c)!)))
  await a.engine.sync()
  let unreadable = a.store.state.unreadable
  await a.engine.sync()
  #expect(a.engine.status.state == .synced)
  #expect(a.engine.status.lines().contains("Update Breezy to see all changes"))
  #expect(a.store.pending.map(\.id) == [c])
  #expect(a.store.state.unreadable == unreadable)
}

@MainActor @Test(arguments: [TransportError.unreachable, .unauthorized])
func aFailureInTheOldSpaceLeavesTheNewOneFreeToSync(_ failure: TransportError) async {
  let invite = Store().startSyncing(server: testServer)
  let a = Device(FakeServer())
  a.store.startSyncing(server: testServer)
  a.transport.failure = failure
  a.transport.beforePull = { a.store.join(invite) }
  await a.engine.sync()
  #expect(a.engine.status.state == .local)
  a.transport.failure = nil
  a.transport.beforePull = nil
  let calls = a.transport.calls
  await a.engine.sync()
  #expect(a.transport.calls > calls)
  #expect(a.engine.status.state == .synced)
}

/// Two synced devices, a backup, edits on both, the backup restored, more edits on both, then syncs in `order`
/// ("ab" or "ba"). When `behind`, a edits the card before the backup and b sees nothing after pairing until the
/// restore. Returns the devices, the board, a's card edited after the restore, and the cards b added.
@MainActor func restored(_ order: String, behind: Bool = false, ids: () -> String = newID) async
  -> (Device, Device, String, String, [String])
{
  let (server, a, b, id) = await pair(ids: ids)
  let c = a.store.board(id).cards[0].id
  if behind {
    a.edit(id) { $0.setText(c, "seen by backup") }
    await a.engine.sync()
  }
  let backup = server.snapshot()
  let added = [ids(), ids()]
  a.edit(id) { $0.setColor([c], 3) }
  b.edit(id) { $0.cards.append(card(added[0], 0, 100)) }
  for d in behind ? [a] : [a, b, a] { await d.engine.sync() }
  server.restore(backup)
  a.edit(id) { $0.setText(c, "after") }
  b.edit(id) { $0.cards.append(card(added[1], 0, 200)) }
  for _ in 0..<3 { for d in order == "ab" ? [a, b] : [b, a] { await d.engine.sync() } }
  return (a, b, id, c, added)
}

@MainActor @Test(arguments: ["ab", "ba"]) func devicesRecoverFromARestoredServer(_ order: String) async {
  let (a, b, id, c, added) = await restored(order)
  let expected = a.store.board(id)
  #expect(b.store.board(id) == expected)
  #expect(expected.cards.count == 3)
  #expect(expected.card(c)?.color == 3)
  #expect(expected.card(c)?.text == "after")
  for card in added { #expect(expected.card(card) != nil) }
  for d in [a, b] {
    #expect(d.store.pending.isEmpty)
    #expect(d.engine.status.state == .synced)
    #expect(!d.store.state.resync)
  }
}

@MainActor @Test func aLateResyncKeepsWhatOthersDidSince() async {
  let (server, a, b, id) = await pair()
  let c = a.store.board(id).cards[0].id
  var d = ""
  a.edit(id) { d = $0.addCard(x: 0, y: 100) }
  for x in [a, b] { await x.engine.sync() }
  let backup = server.snapshot()
  a.edit(id) { $0.setColor([c], 3) }
  for x in [a, b] { await x.engine.sync() }
  server.restore(backup)
  for _ in 0..<5 { await a.engine.sync() }
  a.edit(id) {
    $0.setText(c, "after")
    $0.remove([d])
  }
  await a.engine.sync()
  for _ in 0..<2 { for x in [b, a] { await x.engine.sync() } }
  for x in [a, b] {
    #expect(x.store.board(id).cards.map(\.text) == ["after"])
    #expect(x.store.board(id).card(c)?.color == 3)
    #expect(x.store.pending.isEmpty)
    #expect(x.engine.status.state == .synced)
  }
}

@MainActor @Test func aDeviceBehindTheBackupKeepsWhatItHas() async {
  let (server, a, b, id) = await pair()
  let c = a.store.board(id).cards[0].id
  var d = ""
  a.edit(id) { d = $0.addCard(x: 0, y: 100) }
  for x in [a, b] { await x.engine.sync() }
  a.edit(id) {
    $0.setText(c, "seen by backup")
    $0.remove([d])
  }
  await a.engine.sync()
  server.restore(server.snapshot())
  await a.engine.sync()
  for _ in 0..<2 { for x in [b, a] { await x.engine.sync() } }
  for x in [a, b] {
    #expect(x.store.board(id).cards.map(\.text) == ["seen by backup"])
    #expect(x.store.pending.isEmpty)
    #expect(x.engine.status.state == .synced)
  }
}

@MainActor @Test func overlappingResyncsMakeNoCopies() async {
  let (server, a, b, id) = await pair()
  let c = a.store.board(id).cards[0].id
  let backup = server.snapshot()
  a.edit(id) { $0.setText(c, "only a") }
  await a.engine.sync()
  server.restore(backup)
  var once = true
  a.transport.beforePush = {
    guard once else { return }
    once = false
    await b.engine.sync()
  }
  await a.engine.sync()
  for _ in 0..<2 { for x in [b, a] { await x.engine.sync() } }
  for x in [a, b] {
    #expect(x.store.board(id).cards.map(\.text) == ["only a"])
    #expect(x.store.pending.isEmpty)
    #expect(x.engine.status.state == .synced)
  }
}

@MainActor @Test func devicesRefillALostSpace() async {
  let (server, a, b, id) = await pair()
  server.wipe()
  b.edit(id) { _ = $0.addCard(x: 0, y: 100) }
  await b.engine.sync()
  #expect(server.records.count == 3)
  #expect(server.epoch == b.store.state.epoch)
  a.edit(id) { _ = $0.addCard(x: 0, y: 200) }
  for _ in 0..<2 { for d in [a, b] { await d.engine.sync() } }
  #expect(a.store.board(id).cards.count == 3)
  #expect(b.store.board(id) == a.store.board(id))
  for d in [a, b] {
    #expect(d.store.pending.isEmpty)
    #expect(d.engine.status.state == .synced)
  }
}

@MainActor @Test func restoresEndTheSameWhateverTheIDs() async {
  for run in 0..<200 {
    let (a, b, id, c, added) = await restored(run % 2 == 0 ? "ab" : "ba", behind: run % 4 >= 2, ids: seededIDs(UInt64(run)))
    let expected = a.store.board(id)
    #expect(b.store.board(id) == expected, "run \(run)")
    #expect(expected.card(c)?.text == "after" && added.allSatisfy { expected.card($0) != nil }, "run \(run)")
    for d in [a, b] {
      #expect(d.store.pending.isEmpty && d.engine.status.state == .synced && !d.store.state.resync, "run \(run)")
    }
  }
}

@MainActor @Test func theEngineLearnsTheRelayAndReportsPushesAndPulls() async {
  let (server, a, b, id) = await pair()
  var relays: [String?] = [], pushed: [Int] = [], pulled: [Int] = []
  a.engine.onRelay = { relays.append($0) }
  a.engine.onPushed = { pushed.append($0.version) }
  a.engine.onPulled = { pulled.append($0) }
  server.relay = "wss://relay.example/"
  let c = a.store.board(id).cards[0].id
  a.edit(id) { $0.setColor([c], 2) }
  await a.engine.sync()
  #expect(a.engine.relay == "wss://relay.example/")
  #expect(relays == ["wss://relay.example/"])
  #expect(pushed == [server.version])
  #expect(pulled == [server.version])
  #expect(a.engine.lastSynced != nil)
  server.relay = "http://not-a-relay"
  await b.engine.sync()
  #expect(b.engine.relay == nil)
}

@MainActor @Test func onlyWebSocketsOverTLSOrToThisComputerAreRelays() async {
  let (server, a, _, id) = await pair()
  for (relay, valid) in [
    ("wss://relay.example/", true), ("ws://127.0.0.1:58568/", true), ("ws://localhost:58568/", true),
    ("ws://relay.example/", false), ("https://relay.example/", false),
  ] {
    server.relay = relay
    a.edit(id) { $0.addCard(x: 0, y: 0) }
    await a.engine.sync()
    #expect(a.engine.relay == (valid ? relay : nil), "\(relay)")
  }
}

@MainActor @Test func aSyncCalledDuringACycleReturnsOnceItsChangesArePushed() async {
  let (server, a, _, id) = await pair()
  var second: Task<Void, Never>?
  var pendingAtReturn: Int?
  a.transport.beforePush = {
    guard second == nil else { return }
    second = Task {
      a.edit(id) { $0.addCard(x: 0, y: 200) }
      await a.engine.sync()
      pendingAtReturn = a.store.pending.count
    }
    for _ in 0..<3 { await Task.yield() }
  }
  a.edit(id) { $0.addCard(x: 0, y: 0) }
  await a.engine.sync()
  await second?.value
  #expect(pendingAtReturn == 0)
  #expect(server.records.count == 4)
}

@MainActor @Test func anEditSyncsInOneRequest() async {
  let (_, a, b, id) = await pair()
  let c = a.store.board(id).cards[0].id
  a.edit(id) { $0.setColor([c], 3) }
  a.transport.calls = 0
  await a.engine.sync()
  #expect(a.transport.calls == 1)
  await b.engine.sync()
  #expect(b.store.board(id).cards[0].color == 3)
}

@MainActor @Test func aDeviceNeverPullsBackWhatItPushed() async {
  let (_, a, b, id) = await pair()
  let c = a.store.board(id).cards[0].id
  a.transport.accepted = []
  a.transport.received = []
  a.edit(id) { $0.setColor([c], 3) }
  await a.engine.sync()
  b.edit(id) { $0.setText(c, "y") }
  await b.engine.sync()
  a.edit(id) { $0.setColor([c], 4) }
  await a.engine.sync()
  await a.engine.sync()
  #expect(!a.transport.accepted.isEmpty)
  #expect(!a.transport.received.isEmpty)
  #expect(a.transport.received.filter { a.transport.accepted.contains($0) }.isEmpty)
}

@MainActor @Test func whatBecomesPendingDuringThePullIsPushedInTheSameSync() async {
  let (_, a, b, id) = await pair()
  let c = a.store.board(id).cards[0].id
  b.edit(id) { $0.setText(c, "y") }
  await b.engine.sync()
  var pulled = false, edited = false
  a.transport.beforePull = { pulled = true }
  a.engine.flushLocal = {
    guard pulled, !edited else { return }
    edited = true
    a.edit(id) { $0.setColor([c], 3) }
  }
  await a.engine.sync()
  #expect(edited)
  #expect(a.store.pending.isEmpty)
  a.engine.flushLocal = nil
  await b.engine.sync()
  #expect(b.store.board(id).cards[0].color == 3)
}

@MainActor @Test func aDeviceWithAnEditPendingWritesNothingToARestoredServer() async {
  let (server, a, b, id) = await pair()
  let c = a.store.board(id).cards[0].id
  let backup = server.snapshot()
  b.edit(id) { $0.setText(c, "later") }
  await b.engine.sync()
  server.restore(backup)
  a.edit(id) { $0.setColor([c], 3) }
  let before = server.version
  var first = true
  a.transport.afterPush = {
    if first { #expect(server.version == before) }
    first = false
  }
  await a.engine.sync()
  for d in [b, a, b, a] { await d.engine.sync() }
  for d in [a, b] {
    #expect(d.store.board(id).cards[0].color == 3)
    #expect(d.store.pending.isEmpty)
  }
}

@MainActor @Test func aCombinedPushThatBringsAFullPageGoesOnPulling() async {
  let (server, a, b, id) = await pair()
  let other = b.store.createBoard(title: "Big", contents: board((0..<600).map { card(newID(), 0, Double($0) * 24, "t") }))
  await b.engine.sync()
  let c = a.store.board(id).cards[0].id
  a.edit(id) { $0.setColor([c], 3) }
  await a.engine.sync()
  #expect(a.store.board(other).cards.count == 600)
  #expect(a.store.state.cursor == server.version)
}

@MainActor @Test func aFullPageThatHeldThisPushsOwnWriteGoesOnPulling() async {
  let (server, a, _, id) = await pair()
  server.afterWrites = {
    server.afterWrites = nil
    for _ in 0..<SyncEngine.pageSize { server.put(newID(), blob: "AAAA") }
  }
  let c = a.store.board(id).cards[0].id
  a.edit(id) { $0.setColor([c], 3) }
  await a.engine.sync()
  #expect(a.store.state.cursor == server.version)
}

@MainActor @Test func aResyncDoesNotCombine() async {
  let (server, a, _, id) = await pair()
  let c = a.store.board(id).cards[0].id
  let backup = server.snapshot()
  a.edit(id) { $0.setColor([c], 3) }
  await a.engine.sync()
  server.restore(backup)
  a.edit(id) { $0.setColor([c], 2) }
  a.transport.log = []
  a.transport.pushArgs = []
  await a.engine.sync()
  #expect(Array(a.transport.log.prefix(2)) == ["push", "pull"])
  #expect(a.transport.pushArgs.count > 1 && a.transport.pushArgs[1].since == nil && a.transport.pushArgs[1].epoch == nil)
  #expect(a.store.pending.isEmpty)
}

/// What `a` pushes for an edit, as `onPushed` reports it.
@MainActor private func pushedBy(_ a: Device, _ id: String, color: Int = 3) async -> Pushed {
  var out: Pushed?
  a.engine.onPushed = { out = $0 }
  let c = a.store.board(id).cards[0].id
  a.edit(id) { $0.setColor([c], color) }
  await a.engine.sync()
  return out!
}

@MainActor @Test func recordsAnotherDeviceJustPushedAreAppliedWithoutAPull() async {
  let (server, a, b, id) = await pair()
  let p = await pushedBy(a, id)
  #expect(p.epoch == server.epoch)
  #expect(p.records.map(\.version) == [server.version])
  var pulled: [Int] = []
  b.engine.onPulled = { pulled.append($0) }
  let calls = b.transport.calls
  #expect(await b.engine.receivePushed(p))
  #expect(b.transport.calls == calls)
  #expect(b.store.state.cursor == server.version)
  #expect(pulled == [server.version])
  #expect(b.store.board(id).cards[0].color == 3)
}

@MainActor @Test func pushedRecordsThatDoNotFollowOnAreNotApplied() async {
  let (_, a, b, id) = await pair()
  let p = await pushedBy(a, id)
  let cursor = b.store.state.cursor, calls = b.transport.log.count
  let color = b.store.board(id).cards[0].color
  let second = await pushedBy(a, id, color: 4)
  func shifted(_ x: Pushed, _ by: (Int) -> Int) -> Pushed {
    var x = x
    x.records = x.records.enumerated().map { var r = $1; r.version += by($0); return r }
    return x
  }
  var other = p
  other.epoch = "other"
  var both = p
  both.records = p.records + second.records
  for bad in [
    other,
    shifted(second) { _ in 5 },
    shifted(both) { $0 * 2 },
    second,
    Pushed(version: p.version, epoch: p.epoch, records: []),
  ] {
    #expect(await b.engine.receivePushed(bad) == false)
    #expect(b.store.state.cursor == cursor)
    #expect(b.store.board(id).cards[0].color == color)
  }
  #expect(b.transport.log.count == calls)
}

@MainActor @Test func anUnreadablePushedRecordIsCountedAsInAPull() async {
  let (_, a, b, id) = await pair()
  var p = await pushedBy(a, id)
  p.records[0].blob = "AAAA"
  #expect(await b.engine.receivePushed(p))
  #expect(b.store.state.unreadable == 1)
  #expect(b.store.state.cursor == p.version)
}

@MainActor @Test func pushedRecordsReceivedDuringACycleWaitForItAndBothEndConsistent() async {
  let (_, a, b, id) = await pair()
  let c = a.store.board(id).cards[0].id
  let p = await pushedBy(a, id)
  b.edit(id) { $0.setText(c, "y") }
  let cursor = b.store.state.cursor
  var received: Task<Bool, Never>?
  var cursorMeanwhile: Int?
  b.transport.beforePush = {
    guard received == nil else { return }
    received = Task { await b.engine.receivePushed(p) }
    for _ in 0..<3 { await Task.yield() }
    cursorMeanwhile = b.store.state.cursor
  }
  await b.engine.sync()
  #expect(await received?.value == true)
  #expect(cursorMeanwhile == cursor)
  #expect(b.store.pending.isEmpty)
  #expect(b.store.state.cursor == p.version + 1)
  await a.engine.sync()
  for d in [a, b] {
    #expect(d.store.board(id).cards[0].color == 3)
    #expect(d.store.board(id).cards[0].text == "y")
  }
}

private final class RecordingProtocol: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var requests: [(encoding: String?, body: Data)] = []

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func stopLoading() {}

  override func startLoading() {
    var body = Data()
    if let s = request.httpBodyStream {
      s.open()
      var buffer = [UInt8](repeating: 0, count: 65_536)
      while s.hasBytesAvailable {
        let n = s.read(&buffer, maxLength: buffer.count)
        if n <= 0 { break }
        body.append(buffer, count: n)
      }
      s.close()
    }
    Self.requests.append((request.value(forHTTPHeaderField: "Content-Encoding"), body))
    let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(#"{"accepted":[],"refused":[]}"#.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
}

@Test func bigRequestsGoDeflatedAndSmallOnesPlain() async throws {
  let config = URLSessionConfiguration.ephemeral
  config.protocolClasses = [RecordingProtocol.self]
  let t = HTTPTransport(server: testServer, space: "sp", token: Data(count: 16), session: URLSession(configuration: config))!
  let big = [Write(id: "a", base: 0, blob: String(repeating: "x", count: 3000))]
  let small = [Write(id: "a", base: 0, blob: "y")]
  _ = try await t.push(big, since: 7, epoch: "e")
  _ = try await t.push(small, since: nil, epoch: nil)
  let (first, second) = (RecordingProtocol.requests[0], RecordingProtocol.requests[1])
  #expect(first.encoding == "deflate")
  let plain = try (first.body as NSData).decompressed(using: .zlib) as Data
  #expect(try JSONDecoder().decode([String: JSONValue].self, from: plain) == [
    "writes": .array([.object(["id": .string("a"), "base": .number(0), "blob": .string(big[0].blob)])]),
    "since": .number(7), "epoch": .string("e"),
  ])
  #expect(second.encoding == nil)
  #expect(try JSONDecoder().decode([String: JSONValue].self, from: second.body).keys.sorted() == ["writes"])
}

@MainActor @Test func pushedRecordsThisDeviceAlreadyHasStillReportItsCursor() async {
  let (_, a, b, id) = await pair()
  let p = await pushedBy(a, id)
  await b.engine.sync()
  var pulled: [Int] = []
  b.engine.onPulled = { pulled.append($0) }
  #expect(await b.engine.receivePushed(p))
  #expect(pulled == [b.store.state.cursor])
}

@MainActor @Test func aCombinedCycleReportsTheCursorOfThePageItTookBeforeALaterRoundFails() async {
  let (server, a, _, id) = await pair()
  var pulled: [Int] = []
  a.engine.onPulled = { pulled.append($0) }
  let c = a.store.board(id).cards[0].id
  a.transport.afterPush = {
    a.transport.afterPush = nil
    a.transport.failure = .unreachable
    a.edit(id) { $0.setColor([c], 5) }
  }
  a.edit(id) { $0.setColor([c], 3) }
  await a.engine.sync()
  #expect(Array(a.transport.log.suffix(2)) == ["push", "push"])
  #expect(a.engine.status.state == .unreachable)
  #expect(pulled == [server.version])
}
