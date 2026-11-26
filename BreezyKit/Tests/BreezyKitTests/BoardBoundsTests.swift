import Foundation
import Testing
@testable import BreezyKit

private struct BoardCases: Decodable {
  struct Extent: Decodable { var name: String; var rects: [[Double]]; var extent: [Double] }
  struct Reach: Decodable { var name: String; var content: [Double]; var seen: [Double]?; var board: [Double] }
  struct Seen: Decodable { var name: String; var camera: [Double]; var area: [Double]; var seen: [Double] }
  struct TakeIn: Decodable { var name: String; var seen: [Double]?; var shown: [Double]; var out: [Double] }
  var margin: Double
  var extent: [Extent]
  var board: [Reach]
  var seen: [Seen]
  var takeIn: [TakeIn]
}

private func rect(_ v: [Double]) -> Rect { Rect(x: v[0], y: v[1], w: v[2], h: v[3]) }

private func cases() throws -> BoardCases { try JSONDecoder().decode(BoardCases.self, from: fixture("board.json")) }

@Test func theBoardReachesAsFarAsTheWebsDoes() throws {
  let c = try cases()
  #expect(BoardBounds.margin == c.margin)
  for e in c.extent { #expect(BoardBounds.extent(e.rects.map(rect)) == rect(e.extent), "\(e.name)") }
  for b in c.board { #expect(BoardBounds.board(rect(b.content), seen: b.seen.map(rect)) == rect(b.board), "\(b.name)") }
}

@Test func itTakesInWhatTheViewShowedAsTheWebsDoes() throws {
  let c = try cases()
  for s in c.seen {
    let cam = Scene.Camera(x: s.camera[0], y: s.camera[1], zoom: s.camera[2])
    let a = s.area
    #expect(BoardBounds.seen(cam, area: Rect(x: a[0], y: a[1], w: a[2] - a[0], h: a[3] - a[1])) == rect(s.seen), "\(s.name)")
  }
  for t in c.takeIn { #expect(BoardBounds.takeIn(t.seen.map(rect), rect(t.shown)) == rect(t.out), "\(t.name)") }
}

@Test func theBoardAsDrawnCoversItsReachInWholePoints() {
  #expect(Rect(x: 1646, y: -428.4, w: 1600, h: 1066.6666666666667).outward == Rect(x: 1646, y: -429, w: 1600, h: 1068))
  #expect(Rect(x: -1194, y: -1194, w: 2388, h: 2388).outward == Rect(x: -1194, y: -1194, w: 2388, h: 2388))
  // taken in at a fractional top, the board's bottom stays: -1196.3 + 3110.3 is 1914.0000000000002, which grew it 1 pt
  let shown = Rect(x: -1194, y: -1196.3, w: 1358.5, h: 941.9)
  #expect(Rect(x: -1194, y: -1194, w: 3156, h: 3108).union(shown).outward == Rect(x: -1194, y: -1197, w: 3156, h: 3111))
}

@Test func whatShowedWhenTheViewLastRestedIsAllItKeeps() {
  var b = BoardBounds()
  let content = Rect(x: 0, y: 0, w: 240, h: 48)
  b.takeIn(Rect(x: -5000, y: -5000, w: 2400, h: 1600))
  #expect(b.board(content).x == -5000)
  b.rest(Rect(x: -600, y: -400, w: 1200, h: 800))
  #expect(b.board(content) == Rect(x: -1194, y: -1194, w: 240 + 2388, h: 48 + 2388))
}
