import Foundation
import Testing
@testable import BreezyKit

private func records(_ changes: [String: Change]) -> [String: Record] {
  changes.compactMapValues { change in
    guard case .fields(let f) = change else { return nil }
    return Record(f)
  }
}

@Test func aBoardGoesToRecordsAndBack() {
  let b = board([card("c1", 24, 48, "One"), card("c2", 0, 0, "Two")], [lane("l1", 0, 0)])
  #expect(Records.board("B", from: records(Records.changes(from: Board(), to: b, board: "B", orders: [:]))) == b)
}

@Test func onlyChangedFieldsAreWritten() {
  let old = board([card("c1", 0, 0, "One")])
  var new = old
  new.setColor(["c1"], 3)
  #expect(Records.changes(from: old, to: new, board: "B", orders: ["c1": "V"]) == ["c1": .fields(["color": .number(3)])])
}

@Test func anOrderAnotherDeviceChangedIsNotWrittenBackWhenNothingMovedHere() {
  let b = board([card("a", 0, 0), card("b", 0, 0)])
  #expect(Records.changes(from: b, to: b, board: "B", orders: ["a": "V", "b": "G"]).isEmpty)
}

@Test func aCardMovedHereGetsAKeyAmongTheOthersOrderWhichStays() {
  let old = board([card("a", 0, 0), card("b", 0, 0), card("c", 0, 0)])
  let new = board([card("a", 0, 0), card("c", 0, 0), card("b", 0, 0)])
  // another device put c first meanwhile; here c went between a and b
  let out = Records.changes(from: old, to: new, board: "B", orders: ["a": "V", "b": "l", "c": "G"])
  #expect(Array(out.keys) == ["c"])
  guard case let .fields(f)? = out["c"], let key = f["order"]?.string else {
    Issue.record("no order for c")
    return
  }
  #expect(key > "V" && key < "l")
}

@Test func reorderingWritesOneOrderKey() {
  let old = board([card("a", 0, 0), card("b", 0, 0)])
  let new = board([card("b", 0, 0), card("a", 0, 0)])
  #expect(Records.changes(from: old, to: new, board: "B", orders: ["a": "V", "b": "l"]) == ["b": .fields(["order": .string("G")])])
}

@Test func removedItemsAreMarkedDeleted() {
  let old = board([card("a", 0, 0)], [lane("l", 0, 0)])
  #expect(Records.changes(from: old, to: Board(), board: "B", orders: ["a": "V"]) == ["a": .deleted("card"), "l": .deleted("lane")])
}

@Test func badValuesFromAnotherDeviceFallBack() {
  let r = Record(["format": .number(1), "kind": .string("card"), "board": .string("B"), "color": .number(9), "pos": .string("x")])
  let c = Records.board("B", from: ["c": r]).cards[0]
  #expect(c.color == 5 && c.x == 0 && c.text == "" && c.notes == nil && c.w == Metrics.cardWidth)
}

@Test func deletedRecordsAndOtherBoardsAreLeftOut() {
  let mine = Records.card(card("a", 0, 0), board: "B", order: "V")
  let other = Records.card(card("b", 0, 0), board: "C", order: "V")
  #expect(Records.board("B", from: ["a": mine, "b": other, "d": .marker("card")]).cards.map(\.id) == ["a"])
}

@Test func recordsRoundTripAsJSON() throws {
  let r = Records.card(card("a", 24, 0, "Hi"), board: "B", order: "V")
  #expect(try JSONDecoder().decode(Record.self, from: JSONEncoder().encode(r)) == r)
}

@Test func newIDsAre16RandomBytes() {
  let id = newID()
  #expect(id.count == 22)
  #expect(Base64URL.decode(id)?.count == 16)
  #expect(newID() != id)
}

@Test func hugeNumbersFromAnotherDeviceDoNotTrap() {
  func card(_ color: Double) -> Card {
    Records.board("B", from: ["c": Record(["kind": .string("card"), "board": .string("B"), "color": .number(color)])]).cards[0]
  }
  #expect(card(1e30).color == 5 && card(-1e30).color == 1)
  #expect(Record(["format": .number(1e30)]).format > Record.format)
  #expect(Record(["format": .number(-1e30)]).format < Record.format)
}

private struct OrderCase: Decodable {
  var name: String
  var old: [String], now: [String]
  var orders: [String: String], keys: [String: String]
}

@Test func orderWritesMatchTheSharedCases() throws {
  let cases = try JSONDecoder().decode([OrderCase].self, from: fixture("order-writes.json"))
  for c in cases {
    let cards = { (ids: [String]) -> [Card] in ids.map { Card(id: $0, x: 0, y: 0, text: "t") } }
    let out = Records.changes(from: board(cards(c.old)), to: board(cards(c.now)), board: "B", orders: c.orders)
    var keys: [String: String] = [:]
    for (id, change) in out { if case let .fields(f) = change, let k = f["order"]?.string { keys[id] = k } }
    #expect(keys == c.keys, "\(c.name)")
  }
}
