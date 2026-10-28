import Foundation
import Testing
@testable import BreezyKit

@MainActor @Test func theCoreNotesADragAndATurnAsTheWebAppNamesThem() {
  let c = CanvasCore(model: BoardModel(board: board([card("a", 24, 72), card("b", 400, 72)])))
  c.heightOf = h48
  c.press(at: Point(x: 30, y: 80))
  for x in stride(from: 40.0, through: 200, by: 20) { c.dragged(to: Point(x: x, y: 80)) }
  c.release()
  c.selection = ["b"]
  c.turnCard()
  let notes = c.flight.recording().entries.map { "\($0.kind.rawValue) \($0.what)" }
  #expect(notes == ["input press", "transition drag", "input release", "transition turn"])
  #expect(c.flight.recording().entries[1].data == ["action": .string("move"), "ids": .number(1)])
  #expect(c.flight.recording().entries[3].data == ["from": .null, "to": .string("b")])
}

@MainActor @Test func theCoreNotesABoxOnceWithTheSelectionItAddsTo() {
  let c = CanvasCore(model: BoardModel(board: board([card("a", 0, 0), card("b", 300, 0), card("c", 600, 0)])))
  c.heightOf = h48
  c.selection = ["c"]
  c.press(at: Point(x: 0, y: 200), shift: true)
  for y in stride(from: 180.0, through: 40, by: -20) { c.dragged(to: Point(x: 310, y: y)) }
  c.release()
  let drags = c.flight.recording().entries.filter { $0.what == "drag" }
  #expect(drags.map(\.data) == [["action": .string("marquee"), "ids": .number(1)]])
}

@Test func keepsTheNewestEntriesInOrderAndCountsWhatItDropped() {
  let f = Flight(size: 4000)
  for i in 0..<10_000 { f.note(.input, "tap", ["n": .number(Double(i))]) }
  let r = f.recording()
  #expect(r.entries.count == 4000)
  #expect(r.entries.first?.data?["n"] == .number(6000))
  #expect(r.entries.last?.data?["n"] == .number(9999))
  #expect(r.dropped == 6000)
}

@Test func stampsEntriesOnItsClockAndItsOriginOnTheWall() {
  var times = [100.0, 250.04]
  let f = Flight(now: { times.removeFirst() }, wall: { 1_000_000 })
  f.note(.life, "visible")
  let r = f.recording()
  #expect(r.origin == 1_000_000 - 100)
  #expect(r.entries.first?.t == 250)
}

@Test func aRecordingIsWrittenAsTheWebAppWritesOne() throws {
  let f = Flight(now: { 5 }, wall: { 1005 })
  f.context(["screen": .array([.number(1440), .number(900)])])
  f.note(.decision, "reveal", ["path": .string("card"), "why": .string("fits")])
  f.note(.life, "hidden")
  let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(f.recording())) as! [String: Any]
  #expect(json["schema"] as? Int == 1)
  #expect(json["origin"] as? Double == 1000)
  #expect((json["context"] as? [String: Any])?["screen"] as? [Double] == [1440, 900])
  let entries = json["entries"] as! [[Any]]
  #expect(entries[0][0] as? Double == 5)
  #expect(entries[0][1] as? String == "decision")
  #expect(entries[0][2] as? String == "reveal")
  #expect((entries[0][3] as? [String: String]) == ["path": "card", "why": "fits"])
  #expect(entries[1].count == 3)
}
