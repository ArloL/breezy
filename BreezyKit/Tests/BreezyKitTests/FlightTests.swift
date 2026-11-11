import Foundation
import Testing
@testable import BreezyKit

@MainActor @Test func theCoreNotesADragAndATurnAsTheWebAppNamesThem() {
  let c = CanvasCore(model: BoardModel(board: board([card("a", 24, 72), card("b", 400, 72)])))
  c.heightOf = h48
  c.press(at: Point(x: 30, y: 80))
  for x in stride(from: 40.0, through: 200, by: 20) { c.dragged(to: Point(x: x, y: 80)) }
  c.release()
  c.hover(at: nil)
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

@MainActor @Test func theCoreNotesABoxOnItsFirstMoveAsTheWebAppDrawsOneThere() {
  let c = CanvasCore(model: BoardModel(board: board([])))
  c.press(at: Point(x: 100, y: 100))
  c.dragged(to: Point(x: 101, y: 101))
  #expect(c.flight.recording().entries.filter { $0.what == "drag" }.map(\.data) == [["action": .string("marquee"), "ids": .number(0)]])
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

@Test func aRecordingWithoutContextSaysSoAsTheWebAppDoes() throws {
  let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(Flight().recording())) as! [String: Any]
  #expect(json["context"] is NSNull)
}

@MainActor @Test func theCoreNotesAPressWhereTheScreenHasItAsTheWebAppDoes() {
  let c = CanvasCore(model: BoardModel(board: board([])))
  c.camera = { Scene.Camera(x: 100, y: -50, zoom: 2) }
  c.press(at: Point(x: 10, y: 20.2))
  #expect(c.flight.recording().entries.first?.data == ["x": .number(120), "y": .number(-10), "clicks": .number(1)])
}

/// A frame of every field but `t`, which the recording stamps.
private func frameRow(_ v: Double) -> [Double?] { Flight.frameFields.dropFirst().map { $0 == "f1x" ? nil : v } }

@Test func framesKeepThirtySeconds() {
  var now = 0.0
  let f = Flight(now: { now }, wall: { 0 })
  for _ in 0..<4000 {
    now += 8.3
    f.frame(frameRow(1))
  }
  let rows = f.recording().frames!.rows
  let first = rows.first![0]!, last = rows.last![0]!
  #expect(last == 33200)
  #expect(last - first <= 30_000)
  #expect(last - first > 29_980)
  #expect(rows.count == 3615)
}

@Test func framesEncodeAsFieldsAndRows() throws {
  var now = 1000.0
  let f = Flight(now: { now }, wall: { 0 })
  f.frame(frameRow(2))
  now += 16.6
  f.frame(frameRow(3))
  let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(f.recording())) as! [String: Any]
  let frames = json["frames"] as! [String: Any]
  #expect(frames["fields"] as? [String] == Flight.frameFields)
  let rows = frames["rows"] as! [[Any]]
  #expect(rows.count == 2)
  #expect(rows[1][0] as? Double == 1016.6)
  #expect(rows[1][1] as? Double == 3)
  #expect(rows[1][Flight.frameFields.firstIndex(of: "f1x")!] is NSNull)
}

@Test func aRecordingWithoutFramesHasNoFramesKey() throws {
  let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(Flight().recording())) as! [String: Any]
  #expect(json["frames"] == nil)
}

@Test func aFrameOfTheWrongLengthIsNotKept() {
  let f = Flight()
  f.frame([1, 2, 3])
  #expect(f.recording().frames == nil)
}

@Test func frameFieldsMatchTheChecker() throws {
  let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../scripts/frames/fields.json").standardized
  let listed = try JSONDecoder().decode([String: [String]].self, from: Data(contentsOf: url))
  #expect(Flight.frameFields == listed["common"]! + listed["mac"]!)
}
