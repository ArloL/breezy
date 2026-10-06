import Testing
@testable import BreezyKit

/// Starts a drag of `ids`, as the canvas does: origins plus the layout the others return to.
private func drag(_ b: Board, _ ids: [String]) -> (origins: [Origin], room: Room) {
  let origins = ids.map { Origin(id: $0, x: b.card($0)!.x, y: b.card($0)!.y) }
  return (origins, Room(base: b.layout(excluding: Set(ids)), heightOf: h48))
}

private func stackBoard(_ h: Double = 480) -> Board {
  board([card("a", 24, 72), card("b", 24, 144), card("d", 600, 72)], [lane("l", 0, 0, 480, h)])
}

@Test func aHeldCardKeepsAPlaceFreeByItsCentreAndLandsThere() {
  var b = stackBoard()
  let d = drag(b, ["d"])
  b.moveCards(d.origins, dx: -576, dy: 48, room: d.room)
  #expect(ys(b, "a", "d", "b") == [72, 120, 216])
  b.land(["d"], room: d.room)
  #expect(ys(b, "a", "d", "b") == [72, 144, 216])
}

@Test func draggingAwayGivesCardsBackTheirPlaces() {
  var b = stackBoard()
  let d = drag(b, ["d"])
  b.moveCards(d.origins, dx: -576, dy: 0, room: d.room)
  #expect(ys(b, "a", "b") == [144, 216])
  b.moveCards(d.origins, dx: 0, dy: 0, room: d.room)
  #expect(ys(b, "a", "b") == [72, 144])
}

@Test func takingACardOutOfAStackClosesTheGap() {
  var b = board([card("a", 24, 72), card("b", 24, 144), card("c", 24, 216)], [lane("l", 0, 0)])
  let d = drag(b, ["b"])
  b.moveCards(d.origins, dx: 576, dy: 0, room: d.room)
  #expect(ys(b, "a", "c") == [72, 144])
}

@Test func heldCardsAreOrderedAsABlockByTheirTopCard() {
  var b = board([card("a", 24, 72), card("p", 600, 72), card("q", 600, 144)], [lane("l", 0, 0)])
  let d = drag(b, ["p", "q"])
  b.moveCards(d.origins, dx: -576, dy: 0, room: d.room)
  b.land(["p", "q"], room: d.room)
  #expect(ys(b, "p", "q", "a") == [72, 144, 216])
}

@Test func gravityFloatsLaneCardsUpTheirOwnColumnAndLeavesTheCanvasAlone() {
  var b = board(
    [card("a", 24, 72), card("b", 24, 360), card("side", 288, 240), card("free", 720, 360)],
    [lane("l", 0, 0, 576, 480)]
  )
  b.gravity(h48)
  #expect(ys(b, "a", "b", "side", "free") == [72, 144, 72, 360])
}

@Test func aLaneGrowsToFitItsStackAndShrinksBack() {
  var b = stackBoard(240)
  let d = drag(b, ["d"])
  b.moveCards(d.origins, dx: -576, dy: 0, room: d.room)
  #expect(b.lane("l")!.h == 288)
  b.moveCards(d.origins, dx: 0, dy: 0, room: d.room)
  #expect(b.lane("l")!.h == 240)
}

@Test func pileTakesALaneCardAndThoseBelowItInItsColumn() {
  let b = board(
    [card("a", 24, 72), card("b", 24, 144), card("side", 288, 144), card("c", 24, 240), card("free", 24, 840)],
    [lane("l", 0, 0, 576, 480)]
  )
  #expect(b.pile("b", heightOf: h48) == ["b", "c"])
  #expect(b.pile("free", heightOf: h48) == ["free"])
}
