import Foundation
import Testing
@testable import BreezyKit

private func tempDirectory() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString) }

/// A fake server per space, made on first use.
final class Servers {
  var bySpace: [String: FakeServer] = [:]

  func server(_ space: String) -> FakeServer {
    if let s = bySpace[space] { return s }
    let s = FakeServer()
    bySpace[space] = s
    return s
  }

  func transport(_ state: SpaceState, _ keys: SpaceKeys) -> Transport? { FakeTransport(server(state.space!)) }
}

@MainActor @Test func aStoreFromBeforeSpacesBecomesItsSpace() throws {
  let dir = tempDirectory()
  let old = Store()
  old.startSyncing(server: testServer)
  let id = old.createBoard(title: "Plans")
  old.advance(to: 7)
  try StoreFile(url: dir.appendingPathComponent("space.json")).saveNow(old.state)
  let spaces = try Spaces(directory: dir)
  #expect(!FileManager.default.fileExists(atPath: dir.appendingPathComponent("space.json").path))
  #expect(FileManager.default.fileExists(atPath: dir.appendingPathComponent("Spaces/\(old.state.space!).json").path))
  #expect(spaces.spaces.count == 1)
  #expect(spaces.spaces[0].store.state == old.state)
  #expect(spaces.group(of: id) === spaces.spaces[0])
  #expect(spaces.local.store.boards.isEmpty)
}

@MainActor @Test func aStoreThatNeverSyncedBecomesOnThisDevice() throws {
  let dir = tempDirectory()
  let old = Store()
  _ = old.createBoard(title: "Plans")
  try StoreFile(url: dir.appendingPathComponent("space.json")).saveNow(old.state)
  let spaces = try Spaces(directory: dir)
  #expect(spaces.spaces.isEmpty)
  #expect(spaces.local.store.boards.map(\.title) == ["Plans"])
  #expect(spaces.local.name == "On this device")
}

@MainActor @Test func anInterruptedMigrationRunsAgain() throws {
  let dir = tempDirectory()
  let old = Store()
  old.startSyncing(server: testServer)
  _ = old.createBoard(title: "Plans")
  try StoreFile(url: dir.appendingPathComponent("space.json")).saveNow(old.state)
  try StoreFile(url: dir.appendingPathComponent("Spaces/\(old.state.space!).json")).saveNow(old.state)
  let spaces = try Spaces(directory: dir)
  #expect(spaces.spaces.count == 1)
  #expect(spaces.spaces[0].store.boards.map(\.title) == ["Plans"])
}

@MainActor @Test func anOldStoreReappearingDoesNotOverwriteTheMigratedGroup() throws {
  let dir = tempDirectory()
  let old = Store()
  _ = old.createBoard(title: "Old")
  let new = Store()
  _ = new.createBoard(title: "New")
  try StoreFile(url: dir.appendingPathComponent("space.json")).saveNow(old.state)
  try StoreFile(url: dir.appendingPathComponent("Spaces/local.json")).saveNow(new.state)
  let spaces = try Spaces(directory: dir)
  #expect(spaces.local.store.boards.map(\.title) == ["New"])
  #expect(!FileManager.default.fileExists(atPath: dir.appendingPathComponent("space.json").path))
}

@MainActor @Test func spacesNamedAlikeAreOrderedBySpaceID() throws {
  let spaces = try Spaces(directory: tempDirectory())
  let a = spaces.newSpace(server: testServer, name: "abe")
  let b = spaces.newSpace(server: testServer, name: "Abe")
  let expected = [a, b].sorted { $0.space! < $1.space! }
  #expect(spaces.groups.dropFirst().map(\.space) == expected.map(\.space))
}

@MainActor @Test func groupsComeOnThisDeviceFirstThenSpacesByName() throws {
  let spaces = try Spaces(directory: tempDirectory())
  let zed = spaces.newSpace(server: testServer, name: "Zed")
  let abe = spaces.newSpace(server: testServer, name: "Abe")
  #expect(spaces.groups.map(\.name) == ["On this device", "Abe", "Zed"])
  let id = zed.store.createBoard(title: "Plans")
  #expect(spaces.group(of: id) === zed)
  #expect(spaces.group(space: abe.space!) === abe)
  #expect(zed.store.pending.map(\.id).contains(zed.space!))
}

@MainActor @Test func aSpaceComesBackFromItsFile() throws {
  let dir = tempDirectory()
  let spaces = try Spaces(directory: dir)
  let g = spaces.newSpace(server: testServer, name: "Work")
  let id = g.store.createBoard(title: "Plans")
  spaces.saveNow()
  let again = try Spaces(directory: dir)
  #expect(again.spaces.map(\.name) == ["Work"])
  #expect(again.group(of: id)?.space == g.space)
}

@MainActor @Test func joiningASpaceAlreadyJoinedGivesItsGroup() throws {
  let spaces = try Spaces(directory: tempDirectory())
  let invite = Invite(server: testServer, space: newID(), secret: Base64URL.encode(randomBytes(32)), name: "Ours")
  let g = spaces.join(invite)
  #expect(g.name == "Ours")
  #expect(spaces.join(invite) === g)
  #expect(spaces.spaces.count == 1)
}

@MainActor @Test func leavingRemovesTheFileForGood() async throws {
  let dir = tempDirectory()
  let spaces = try Spaces(directory: dir)
  let g = spaces.newSpace(server: testServer, name: "Work")
  _ = g.store.createBoard(title: "Plans")
  spaces.leave(g)
  try await Task.sleep(for: .seconds(0.8))
  #expect(!FileManager.default.fileExists(atPath: dir.appendingPathComponent("Spaces/\(g.space!).json").path))
  #expect(spaces.spaces.isEmpty)
  #expect(try Spaces(directory: dir).spaces.isEmpty)
}

@MainActor @Test func movingABoardCopiesItWithNewIDsAndDeletesTheOriginal() throws {
  let dir = tempDirectory()
  let spaces = try Spaces(directory: dir)
  let work = spaces.newSpace(server: testServer, name: "Work")
  let lane = Lane(id: "l", x: 0, y: 0, w: 480, h: 720, title: "Doing")
  let id = work.store.createBoard(title: "Plans", contents: board([card("a", 0, 0, "first"), card("b", 0, 0, "second")], [lane]))
  settle(work.store)
  guard let new = spaces.move(id, to: spaces.local) else { Issue.record("no move"); return }
  let moved = spaces.local.store.board(new)
  #expect(spaces.local.store.title(of: new) == "Plans")
  #expect(moved.cards.map(\.text) == ["first", "second"])
  #expect(moved.lanes.map(\.title) == ["Doing"])
  #expect(Set(moved.cards.map(\.id) + moved.lanes.map(\.id) + [new]).isDisjoint(with: ["a", "b", "l", id]))
  #expect(work.store.title(of: id) == nil)
  #expect(Set(work.store.pending.map(\.id)) == [id, "a", "b", "l"])
  let onDisk = try StoreFile(url: dir.appendingPathComponent("Spaces/local.json")).load()
  #expect(onDisk?.records[new] != nil)
}

@MainActor @Test func aMoveThatCannotBeWrittenLeavesTheBoardWhereItWas() throws {
  let dir = tempDirectory()
  let spaces = try Spaces(directory: dir)
  let work = spaces.newSpace(server: testServer, name: "Work")
  let id = spaces.local.store.createBoard(title: "Plans")
  spaces.saveNow()
  let folder = dir.appendingPathComponent("Spaces").path
  try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: folder)
  defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: folder) }
  var failed = false
  spaces.onError = { _ in failed = true }
  #expect(spaces.move(id, to: work) == nil)
  #expect(failed)
  #expect(spaces.local.store.title(of: id) == "Plans")
}

@MainActor @Test func aDeviceInTwoSpacesMovingBoardsEndsLikeEachSpace() async throws {
  let servers = Servers()
  let a = try Spaces(directory: tempDirectory(), transport: servers.transport)
  let x = a.newSpace(server: testServer, name: "X")
  let y = a.newSpace(server: testServer, name: "Y")
  for (g, t) in [(x, "x"), (y, "y")] {
    for n in 0..<3 { _ = g.store.createBoard(title: "\(t)\(n)", contents: board([card(newID(), 0, 0, t)])) }
  }
  await x.engine.sync()
  await y.engine.sync()
  let b = Device(servers.server(x.space!), joining: x.store.invite!)
  let c = Device(servers.server(y.space!), joining: y.store.invite!)
  await b.engine.sync()
  await c.engine.sync()
  var rng = SplitMix(state: 7)
  for _ in 0..<200 {
    switch Int.random(in: 0..<6, using: &rng) {
    case 0:
      let from = Bool.random(using: &rng) ? x : y
      if let id = from.store.boards.randomElement(using: &rng)?.id { _ = a.move(id, to: from === x ? y : x) }
    case 1: await x.engine.sync()
    case 2: await y.engine.sync()
    case 3: await b.engine.sync()
    case 4: await c.engine.sync()
    default:
      let d = Bool.random(using: &rng) ? b : c
      let row = Double(Int.random(in: 0..<20, using: &rng)) * 24
      if let id = d.store.boards.randomElement(using: &rng)?.id { d.edit(id) { _ = $0.addCard(x: 0, y: row) } }
    }
  }
  for _ in 0..<3 { for e in [x.engine, y.engine, b.engine, c.engine] { await e.sync() } }
  for (g, d) in [(x, b), (y, c)] {
    #expect(g.store.pending.isEmpty && d.store.pending.isEmpty)
    #expect(g.store.boards.map(\.id) == d.store.boards.map(\.id))
    for board in g.store.boards { #expect(g.store.board(board.id) == d.store.board(board.id)) }
  }
}

@MainActor private func liveSpaces(_ servers: Servers, _ relay: FakeRelay, dir: URL = tempDirectory()) throws -> Spaces {
  try Spaces(directory: dir, me: Person(device: newID(), name: "Ana"), transport: servers.transport, socket: { relay.connect($0) })
}

@MainActor @Test func aRelayGivesTheSpaceALiveLayer() async throws {
  let servers = Servers(), relay = FakeRelay()
  let spaces = try liveSpaces(servers, relay)
  var heard = 0
  spaces.onLive = { _ in heard += 1 }
  let g = spaces.newSpace(server: testServer, name: "Work")
  servers.server(g.space!).relay = "wss://relay.example/"
  await g.engine.sync()
  #expect(g.live?.relay == "wss://relay.example/")
  #expect(g.live?.space == g.space)
  #expect(heard >= 1)
  spaces.me = Person(device: spaces.me.device, name: "Ana Lima")
  #expect(g.live?.me.name == "Ana Lima")
  servers.server(g.space!).relay = nil
  await g.engine.sync()
  #expect(g.live == nil)
}

@MainActor @Test func withoutARelayThereIsNoLiveLayer() async throws {
  let servers = Servers(), relay = FakeRelay()
  let spaces = try liveSpaces(servers, relay)
  let g = spaces.newSpace(server: testServer, name: "Work")
  await g.engine.sync()
  #expect(g.live == nil)
  let before = g.engine.lastSynced!
  spaces.syncAll(polling: true, now: before.addingTimeInterval(5))
  try await Task.sleep(for: .milliseconds(100))
  #expect(g.engine.lastSynced! > before)
}

@MainActor @Test func whileLiveIsConnectedPollingWaitsThirtySeconds() async throws {
  let servers = Servers(), relay = FakeRelay()
  let spaces = try liveSpaces(servers, relay)
  let g = spaces.newSpace(server: testServer, name: "Work")
  servers.server(g.space!).relay = "wss://relay.example/"
  await g.engine.sync()
  g.live!.connect()
  relay.run()
  #expect(g.live!.connected)
  let before = g.engine.lastSynced!
  spaces.syncAll(polling: true, now: before.addingTimeInterval(10))
  try await Task.sleep(for: .milliseconds(100))
  #expect(g.engine.lastSynced == before)
  spaces.syncAll(polling: true, now: before.addingTimeInterval(31))
  try await Task.sleep(for: .milliseconds(100))
  #expect(g.engine.lastSynced! > before)
}

@MainActor @Test func aPushIsAnnouncedAndAnnouncedPushesArePulledAtOnce() async throws {
  let servers = Servers(), relay = FakeRelay()
  let a = try liveSpaces(servers, relay), b = try liveSpaces(servers, relay)
  let ga = a.newSpace(server: testServer, name: "Work")
  servers.server(ga.space!).relay = "wss://relay.example/"
  await ga.engine.sync()
  let gb = b.join(ga.store.invite!)
  await gb.engine.sync()
  ga.live!.connect()
  gb.live!.connect()
  relay.run()
  let id = ga.store.createBoard(title: "Plans")
  await ga.engine.sync()
  relay.run()
  try await Task.sleep(for: .milliseconds(100))
  #expect(gb.store.title(of: id) == "Plans")
}

@MainActor @Test func leavingASpaceClosesItsLiveLayer() async throws {
  let servers = Servers(), relay = FakeRelay()
  let spaces = try liveSpaces(servers, relay)
  let g = spaces.newSpace(server: testServer, name: "Work")
  servers.server(g.space!).relay = "wss://relay.example/"
  await g.engine.sync()
  g.live!.connect()
  relay.run()
  spaces.leave(g)
  relay.run()
  #expect(relay.sockets.isEmpty)
}

@MainActor @Test func anAnnouncedPushWithItsRecordsIsTakenWithoutARequestAndWithAGapIsPulled() async throws {
  let servers = Servers(), relay = FakeRelay()
  let a = try liveSpaces(servers, relay), b = try liveSpaces(servers, relay)
  let ga = a.newSpace(server: testServer, name: "Work")
  let server = servers.server(ga.space!)
  server.relay = "wss://relay.example/"
  await ga.engine.sync()
  let gb = b.join(ga.store.invite!)
  await gb.engine.sync()
  ga.live!.connect()
  gb.live!.connect()
  relay.run()
  let id = ga.store.createBoard(title: "Plans")
  server.pulls = []
  await ga.engine.sync()
  relay.run()
  try await Task.sleep(for: .milliseconds(100))
  #expect(gb.store.title(of: id) == "Plans")
  #expect(server.pulls.isEmpty)
  gb.live!.close()
  relay.run()
  let id2 = ga.store.createBoard(title: "More")
  await ga.engine.sync()
  relay.run()
  let id3 = ga.store.createBoard(title: "Later")
  gb.live!.connect()
  relay.run()
  await ga.engine.sync()
  relay.run()
  try await Task.sleep(for: .milliseconds(100))
  #expect(gb.store.title(of: id2) == "More")
  #expect(gb.store.title(of: id3) == "Later")
  #expect(!server.pulls.isEmpty)
}
