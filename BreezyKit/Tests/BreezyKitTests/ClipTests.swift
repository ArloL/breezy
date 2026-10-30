import Foundation
import Testing
@testable import BreezyKit

private func stackBoard() -> Board {
  board([card("a", 24, 72), card("b", 24, 144), card("d", 600, 72)], [lane("l", 0, 0, 480, 480)])
}

private func clipOf(_ b: Board, _ ids: String...) -> Clip { b.clip(board: "B", ids: Set(ids), heightOf: h48)! }

private let sample = Clip(board: "B", cards: [
  ClipCard(id: "c1", x: 24, y: 72, w: 240, h: 48, text: "He said \"hi\" <b> & 🍕", color: 3, notes: "back & side"),
  ClipCard(id: "c2", x: 312, y: 72, w: 240, h: 72, text: "Soup", color: 1),
])

private func html(cards: String, v: Int = 1) -> String {
  "<div data-breezy=\"{&quot;v&quot;:\(v),&quot;board&quot;:&quot;B&quot;,&quot;cards&quot;:\(cards.replacingOccurrences(of: "\"", with: "&quot;"))}\"></div>"
}

private func one(_ extra: String) -> ClipCard? {
  Clip(html: html(cards: "[{\"id\":\"a\",\"x\":0,\"y\":0,\"text\":\"t\"\(extra)}]"))?.cards.first
}

@Test func clipTakesTheSelectedCardsInReadingOrderAndLeavesLanesOut() {
  let b = board([card("b", 0, 96), card("a", 0, 0)], [lane("l", 600, 0)])
  let c = b.clip(board: "B", ids: ["b", "a", "l"], heightOf: h48)!
  #expect(c.cards.map(\.id) == ["a", "b"])
  #expect(c.cards.map(\.h) == [48, 48])
  #expect(b.clip(board: "B", ids: ["l"], heightOf: h48) == nil)
}

@Test func aCopyOfACardInALanePastesRightBelowItTheCardsBelowMakingRoom() {
  var b = stackBoard()
  let copy = b.paste(clipOf(b, "a"), board: "B", centre: Point(x: 0, y: 0), heightOf: h48)[0]
  #expect(ys(b, "a", copy, "b") == [72, 144, 216])
  #expect(b.card(copy)!.x == 24)
}

@Test func pastingALaneCardTwiceStacksBothCopiesBelowIt() {
  var b = stackBoard()
  let c = clipOf(b, "a")
  let one = b.paste(c, board: "B", centre: Point(x: 0, y: 0), heightOf: h48)[0]
  let two = b.paste(c, board: "B", centre: Point(x: 0, y: 0), heightOf: h48)[0]
  #expect(ys(b, "a", two, one, "b") == [72, 144, 216, 288])
}

@Test func afterACutALaneCardPastesBackWhereItStood() {
  var b = board([card("a", 24, 72), card("b", 24, 144), card("c", 24, 216)], [lane("l", 0, 0)])
  let c = clipOf(b, "b")
  b.remove(["b"])
  b.gravity(h48)
  let copy = b.paste(c, board: "B", centre: Point(x: 0, y: 0), heightOf: h48)[0]
  #expect(ys(b, "a", copy, "c") == [72, 144, 216])
}

private func isClear(_ b: Board, _ id: String, of others: [String]) -> Bool {
  let g = Metrics.grid
  let c = b.card(id)!
  let r = Rect(x: c.x - g, y: c.y - g, w: c.w + 2 * g, h: 48 + 2 * g)
  return !others.contains { r.intersects(b.card($0)!.rect(height: 48)) }
}

@Test func freeCardsPasteAsABlockToTheNearestClearSpace() {
  var b = board([card("a", 600, 0), card("b", 912, 0)])
  let copies = b.paste(clipOf(b, "a", "b"), board: "B", centre: Point(x: 0, y: 0), heightOf: h48)
  let p = b.card(copies[0])!, q = b.card(copies[1])!
  #expect(q.x - p.x == 312 && q.y == p.y)
  #expect(copies.allSatisfy { isClear(b, $0, of: ["a", "b"]) })
}

@Test func onAnotherBoardTheBlockPastesNearestTheViewsCentre() {
  var b = board()
  let c = clipOf(board([card("a", 0, 0)]), "a")
  let copy = b.paste(c, board: "other", centre: Point(x: 1000, y: 1000), heightOf: h48)[0]
  let k = b.card(copy)!
  #expect(abs(k.x + 120 - 1000) <= Metrics.grid && abs(k.y + 24 - 1000) <= Metrics.grid)
}

@Test func aLaneOriginalMovedToAnotherLaneOrDeletedPastesWithoutThrowing() {
  var b = board([card("a", 24, 72), card("z", 600, 72)], [lane("l", 0, 0), lane("m", 576, 0)])
  let c = clipOf(b, "a")
  b.moveCards([Origin(id: "a", x: 24, y: 72)], dx: 576, dy: 24)
  b.gravity(h48)
  let one = b.paste(c, board: "B", centre: Point(x: 0, y: 0), heightOf: h48)[0]
  #expect(b.card(one)!.x >= 576 && b.card(one)!.y > b.card("a")!.y)
  b.remove(["a", "l"])
  let two = b.paste(c, board: "B", centre: Point(x: 0, y: 0), heightOf: h48)[0]
  #expect(isClear(b, two, of: ["z", one]))
}

@Test func clipTextJoinsFrontsWithABlankLine() {
  let c = Clip(board: "B", cards: [ClipCard(id: "a", x: 0, y: 0, w: 240, h: 48, text: "Pizza\nfor Al", color: 1), ClipCard(id: "b", x: 0, y: 0, w: 240, h: 48, text: "Soup", color: 1)])
  #expect(c.text == "Pizza\nfor Al\n\nSoup")
}

@Test func clipReadsTheFixture() throws {
  let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
  let text = try String(contentsOf: root.appendingPathComponent("web/test/clip-fixture.html"), encoding: .utf8)
  #expect(Clip(html: text) == sample)
}

@Test func clipReadsWhatItWrites() {
  #expect(Clip(html: sample.html) == sample)
}

@Test func clipHTMLShowsTheTextAndKeepsAngleBracketsOutOfTheAttribute() {
  let h = sample.html
  let attr = h.drop { $0 != "\"" }.dropFirst().prefix { $0 != "\"" }
  #expect(!attr.contains("<") && !attr.contains(">"))
  #expect(h.hasSuffix(">He said &quot;hi&quot; &lt;b&gt; &amp; 🍕<br><br>Soup</div>"))
}

@Test func clipRejectsWhatIsNotAClip() {
  #expect(Clip(html: "<p>hello</p>") == nil)
  #expect(Clip(html: html(cards: "[]", v: 2)) == nil)
  #expect(Clip(html: html(cards: "\"no\"")) == nil)
  #expect(Clip(html: html(cards: "[{\"id\":\"a\",\"x\":0,\"y\":0,\"text\":1}]")) == nil)
  #expect(Clip(html: "<div data-breezy=\"{nope\"></div>") == nil)
}

@Test func clipClampsTheColourAndMendsTheWidth() {
  #expect(one(",\"color\":9")?.color == 5)
  #expect(one(",\"color\":0")?.color == 1)
  #expect(one(",\"w\":0")?.w == 240)
  #expect(one(",\"w\":-5")?.w == 240)
}

@Test func adjacentCutLaneCardsPasteBackInOrder() {
  var b = board([card("a", 24, 72), card("b", 24, 144), card("c", 24, 216), card("d", 24, 288)], [lane("l", 0, 0)])
  let c = clipOf(b, "b", "c")
  b.remove(["b", "c"])
  b.gravity(h48)
  let copies = b.paste(c, board: "B", centre: Point(x: 0, y: 0), heightOf: h48)
  #expect(ys(b, "a", copies[0], copies[1], "d") == [72, 144, 216, 288])
}

@Test func aNoBreakSpaceSurvivesARoundTripAndNbspIsReadAsOne() {
  let c = Clip(board: "B", cards: [ClipCard(id: "a", x: 0, y: 0, w: 240, h: 48, text: "10\u{00A0}km", color: 1)])
  #expect(!c.html.components(separatedBy: "\">")[0].contains("\u{00A0}"))
  #expect(Clip(html: c.html)?.cards[0].text == "10\u{00A0}km")
  #expect(Clip(html: c.html.replacingOccurrences(of: "\\u00a0", with: "&nbsp;"))?.cards[0].text == "10\u{00A0}km")
}

@Test func clipMendsACardsColourSizeAndNotesOfTheWrongType() {
  #expect(one(",\"color\":2.5")?.color == 3)
  #expect(one(",\"color\":\"x\"")?.color == 1)
  #expect(one(",\"w\":\"x\"")?.w == 240)
  #expect(one(",\"h\":\"x\"")?.h == 48)
  #expect(one(",\"notes\":5")?.notes == nil)
}

private func cutAndPaste(_ b: inout Board, _ cut: Set<String>, heightOf: HeightOf = h48) -> [String] {
  let c = b.clip(board: "B", ids: cut, heightOf: heightOf)!
  b.remove(cut)
  b.gravity(heightOf)
  return b.paste(c, board: "B", centre: Point(x: 0, y: 0), heightOf: heightOf)
}

@Test func aCutRunOfMixedHeightsPastesBackInOrder() {
  var b = board([card("a", 24, 72), card("b", 24, 144), card("c", 24, 264), card("d", 24, 336)], [lane("l", 0, 0)])
  // Heights can't be read from the board while it pastes: b is tall, and so is the first copy measured, which is b's.
  var tall: Set<String> = ["b"]
  var seen: Set<String> = ["a", "b", "c", "d"]
  let heightOf: HeightOf = { id in
    if seen.insert(id).inserted, seen.count == 5 { tall.insert(id) }
    return tall.contains(id) ? 96 : 48
  }
  let copies = cutAndPaste(&b, ["b", "c"], heightOf: heightOf)
  #expect(tall.contains(copies[0]))
  #expect(ys(b, "a", copies[0], copies[1], "d") == [72, 144, 264, 336])
}

@Test func cutLaneCardsWithOneBetweenPasteBackEitherSideOfIt() {
  let abcd = board([card("a", 24, 72), card("b", 24, 144), card("c", 24, 216), card("d", 24, 288)], [lane("l", 0, 0)])
  var b = abcd
  var copies = cutAndPaste(&b, ["b", "d"])
  #expect(ys(b, "a", copies[0], "c", copies[1]) == [72, 144, 216, 288])
  b = abcd
  copies = cutAndPaste(&b, ["a", "c"])
  #expect(ys(b, copies[0], "b", copies[1], "d") == [72, 144, 216, 288])
}

@Test func aCopyOfAnOriginalThatGrewTallerLandsBelowIt() {
  var b = stackBoard()
  let c = clipOf(b, "a")
  let tall: HeightOf = { $0 == "a" ? 96 : 48 }
  b.gravity(tall)
  let copy = b.paste(c, board: "B", centre: Point(x: 0, y: 0), heightOf: tall)[0]
  #expect(ys(b, "a", copy, "b") == [72, 192, 264])
}
