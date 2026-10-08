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
