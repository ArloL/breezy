import Foundation

/// The board being edited, with undo. A change goes through `perform`, or through a gesture
/// (`begin`, `update`…, `end`) such as a drag or an edit session; either registers one undo
/// step, and only when the board changed.
public final class BoardModel {
  public private(set) var board: Board
  public let undoManager: UndoManager
  /// Called after every change, undo and redo included, with the board before it.
  public var onChange: ((Board) -> Void)?
  /// Called with true when a gesture first changes the board, and with false when the gesture
  /// ends or is cancelled: until then the change has no undo step, yet must count as unsaved.
  public var onPending: ((Bool) -> Void)?
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
    onChange?(before)
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
    onChange?(before)
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
    if board != before { onChange?(before) }
  }

  private func cancelGesture() {
    gestureStart = nil
    if pending {
      pending = false
      onPending?(false)
    }
  }

  private func record(_ before: Board, _ name: String) {
    guard board != before else { return }
    undoManager.beginUndoGrouping()
    undoManager.registerUndo(withTarget: self) { $0.restore(before, name) }
    undoManager.setActionName(name)
    undoManager.endUndoGrouping()
  }

  private func restore(_ state: Board, _ name: String) {
    let now = board
    cancelGesture()
    undoManager.registerUndo(withTarget: self) { $0.restore(now, name) }
    undoManager.setActionName(name)
    board = state
    onChange?(now)
  }
}
