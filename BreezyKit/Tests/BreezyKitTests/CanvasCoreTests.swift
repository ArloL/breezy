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
