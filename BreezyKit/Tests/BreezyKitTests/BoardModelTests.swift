import Testing
@testable import BreezyKit

@Test func aNewCardLeftBlankDisappearsWithoutAnUndoStep() {
  let m = BoardModel()
  m.begin()
  var id = ""
  m.update { id = $0.addCard(x: 0, y: 0) }
  m.update { $0.setText(id, "  \n ") }
  m.update { $0.finishEdit(id) }
  m.end("New Card")
  #expect(m.board.cards.isEmpty)
  #expect(!m.undoManager.canUndo)
}

@Test func aNewCardUndoesInOneStep() {
  let m = BoardModel()
  m.begin()
  var id = ""
  m.update { id = $0.addCard(x: 0, y: 0) }
  m.update { $0.setText(id, "Idea\nmore\n\n") }
  m.update { $0.finishEdit(id) }
  m.end("New Card")
  #expect(m.board.card(id)!.text == "Idea\nmore")
  #expect(m.undoManager.undoActionName == "New Card")
  m.undoManager.undo()
  #expect(m.board.cards.isEmpty)
}

@Test func editingWithoutChangesLeavesNoUndoStep() {
  let m = BoardModel(board: board([card("a", 0, 0, "x")]))
  m.begin()
  m.update { $0.finishEdit("a") }
  m.end("Edit Card")
  #expect(!m.undoManager.canUndo)
}

@Test func aNoOpGestureKeepsRedoAvailable() {
  let m = BoardModel(board: board([card("a", 0, 0)]))
  m.perform("Colour") { $0.setColor(["a"], 3) }
  m.undoManager.undo()
  m.begin()
  m.end("Move")
  m.undoManager.redo()
  #expect(m.board.card("a")!.color == 3)
}

@Test func editingNotesUndoesInOneStep() {
  let m = BoardModel(board: board([card("a", 0, 0)]))
  m.begin()
  m.update { $0.setNotes("a", "x") }
  m.update { $0.setNotes("a", "xy") }
  m.update { $0.finishEdit("a") }
  m.end("Edit Card")
  m.undoManager.undo()
  #expect(m.board.card("a")!.notes == nil)
}

@Test func undoAndRedoRestoreCardsAndLanes() {
  let m = BoardModel()
  var id = ""
  m.perform("New Lane") { $0.addLane(x: 0, y: 0) }
  m.perform("New Card") { id = $0.addCard(x: 0, y: 0) }
  m.undoManager.undo()
  #expect(m.board.card(id) == nil)
  m.undoManager.undo()
  #expect(m.board.lanes.isEmpty)
  m.undoManager.redo()
  m.undoManager.redo()
  #expect(m.board.lanes.count == 1 && m.board.card(id) != nil)
}

@Test func undoHistoryIsCappedAt100Steps() {
  let m = BoardModel(board: board([card("a", 0, 0)]))
  for i in 0..<120 { m.perform("Colour") { $0.setColor(["a"], (i % 5) + 1) } }
  var steps = 0
  while m.undoManager.canUndo {
    m.undoManager.undo()
    steps += 1
  }
  #expect(steps == 100)
}

@Test func changesNotifyTheListenerWithThePreviousBoard() {
  let m = BoardModel()
  var olds: [Board] = []
  m.onChange = { olds.append($0) }
  m.perform("New Card") { $0.addCard(x: 0, y: 0) }
  #expect(olds == [Board()])
  m.undoManager.undo()
  #expect(olds.count == 2)
}

@Test func undoDuringGestureCancelsIt() {
  let m = BoardModel(board: board([card("a", 0, 0)]))
  m.perform("Colour") { $0.setColor(["a"], 2) }
  m.begin()
  m.update { $0.setText("a", "changed") }
  m.undoManager.undo()
  #expect(m.board == board([card("a", 0, 0)]))
  #expect(!m.inGesture)
  m.end("Edit Card")
  #expect(m.undoManager.canRedo)
}

@Test func replaceClearsTheHistory() {
  let m = BoardModel()
  m.perform("New Card") { $0.addCard(x: 0, y: 0) }
  m.replace(board([card("z", 0, 0)]))
  #expect(m.board.cards.map(\.id) == ["z"])
  #expect(!m.undoManager.canUndo)
}

@Test func aGesturesChangeIsPendingUntilItEnds() {
  let m = BoardModel(board: board([card("a", 0, 0)]))
  var log: [Bool] = []
  m.onPending = { log.append($0) }
  m.begin()
  m.end("Move")
  #expect(log.isEmpty)
  m.begin()
  m.update { $0.setText("a", "x") }
  m.update { $0.setText("a", "xy") }
  #expect(log == [true])
  m.end("Edit Card")
  #expect(log == [true, false])
  m.begin()
  m.update { $0.setText("a", "z") }
  m.undoManager.undo()
  #expect(log == [true, false, true, false])
}

@Test func undoLeavesChangesFromAnotherDeviceAlone() {
  let m = BoardModel(board: board([card("a", 0, 0)]))
  m.perform("Colour") { $0.setColor(["a"], 3) }
  var remote = m.board
  remote.moveCards([Origin(id: "a", x: 0, y: 0)], dx: 48, dy: 0)
  m.applyRemote(remote)
  m.undoManager.undo()
  #expect(m.board.card("a")!.color == 1)
  #expect(m.board.card("a")!.x == 48)
}

@Test func undoKeepsAFieldTheOtherDeviceChangedSince() {
  let m = BoardModel(board: board([card("a", 0, 0)]))
  m.perform("Colour") { $0.setColor(["a"], 3) }
  var remote = m.board
  remote.setColor(["a"], 4)
  m.applyRemote(remote)
  m.undoManager.undo()
  #expect(m.board.card("a")!.color == 4)
}

@Test func redoPutsBackOnlyWhatTheStepChanged() {
  let m = BoardModel(board: board([card("a", 0, 0, "x")]))
  m.perform("Colour") { $0.setColor(["a"], 3) }
  m.undoManager.undo()
  var remote = m.board
  remote.setText("a", "y")
  m.applyRemote(remote)
  m.undoManager.redo()
  #expect(m.board.card("a")!.color == 3 && m.board.card("a")!.text == "y")
}

@Test func undoingANewCardKeepsItWhenTheOtherDeviceTypedInIt() {
  let m = BoardModel()
  var id = ""
  m.perform("New Card") { id = $0.addCard(x: 0, y: 0) }
  var remote = m.board
  remote.setText(id, "theirs")
  m.applyRemote(remote)
  m.undoManager.undo()
  #expect(m.board.card(id)?.text == "theirs")
}

@Test func changesFromAnotherDeviceAddNoUndoStep() {
  let m = BoardModel(board: board([card("a", 0, 0)]))
  var remote = m.board
  remote.setColor(["a"], 2)
  var heard = 0
  m.onEdit = { heard += 1 }
  m.applyRemote(remote)
  #expect(m.board == remote)
  #expect(!m.undoManager.canUndo)
  #expect(heard == 1)
}

@Test func changesFromAnotherDeviceWaitForAGesture() {
  let m = BoardModel(board: board([card("a", 0, 0)]))
  m.begin()
  m.update { $0.setText("a", "typing") }
  var remote = m.board
  remote.setColor(["a"], 2)
  m.applyRemote(remote)
  #expect(m.board.card("a")!.color == 1)
}

@Test func theEndOfAGestureIsHeard() {
  let m = BoardModel(board: board([card("a", 0, 0)]))
  var ended = 0
  m.onGestureEnd = { ended += 1 }
  m.begin()
  m.update { $0.setText("a", "typed") }
  m.end("Edit Card")
  #expect(ended == 1)
}

@Test func cancelPutsTheBoardBackAsTheGestureBegan() {
  let m = BoardModel(board: board([card("a", 0, 0)]))
  var ended = 0
  m.onGestureEnd = { ended += 1 }
  m.begin()
  #expect(m.gestureStartBoard == m.board)
  m.update { $0.setText("a", "typed") }
  m.cancel()
  #expect(m.board.card("a")?.text == "t")
  #expect(!m.inGesture && m.gestureStartBoard == nil)
  #expect(ended == 1)
  #expect(!m.undoManager.canUndo)
}
