import Foundation
import Testing
@testable import BreezyKit

@MainActor private func opened(_ contents: Board) -> (Store, String, BoardModel, BoardBinding) {
  let store = Store()
  let id = store.createBoard(title: "B", contents: contents)
  settle(store)
  let model = BoardModel(board: store.board(id))
  return (store, id, model, BoardBinding(id: id, model: model, store: store))
}

@MainActor @Test func aMergeDuringAGestureWaitsAndKeepsTheTypedText() async throws {
  let (store, id, model, binding) = opened(board([card("a", 0, 0, "x")]))
  model.begin()
  model.update { $0.setText("a", "typed") }
  store.merge([Incoming(id: "n", version: 2, record: Records.card(card("n", 0, 96, "new"), board: id, order: "z"))])
  binding.pull()
  #expect(model.board.card("n") == nil)
  model.end("Edit Card")
  try await Task.sleep(for: .milliseconds(50))
  #expect(model.board.card("n")?.text == "new")
  #expect(model.board.card("a")?.text == "typed")
  #expect(store.board(id).card("a")?.text == "typed")
  #expect(model.undoManager.undoActionName == "Edit Card")
}

@MainActor @Test func restackingAMergeIsShownButNotWritten() {
  let (store, id, model, binding) = opened(board([card("a", 0, 0)]))
  binding.restack = { b in for i in b.cards.indices { b.cards[i].y += 24 } }
  var r = store.state.records["a"]!.current
  r["color"] = .number(3)
  store.merge([Incoming(id: "a", version: 2, record: r)])
  binding.pull()
  #expect(model.board.card("a")?.y == 24)
  #expect(model.board.card("a")?.color == 3)
  binding.flush()
  #expect(store.board(id).card("a")?.y == 0)
  #expect(store.pending.isEmpty)
}

@MainActor @Test func localEditsReachTheStoreFieldByField() {
  let (store, id, model, binding) = opened(board([card("a", 0, 0, "x")]))
  var r = store.state.records["a"]!.current
  r["text"] = .string("theirs")
  store.merge([Incoming(id: "a", version: 2, record: r)])
  model.perform("Colour") { $0.setColor(["a"], 3) }
  binding.flush()
  let c = store.board(id).card("a")!
  #expect(c.text == "theirs" && c.color == 3)
}

@MainActor @Test func changesToItemsOthersHoldAreNotWritten() {
  let (store, id, model, binding) = opened(board([card("a", 0, 0), card("b", 0, 96)]))
  binding.taken = { ["b"] }
  model.perform("Move") {
    $0.cards[0].x = 48
    $0.cards[1].x = 480
  }
  binding.flush()
  #expect(store.board(id).card("a")?.x == 48)
  #expect(store.board(id).card("b")?.x == 0)
}

@MainActor @Test func theBindingTellsOfEditsAndOfGestureEnds() async throws {
  let (_, _, model, binding) = opened(board([card("a", 0, 0)]))
  var edits = 0, ends = 0
  binding.afterEdit = { edits += 1 }
  binding.afterGesture = { ends += 1 }
  model.begin()
  model.update { $0.setText("a", "y") }
  model.end("Edit Card")
  try await Task.sleep(for: .milliseconds(50))
  #expect(edits == 1)
  #expect(ends == 1)
}

@MainActor @Test func aGestureEndingAsItsBindingGoesIsStillTold() async throws {
  var (_, _, model, binding): (Store, String, BoardModel, BoardBinding?) = opened(board([card("a", 0, 0)]))
  var ends = 0
  binding?.afterGesture = { ends += 1 }
  model.begin()
  model.update { $0.setText("a", "y") }
  model.end("Edit Card")
  binding = nil
  try await Task.sleep(for: .milliseconds(50))
  #expect(ends == 1)
}

@MainActor @Test func undoingADeleteBringsTheCardBackToTheStoreToBePushed() {
  let (store, id, model, binding) = opened(board([card("a", 0, 0, "x")]))
  model.perform("Delete") { $0.remove(["a"]) }
  binding.flush()
  #expect(store.board(id).cards.isEmpty)
  // the delete went to the server
  settle(store, version: 2)
  model.undoManager.undo()
  binding.flush()
  #expect(store.board(id).cards.map(\.text) == ["x"])
  #expect(store.pending.map(\.id) == ["a"])
}

@MainActor @Test func anEditToACardDeletedElsewhereDoesNotBringItBack() {
  let (store, id, model, binding) = opened(board([card("a", 0, 0, "x")]))
  store.merge([Incoming(id: "a", version: 2, record: .marker("card"))])
  model.perform("Colour") { $0.setColor(["a"], 3) }
  binding.flush()
  #expect(store.board(id).cards.isEmpty)
}
