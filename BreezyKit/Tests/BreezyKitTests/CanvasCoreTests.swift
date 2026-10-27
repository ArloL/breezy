import Testing
@testable import BreezyKit

@MainActor private func canvas(_ b: Board) -> CanvasCore {
  let c = CanvasCore(model: BoardModel(board: b))
  c.heightOf = h48
  return c
}

@MainActor @Test func aCardDraggedIntoALaneLandsInItsColumnAsOneStep() {
  let c = canvas(board([card("a", 24, 72), card("d", 600, 72)], [lane("l", 0, 0, 288)]))
  c.press(at: Point(x: 620, y: 90))
  c.dragged(to: Point(x: 50, y: 200))
  #expect(c.held.ids == ["d"])
  #expect(c.scene.cards.first { $0.id == "d" }.map { ($0.x, $0.y) }! == (30, 200 - 18))
  c.release()
  #expect(c.board.card("d").map { ($0.x, $0.y) }! == (24, 144))
  #expect(c.selection == ["d"])
  #expect(c.held == Grip())
  c.model.undoManager.undo()
  #expect(c.board.card("d").map { ($0.x, $0.y) }! == (600, 72))
}

@MainActor @Test func aPressMovingThreePointsOrLessStaysAClick() {
  let c = canvas(board([card("a", 0, 0), card("b", 300, 0)]))
  c.selection = ["a", "b"]
  c.press(at: Point(x: 10, y: 10))
  c.dragged(to: Point(x: 12, y: 12))
  #expect(c.held.ids.isEmpty)
  c.release()
  #expect(c.selection == ["a"])
  #expect(c.board.card("a")!.x == 0)
}

@MainActor @Test func aBoxSelectsWhatItTouchesAndShiftAddsToTheSelection() {
  let c = canvas(board([card("a", 0, 0), card("b", 300, 0), card("c", 600, 0)]))
  c.selection = ["c"]
  c.press(at: Point(x: 0, y: 200), shift: true)
  c.dragged(to: Point(x: 310, y: 40))
  #expect(c.marquee == Rect(x: 0, y: 40, w: 310, h: 160))
  #expect(c.selection == ["a", "b", "c"])
  c.release()
  #expect(c.marquee == nil)
}

@MainActor @Test func dragByTheHeaderMovesALaneWithItsCards() {
  let c = canvas(board([card("a", 24, 72)], [lane("l", 0, 0, 288)]))
  c.press(at: Point(x: 100, y: 10))
  c.dragged(to: Point(x: 196, y: 58))
  #expect(c.held.ids == ["l", "a"])
  c.release()
  #expect(c.board.lane("l").map { ($0.x, $0.y) }! == (96, 48))
  #expect(c.board.card("a").map { ($0.x, $0.y) }! == (120, 120))
}

@MainActor @Test func whatSomeoneElseHoldsCannotBePressed() {
  let c = canvas(board([card("a", 0, 0)]))
  c.taken = { ["a"] }
  c.press(at: Point(x: 10, y: 10))
  #expect(c.drag == nil)
  #expect(c.selection.isEmpty)
}

@MainActor @Test func aRefusalPutsTheDragBack() {
  let c = canvas(board([card("a", 0, 0)]))
  c.press(at: Point(x: 10, y: 10))
  c.dragged(to: Point(x: 200, y: 10))
  #expect(c.refused(["a"]))
  #expect(c.drag == nil)
  #expect(c.board.card("a")!.x == 0)
}

@MainActor @Test func aRefusalWithNoDragIsNone() {
  let c = canvas(board([card("a", 0, 0)]))
  #expect(!c.refused(["a"]))
}

@MainActor @Test func theFoldTurnsACardWithNotesOverAndBack() {
  var a = card("a", 0, 0)
  a.notes = "n"
  let c = canvas(board([a, card("b", 0, 96)]))
  #expect(c.hitsFold(a, Point(x: 230, y: 40)))
  #expect(!c.hitsFold(a, Point(x: 224, y: 40)))
  #expect(!c.hitsFold(a, Point(x: 230, y: 32)))
  #expect(!c.hitsFold(c.board.card("b")!, Point(x: 241, y: 145)))
  c.press(at: Point(x: 230, y: 40))
  #expect(c.turned == "a")
  #expect(c.selection == ["a"])
  #expect(c.drag == nil)
  #expect(c.drawnRect(a) == Rect(x: 0, y: 0, w: 480, h: 288))
  #expect(c.hitsFold(a, Point(x: 460, y: 270)))
  c.press(at: Point(x: 460, y: 270))
  #expect(c.turned == nil)
}

@MainActor @Test func aTurnedCardIsTallerByEachLineOfItsNotesBlankOnesToo() {
  var a = card("a", 0, 0)
  a.notes = String(repeating: "\n", count: 12)
  let c = canvas(board([a]))
  c.turned = "a"
  #expect(c.drawnRect(a).h == 16 * 24)
}

@MainActor @Test func pressingElsewhereTurnsTheTurnedCardBack() {
  let c = canvas(board([card("a", 0, 0), card("b", 0, 96)]))
  c.turned = "a"
  c.press(at: Point(x: 10, y: 600))
  #expect(c.turned == nil)
}

@MainActor @Test func anOptionPressSelectsThePile() {
  let c = canvas(board([card("a", 24, 72), card("b", 24, 144), card("c", 600, 0)], [lane("l", 0, 0, 288)]))
  c.press(at: Point(x: 30, y: 80))
  #expect(c.selection == ["a"])
  c.release()
  c.press(at: Point(x: 30, y: 80), option: true)
  #expect(c.selection == ["a", "b"])
}

@MainActor @Test func theSelectionTellsOfChangesOnlyAndLeavesOutWhatOthersHold() {
  let c = canvas(board([card("a", 0, 0), card("b", 300, 0)]))
  var told = 0
  c.onSelection = { told += 1 }
  c.taken = { ["b"] }
  c.selection = ["a", "b"]
  #expect(c.selection == ["a"])
  #expect(told == 1)
  c.selection = ["a"]
  #expect(told == 1)
}

@MainActor @Test func theLaneCornerResizesItAndTheSceneShowsItsGrowthOffTheGrid() {
  let l = lane("l", 0, 0, 288, 720)
  #expect(CanvasCore.hitsCorner(l, Point(x: 280, y: 710)))
  #expect(!CanvasCore.hitsCorner(l, Point(x: 268, y: 710)))
  #expect(!CanvasCore.hitsCorner(l, Point(x: 280, y: 700)))
  let c = canvas(board([], [l]))
  var floats = 0
  c.onFloat = { floats += 1 }
  c.press(at: Point(x: 280, y: 710))
  #expect(c.drag?.kind == .resize)
  c.dragged(to: Point(x: 290, y: 715))
  #expect(c.board.lane("l").map { ($0.w, $0.h) }! == (288, 720))
  #expect(c.held.growth == Vector(dx: 10, dy: 5))
  #expect(c.scene.lanes.map { ($0.w, $0.h) }.first! == (298, 725))
  #expect(floats == 1)
  c.dragged(to: Point(x: 330, y: 715))
  #expect(c.board.lane("l")!.w == 336)
  #expect(floats == 1)
  c.dragged(to: Point(x: 331, y: 715))
  #expect(floats == 2)
  c.release()
  #expect(c.board.lane("l").map { ($0.w, $0.h) }! == (336, 720))
  #expect(c.model.undoManager.undoActionName == "Resize Lane")
}

@MainActor @Test func aDraggedLaneIsShownWhereThePointerHoldsIt() {
  let c = canvas(board([], [lane("l", 0, 0, 288)]))
  c.press(at: Point(x: 100, y: 10))
  c.dragged(to: Point(x: 110, y: 15))
  #expect(c.scene.lanes.map { ($0.x, $0.y) }.first! == (10, 5))
}

@MainActor @Test func belowItsHeaderALaneIsNoHandle() {
  let c = canvas(board([], [lane("l", 0, 0, 288)]))
  c.press(at: Point(x: 100, y: 48))
  #expect(c.drag?.kind == .marquee)
}

@MainActor @Test func aPressMovingExactlyThreePointsStaysAClick() {
  let c = canvas(board([card("a", 0, 0)]))
  c.press(at: Point(x: 10, y: 10))
  c.dragged(to: Point(x: 13, y: 10))
  #expect(c.held.ids.isEmpty)
}

@MainActor @Test func spaceTurnsTheOneSelectedCardAndEscTurnsItBackThenClears() {
  let c = canvas(board([card("a", 0, 0), card("b", 300, 0)], [lane("l", 0, 600)]))
  c.selection = ["a", "b"]
  #expect(c.key(code: 49, chars: " "))
  #expect(c.turned == nil)
  c.selection = ["l"]
  c.key(code: 49, chars: " ")
  #expect(c.turned == nil)
  c.selection = ["a"]
  c.key(code: 49, chars: " ")
  #expect(c.turned == "a")
  c.key(code: 49, chars: " ")
  #expect(c.turned == nil)
  c.key(code: 49, chars: " ")
  #expect(c.key(code: 53, chars: "\u{1b}"))
  #expect(c.turned == nil)
  #expect(c.selection == ["a"])
  c.key(code: 53, chars: "\u{1b}")
  #expect(c.selection.isEmpty)
  #expect(!c.key(code: 0, chars: "a"))
}
