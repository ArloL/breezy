import Foundation

/// The board being edited, with undo. A change goes through `perform`, or through a gesture
/// (`begin`, `update`…, `end`) such as a drag or an edit session; either registers one undo
/// step, and only when the board changed. A step undoes field by field, so changes from another device made since stay.
public final class BoardModel {
  public private(set) var board: Board
  public let undoManager: UndoManager
  /// Called after every change, undo and redo included, with the board before it.
  public var onChange: ((Board) -> Void)?
  /// Called with true when a gesture first changes the board, and with false when the gesture
  /// ends or is cancelled: until then the change has no undo step, yet must count as unsaved.
  public var onPending: ((Bool) -> Void)?
  /// Called after every change too, undo, redo and `applyRemote` included: a second listener.
  public var onEdit: (() -> Void)?
  /// Called when a gesture ends or is cancelled.
  public var onGestureEnd: (() -> Void)?
  private var gestureStart: Board?
  private var pending = false

  public init(board: Board = Board(), undoManager: UndoManager = UndoManager()) {
    self.board = board
    self.undoManager = undoManager
    undoManager.groupsByEvent = false
    undoManager.levelsOfUndo = Metrics.undoLimit
  }

  public var inGesture: Bool { gestureStart != nil }

  public func perform(_ name: String, _ change: (inout Board) -> Void) {
    let before = board
    change(&board)
    guard board != before else { return }
    notify(before)
    record(before, name)
  }

  public func begin() {
    if gestureStart == nil { gestureStart = board }
  }

  /// A step within a gesture: notifies, but registers no undo.
  public func update(_ change: (inout Board) -> Void) {
    let before = board
    change(&board)
    guard board != before else { return }
    notify(before)
    if gestureStart != nil && !pending {
      pending = true
      onPending?(true)
    }
  }

  public func end(_ name: String) {
    guard let start = gestureStart else { return }
    cancelGesture()
    record(start, name)
  }

  /// Puts a board read from disk in place, with an empty history.
  public func replace(_ board: Board) {
    let before = self.board
    cancelGesture()
    undoManager.removeAllActions()
    self.board = board
    if board != before { notify(before) }
  }

  private func notify(_ before: Board) {
    onChange?(before)
    onEdit?()
  }

  /// Puts in changes from another device, without an undo step; the steps already taken still undo
  /// only what they changed. Does nothing during a gesture: the caller waits for it to end.
  public func applyRemote(_ new: Board) {
    guard !inGesture, new != board else { return }
    let before = board
    board = new
    notify(before)
  }

  private func cancelGesture() {
    let ended = gestureStart != nil
    gestureStart = nil
    if pending {
      pending = false
      onPending?(false)
    }
    if ended { onGestureEnd?() }
  }

  private func record(_ before: Board, _ name: String) {
    guard board != before else { return }
    let after = board
    undoManager.beginUndoGrouping()
    undoManager.registerUndo(withTarget: self) { $0.restore(from: after, to: before, name) }
    undoManager.setActionName(name)
    undoManager.endUndoGrouping()
  }

  /// Takes the board from `from` to `to` field by field, leaving what changed since alone;
  /// a gesture in progress is dropped.
  private func restore(from: Board, to: Board, _ name: String) {
    let now = board
    let settled = gestureStart ?? now
    cancelGesture()
    undoManager.registerUndo(withTarget: self) { $0.restore(from: to, to: from, name) }
    undoManager.setActionName(name)
    board = Board.rebase(base: from, mine: to, theirs: settled)
    notify(now)
  }
}
