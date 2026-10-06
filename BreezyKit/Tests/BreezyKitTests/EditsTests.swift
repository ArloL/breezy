import Testing
@testable import BreezyKit

@Test func snapRoundsToTheNearestGridLine() {
  #expect(Metrics.grid == 24)
  #expect(snap(35) == 24)
  #expect(snap(37) == 48)
  #expect(snap(-37) == -48)
}

@Test func addCardSnapsAndStartsEmpty() {
  var b = board()
  let id = b.addCard(x: 40, y: 56)
  let c = b.card(id)!
  #expect([c.x, c.y, c.w] == [48, 48, 240])
  #expect(c.text == "" && c.notes == nil && c.color == 1)
  #expect(b.cards.count == 1)
}

@Test func moveCardsSnapsRelativeToTheDragOrigins() {
  var b = board([card("a", 0, 0), card("b", 48, 24)])
  b.moveCards([Origin(id: "a", x: 0, y: 0), Origin(id: "b", x: 48, y: 24)], dx: 32, dy: 10)
  #expect([b.card("a")!.x, b.card("a")!.y, b.card("b")!.x, b.card("b")!.y] == [24, 0, 72, 24])
}

@Test func finishEditTrimsTrailingWhitespace() {
  var b = board([card("a", 0, 0, "Idea\nmore\n\n")])
  b.finishEdit("a")
  #expect(b.card("a")!.text == "Idea\nmore")
}

@Test func finishEditTrimsNotesAndDropsBlankOnes() {
  var b = board([card("a", 0, 0), card("b", 0, 0)])
  b.setNotes("a", "As a user\n\n")
  b.setNotes("b", " \n")
  b.finishEdit("a")
  b.finishEdit("b")
  #expect(b.card("a")!.notes == "As a user")
  #expect(b.card("b")!.notes == nil)
}

@Test func aCardWithOnlyNotesIsKeptOneBlankOnBothSidesIsRemoved() {
  var b = board([card("a", 0, 0, ""), card("b", 0, 0, "")])
  b.setNotes("a", "details")
  b.finishEdit("a")
  b.finishEdit("b")
  #expect(b.cards.map(\.id) == ["a"])
}

@Test func setColorChangesCardsOnly() {
  var b = board([card("a", 0, 0)], [lane("l", 0, 0)])
  b.setColor(["l"], 2)
  #expect(b.card("a")!.color == 1)
  b.setColor(["a", "l"], 4)
  #expect(b.card("a")!.color == 4)
}

@Test func removeDeletesALaneButNotTheCardsOnIt() {
  var b = board([card("a", 24, 72)], [lane("l", 0, 0)])
  b.remove(["l"])
  #expect(b.lanes.isEmpty && b.cards.count == 1)
  b.remove(["a"])
  #expect(b.cards.isEmpty)
}

@Test func cardsInLaneCountsCardsWhoseCentreIsInside() {
  let b = board([card("in", 360, 0), card("out", 384, 0)], [lane("l", 0, 0, 480, 720)])
  #expect(b.cardsInLane("l", heightOf: h48).map(\.id) == ["in"])
}

@Test func moveLaneCarriesItsCardsByTheSnappedDelta() {
  var b = board([card("a", 24, 72)], [lane("l", 0, 0)])
  b.moveLane(Origin(id: "l", x: 0, y: 0), cards: [Origin(id: "a", x: 24, y: 72)], dx: 61, dy: -14)
  #expect([b.lane("l")!.x, b.lane("l")!.y] == [72, -24])
  #expect([b.card("a")!.x, b.card("a")!.y] == [96, 48])
}

@Test func resizeLaneSnapsAndKeepsAMinimumSize() {
  var b = board([], [lane("l", 0, 0)])
  b.resizeLane("l", w: 520, h: 10)
  #expect([b.lane("l")!.w, b.lane("l")!.h] == [528, 96])
}

@Test func cardsInRectFindsOverlappingCards() {
  let b = board([card("a", 0, 0), card("b", 480, 480)])
  #expect(b.cardsInRect(Rect(x: 228, y: 36, w: 60, h: 60), heightOf: h48).map(\.id) == ["a"])
}
