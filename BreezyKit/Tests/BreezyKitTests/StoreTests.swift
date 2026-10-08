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
