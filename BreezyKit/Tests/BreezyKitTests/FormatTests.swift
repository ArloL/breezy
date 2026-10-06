import Foundation
import Testing
@testable import BreezyKit

private func decode(_ json: String) throws -> Board { try BoardFormat.decode(Data(json.utf8)) }

private func isMalformed(_ json: String) -> Bool {
  do {
    _ = try decode(json)
    return false
  } catch let BoardFormatError.malformed(why) {
    return !why.isEmpty
  } catch {
    return false
  }
}

@Test func aBoardSurvivesARoundTrip() throws {
  var c = card("c1", 24, 72, "Title\nbody")
  c.notes = "back"
  c.color = 3
  let b = board([c, card("c2", 0, 0)], [Lane(id: "l1", x: 0, y: 0, title: "Doing")])
  #expect(try BoardFormat.decode(BoardFormat.encode(b)) == b)
}

@Test func filesArePrettySortedAndOmitEmptyNotes() throws {
  let s = String(decoding: try BoardFormat.encode(board([card("c1", 0, 0)])), as: UTF8.self)
  #expect(s.contains("\"format\" : 1"))
  #expect(s.firstRange(of: "\"cards\"")!.lowerBound < s.firstRange(of: "\"format\"")!.lowerBound)
  #expect(!s.contains("notes"))
}

@Test func aNewerFormatIsRefused() {
  #expect(throws: BoardFormatError.newer(2)) { try decode(#"{"format": 2, "cards": [], "lanes": []}"#) }
}

@Test func damagedFilesAreRefusedWithAReason() {
  #expect(isMalformed("not json"))
  #expect(isMalformed(#"{"cards": [], "lanes": []}"#))
  #expect(isMalformed(#"{"format": 1, "cards": [{"id": "a", "x": "left", "y": 0, "w": 240, "text": "", "color": 1}], "lanes": []}"#))
  #expect(isMalformed(#"{"format": 1, "cards": [{"id": "a", "x": 1e400, "y": 0, "w": 240, "text": "", "color": 1}], "lanes": []}"#))
}

@Test func duplicateIdsAreReplacedAndColoursClamped() throws {
  let b = try decode(#"""
  {"format": 1, "lanes": [{"id": "a", "x": 0, "y": 0, "w": 480, "h": 720, "title": "L"}],
   "cards": [{"id": "a", "x": 0, "y": 0, "w": 240, "text": "", "color": 9},
             {"id": "a", "x": 0, "y": 0, "w": 240, "text": "", "color": 0}]}
  """#)
  let ids = b.cards.map(\.id) + b.lanes.map(\.id)
  #expect(Set(ids).count == 3)
  #expect(b.cards.map(\.color) == [5, 1])
}

@Test func recentringBringsFarItemsIntoReach() {
  let b = board([card("near", 0, 0), card("far", 50_000, 24)], [lane("l", 49_000, 0)])
  let r = b.recentred(within: 20_000)
  let xs = r.cards.flatMap { [$0.x, $0.x + $0.w] }
  // centred on the origin, still on the grid, nothing moved relative to anything else
  #expect(abs(xs.min()! + xs.max()!) <= Metrics.grid * 2)
  #expect(r.card("near")!.x.truncatingRemainder(dividingBy: Metrics.grid) == 0)
  #expect(r.card("far")!.x - r.card("near")!.x == 50_000)
  #expect(board([card("a", 0, 0)]).recentred(within: 20_000) == board([card("a", 0, 0)]))
}
