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

@Test func openSpotFindsTheNearestPlaceLeftOfOrAboveAnItem() {
  let s = board([], [lane("l", 600, 0, 480, 720)]).openSpot(w: 288, h: 200, near: 500, 100, heightOf: h48)
  #expect([s.x, s.y] == [288, 96])
  let t = board([], [lane("l", 0, 600, 720, 480)]).openSpot(w: 200, h: 288, near: 100, 500, heightOf: h48)
  #expect([t.x, t.y] == [96, 288])
}

@Test func aLaneOffTheOriginCarriesItsCardsByTheDistanceItMoved() {
  var b = board([card("a", 72, 96)], [lane("l", 48, 24)])
  b.moveLane(Origin(id: "l", x: 48, y: 24), cards: [Origin(id: "a", x: 72, y: 96)], dx: 61, dy: 50)
  #expect([b.lane("l")!.x, b.lane("l")!.y] == [120, 72])
  #expect([b.card("a")!.x, b.card("a")!.y] == [144, 144])
}

@Test func rectsTouchingAtAnEdgeDoNotOverlapAndAnEdgeIsInside() {
  let r = Rect(x: 0, y: 0, w: 10, h: 10)
  for o in [Rect(x: 10, y: 0, w: 5, h: 5), Rect(x: -5, y: 0, w: 5, h: 5), Rect(x: 0, y: 10, w: 5, h: 5), Rect(x: 0, y: -5, w: 5, h: 5)] {
    #expect(!r.intersects(o))
  }
  #expect(!r.sharesColumn(with: Rect(x: 10, y: 50, w: 5, h: 5)))
  #expect(!r.sharesColumn(with: Rect(x: -5, y: 50, w: 5, h: 5)))
  #expect(r.contains(0, 0) && r.contains(10, 10))
  #expect(Metrics.laneWidth == 288)
}

@Test func recentringCentresTheBoardOnTheOriginOnceItReachesPastTheLimit() {
  let b = board([card("a", 0, 0)], [lane("l", 40_000, 0, 480, 720)])
  let r = b.recentred(within: 20_000)
  #expect([r.card("a")!.x, r.card("a")!.y] == [-20_232, -360])
  #expect([r.lane("l")!.x, r.lane("l")!.y] == [19_768, -360])
  let edge = board([card("a", -240, -240)], [lane("l", 0, 0, 240, 240)])
  #expect(edge.recentred(within: 240) == edge)
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

@Test func openSpotIsTheNearestPlaceAGridClearOfEverything() {
  let b = board([card("a", 600, 0)], [lane("l", 0, 0, 480, 720)])
  let s = b.openSpot(w: 288, h: 720, near: 120, 0, heightOf: h48)
  #expect([s.x, s.y] == [504, 72])
  let free = b.openSpot(w: 288, h: 720, near: 130, 1000, heightOf: h48)
  #expect([free.x, free.y] == [120, 1008])
}

@Test func openSpotKeepsAGridClearOfAnItemRightOfOrBelowIt() {
  let right = board([card("a", 252, 0)], []).openSpot(w: 240, h: 48, near: 0, 0, heightOf: h48)
  #expect([right.x, right.y] == [-24, 0])
  let below = board([card("a", 0, 60)], []).openSpot(w: 240, h: 48, near: 0, 0, heightOf: h48)
  #expect([below.x, below.y] == [0, -24])
}

@Test func recentringLeavesABoardReachingEachLimitAndMovesOneReachingPastAnyOne() {
  let reaching = [lane("l", -240, 0, 96, 96), lane("l", 144, 0, 96, 96), lane("l", 0, -240, 96, 96), lane("l", 0, 144, 96, 96)]
  for l in reaching {
    #expect(board([], [l]).recentred(within: 240) == board([], [l]))
    var past = l
    past.x += l.x < 0 ? -24 : l.x > 0 ? 24 : 0
    past.y += l.y < 0 ? -24 : l.y > 0 ? 24 : 0
    #expect(board([], [past]).recentred(within: 240) != board([], [past]), "\(past)")
  }
}
