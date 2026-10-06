import Foundation
import Testing
@testable import BreezyKit

@Test func theIndexReadsTopToBottomThenLeftToRight() {
  var one = card("c1", 24, 72, "One")
  one.notes = "Back"
  let b = board([one, card("c2", 24, 24, "Two")], [Lane(id: "l", x: 0, y: 0, title: "Doing")])
  let index = SearchIndex(b)
  #expect(index.string == "Doing\u{2029}Two\u{2029}One\u{2029}Back")
  #expect(index.entries.map(\.id) == ["l", "c2", "c1", "c1"])
  #expect(index.entries.map(\.side) == [.title, .front, .front, .back])
}

@Test func locateMapsAMatchToItsItemAndSide() {
  var one = card("c1", 24, 72, "One")
  one.notes = "the Back side"
  let index = SearchIndex(board([one]))
  let found = (index.string as NSString).range(of: "Back")
  let hit = index.locate(found)!
  #expect(hit.entry.id == "c1" && hit.entry.side == .back)
  #expect(hit.local == NSRange(location: 4, length: 4))
}

@Test func locateIsUTF16Safe() {
  var c = card("c1", 0, 0, "😀 Straße")
  c.notes = "e\u{301}clair café"
  let index = SearchIndex(board([c, card("c2", 0, 48, "café")]))
  let s = index.string as NSString
  let first = s.range(of: "café")
  let hit = index.locate(first)!
  #expect(hit.entry.id == "c1" && hit.entry.side == .back)
  #expect(hit.local == ("e\u{301}clair café" as NSString).range(of: "café"))
  let strasse = index.locate(s.range(of: "Straße"))!
  #expect(strasse.entry.side == .front && strasse.local == ("😀 Straße" as NSString).range(of: "Straße"))
}
