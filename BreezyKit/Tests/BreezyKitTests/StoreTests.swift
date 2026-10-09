import Foundation
import Testing
@testable import BreezyKit

/// As if every pending record had been pushed and taken at `version`.
func settle(_ s: Store, version: Int = 1) {
  for p in s.pending { s.accepted(p.id, version: version, record: p.record) }
}

@Test func aNewBoardWaitsToBePushed() {
  let s = Store()
  let id = s.createBoard(title: "Plans", contents: board([card("c", 0, 0)]))
  #expect(s.boards.map(\.title) == ["Plans"])
  #expect(s.title(of: id) == "Plans")
  #expect(s.board(id) == board([card("c", 0, 0)]))
  #expect(Set(s.pending.map(\.id)) == [id, "c"])
}

@Test func acceptedRecordsStopWaitingUnlessChangedSince() {
  let s = Store()
  let id = s.createBoard(title: "Plans", contents: board([card("c", 0, 0)]))
  let sent = s.pending
  s.apply(["c": .fields(["color": .number(2)])])
  for p in sent { s.accepted(p.id, version: 1, record: p.record) }
  #expect(s.pending.map(\.id) == ["c"])
  #expect(s.state.records[id]!.version == 1)
}

@Test func aMergeComesInWhereNothingWaits() {
  let s = Store()
  let id = s.createBoard(title: "Plans", contents: board([card("c", 0, 0)]))
  settle(s)
  var r = s.state.records["c"]!.current
  r["text"] = .string("theirs")
  var heard: [(Set<String>, Bool)] = []
  s.onChange = { heard.append(($0, $1)) }
  s.merge([Incoming(id: "c", version: 2, record: r)])
  #expect(s.board(id).card("c")!.text == "theirs")
  #expect(s.pending.isEmpty)
  #expect(heard.count == 1 && heard[0].0 == [id] && heard[0].1)
}

@Test func anOlderVersionIsIgnored() {
  let s = Store()
  _ = s.createBoard(title: "Plans", contents: board([card("c", 0, 0, "now")]))
  settle(s, version: 5)
  var r = s.state.records["c"]!.current
  r["text"] = .string("old")
  s.merge([Incoming(id: "c", version: 4, record: r)])
  #expect(s.state.records["c"]!.current["text"] == .string("now"))
}

@Test func editsAndMergesCombineFieldByField() {
  let s = Store()
  let id = s.createBoard(title: "Plans", contents: board([card("c", 0, 0, "x")]))
  settle(s)
  s.apply(["c": .fields(["color": .number(3)])])
  var r = s.state.records["c"]!.base!
  r["text"] = .string("theirs")
  s.merge([Incoming(id: "c", version: 2, record: r)])
  let c = s.board(id).card("c")!
  #expect(c.color == 3 && c.text == "theirs")
  #expect(s.pending.map(\.id) == ["c"])
}

@Test func aTextConflictAddsACopyCard() {
  let s = Store()
  let id = s.createBoard(title: "Plans", contents: board([card("c", 0, 0, "x")]))
  settle(s)
  s.apply(["c": .fields(["text": .string("mine")])])
  var r = s.state.records["c"]!.base!
  r["text"] = .string("theirs")
  s.merge([Incoming(id: "c", version: 2, record: r)])
  #expect(s.board(id).cards.map(\.text).sorted() == ["mine", "theirs"])
}

@Test func editsToADeletedRecordAreDropped() {
  let s = Store()
  let id = s.createBoard(title: "Plans", contents: board([card("c", 0, 0)]))
  settle(s)
  s.merge([Incoming(id: "c", version: 2, record: .marker("card"))])
  s.apply(["c": .fields(["color": .number(3)])])
  #expect(s.board(id).cards.isEmpty)
  #expect(s.state.records["c"]!.current.deleted)
}

@Test func aNewRecordOnADeletedBoardIsDropped() {
  let s = Store()
  let id = s.createBoard(title: "Plans")
  s.deleteBoard(id)
  var heard = 0
  s.onChange = { _, _ in heard += 1 }
  s.apply(Records.changes(from: Board(), to: board([card("c", 0, 0)]), board: id, orders: [:]))
  #expect(s.state.records["c"] == nil)
  #expect(heard == 0)
}

@Test func deletingABoardDeletesWhatIsOnIt() {
  let s = Store()
  let id = s.createBoard(title: "Plans", contents: board([card("c", 0, 0)], [lane("l", 0, 0)]))
  s.deleteBoard(id)
  #expect(s.boards.isEmpty)
  #expect(s.title(of: id) == nil)
  #expect(["c", "l", id].allSatisfy { s.state.records[$0]!.current.deleted })
}

@Test func renamingABoardChangesOnlyItsTitle() {
  let s = Store()
  let id = s.createBoard(title: "Plans")
  s.renameBoard(id, "Ideas")
  #expect(s.boards.map(\.title) == ["Ideas"])
}

@Test func joiningReplacesTheBoardsHere() {
  let s = Store()
  _ = s.createBoard(title: "Mine")
  let invite = Invite(server: "https://example.com/sync.php", space: Base64URL.encode(randomBytes(16)), secret: Base64URL.encode(randomBytes(32)))
  s.join(invite)
  #expect(s.boards.isEmpty)
  #expect(s.state.invite == invite)
  #expect(s.state.cursor == 0)
}

@Test func startingToSyncPushesEverything() throws {
  let s = Store()
  _ = s.createBoard(title: "Plans", contents: board([card("c", 0, 0)]))
  settle(s)
  let invite = s.startSyncing(server: "https://example.com/sync.php")
  #expect(s.state.invite == invite)
  #expect(s.pending.count == 2 && s.pending.allSatisfy { $0.base == 0 })
  #expect(try SpaceKeys(state: s.state).space.count == 16)
}

@Test func theStateSurvivesItsFile() throws {
  let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  let file = StoreFile(url: dir.appendingPathComponent("space.json"))
  #expect(try file.load() == nil)
  let s = Store()
  _ = s.createBoard(title: "Plans", contents: board([card("c", 0, 0, "Kept")]))
  file.save(s.state, wait: true)
  #expect(try file.load() == s.state)
  let mode = try FileManager.default.attributesOfItem(atPath: file.url.path)[.posixPermissions] as? Int
  #expect(mode == 0o600)
}

@Test func saveCanWaitForTheWrite() throws {
  let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  let file = StoreFile(url: dir.appendingPathComponent("space.json"))
  let s = Store()
  _ = s.createBoard(title: "First")
  file.save(s.state)
  _ = s.createBoard(title: "Second")
  file.save(s.state, wait: true)
  #expect(try file.load()?.records.count == 2)
}

@Test func aFileFromBeforeEpochsStillLoads() throws {
  let json = #"{"cursor":3,"records":{},"held":{},"unreadable":0,"server":"https://example.com/sync.php"}"#
  let state = try JSONDecoder().decode(SpaceState.self, from: Data(json.utf8))
  #expect(state.cursor == 3 && state.epoch == nil && !state.resync)
}

@Test func aNewEpochIsTakenAndAChangedOneResyncs() {
  let s = Store()
  _ = s.createBoard(title: "Plans")
  settle(s, version: 4)
  s.advance(to: 4)
  #expect(!s.note(epoch: "e1"))
  #expect(s.state.epoch == "e1" && s.state.cursor == 4)
  #expect(!s.note(epoch: "e1"))
  s.noteUnreadable()
  #expect(s.note(epoch: nil))
  #expect(s.state.unreadable == 0)
  #expect(s.state.resync && s.state.cursor == 0 && s.state.epoch == nil)
  #expect(s.state.records.values.allSatisfy { $0.version == 0 })
  s.resynced()
  #expect(!s.state.resync && s.pending.count == 1 && s.pending[0].base == 0)
  #expect(!s.note(epoch: "e2"))
  s.startSyncing(server: "https://example.com/sync.php")
  #expect(s.state.epoch == nil)
}

@Test func aResyncTakesAStaleRecordAsBaseAndMergesAFreshOne() {
  let s = Store()
  let id = s.createBoard(title: "Plans", contents: board([card("c", 0, 0, "mine")]))
  settle(s, version: 4)
  _ = s.note(epoch: "e1")
  _ = s.note(epoch: "e2")
  var backup = s.state.records["c"]!.current
  backup["text"] = .string("backup")
  s.merge([Incoming(id: "c", version: 2, record: backup, stale: true)])
  #expect(s.state.records["c"]!.base == backup)
  #expect(s.pending.map(\.id) == ["c"] && s.pending[0].base == 2 && s.pending[0].record["text"] == .string("mine"))
  var fresh = s.state.records[id]!.current
  fresh["title"] = .string("Ideas")
  s.merge([Incoming(id: id, version: 7, record: fresh)])
  #expect(s.title(of: id) == "Ideas")
  #expect(s.state.records[id]!.base == fresh && s.state.records[id]!.version == 7)
}

@Test func aResyncMergesABackupNewerThanThisDevice() {
  let s = Store()
  _ = s.createBoard(title: "Plans", contents: board([card("c", 0, 0, "old")]))
  settle(s, version: 2)
  _ = s.note(epoch: "e1")
  _ = s.note(epoch: "e2")
  var backup = s.state.records["c"]!.current
  backup["text"] = .string("newer")
  s.merge([Incoming(id: "c", version: 5, record: backup, stale: true)])
  #expect(s.state.records["c"]!.current == backup && s.state.records["c"]!.base == backup)
  s.resynced()
  #expect(s.state.records.values.allSatisfy { $0.prior == nil })
  #expect(!s.pending.contains { $0.id == "c" })
}

@Test func aSpaceIsNamedByItsRecordElseItsInvite() {
  let s = Store()
  #expect(s.name == nil)
  let invite = Invite(server: "https://example.com/sync.php", space: newID(), secret: Base64URL.encode(randomBytes(32)), name: "Ours")
  s.join(invite)
  #expect(s.name == "Ours")
  #expect(s.pending.isEmpty)
  s.rename("Home")
  #expect(s.name == "Home")
  #expect(s.invite?.name == "Home")
  #expect(s.boards.isEmpty)
  #expect(s.pending.map(\.id) == [invite.space])
  #expect(s.pending[0].record == Records.space(name: "Home"))
}

@Test func aMergedNameIsReported() {
  let s = Store()
  s.startSyncing(server: "https://example.com/sync.php")
  let space = s.state.space!
  var heard: Set<String> = []
  s.onChange = { boards, _ in heard = boards }
  s.merge([Incoming(id: space, version: 1, record: Records.space(name: "Work"))])
  #expect(s.name == "Work")
  #expect(heard == [space])
}

@Test func aStoreNotSyncingHasNoNameToChange() {
  let s = Store()
  s.rename("Home")
  #expect(s.name == nil)
  #expect(s.state.records.isEmpty)
}
