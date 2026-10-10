import Foundation

/// Keeps an open board's model and the store in step. Local edits go into the store field by field,
/// so they never overwrite a field the other device changed. Changes merged from the server come
/// back once no gesture is under way, stacked as this device shows them; the restacked positions
/// stay local, as devices measure text differently and would push each other's layouts forever.
public final class BoardBinding {
  public let id: String
  public let model: BoardModel
  public let store: Store
  public var restack: ((inout Board) -> Void)?
  /// Items someone else holds: local changes to them are not written, as the holder's are the ones that count.
  public var taken: () -> Set<String> = { [] }
  /// After every change to the model, after the binding's own handling.
  public var afterEdit: (() -> Void)?
  /// After a gesture ends or is cancelled, even when the binding's owner let go of it meanwhile, as a window closed
  /// mid-edit does: the gesture's holds are released from here.
  public var afterGesture: (() -> Void)?
  /// The board as last given to or taken from the store, stacked as shown.
  public private(set) var seen: Board
  private var waiting = false
  private var flushing = false
  private let schedule: Schedule

  /// `schedule(0, …)` runs on the next turn.
  public init(
    id: String, model: BoardModel, store: Store,
    schedule: @escaping Schedule = { delay, work in
      if delay > 0 {
        afterOnMain(delay, work)
      } else {
        DispatchQueue.main.async { MainActor.assumeIsolated(work) }
      }
    }
  ) {
    self.id = id
    self.model = model
    self.store = store
    self.schedule = schedule
    seen = model.board
    model.onEdit = { [weak self] in
      self?.changed()
      self?.afterEdit?()
    }
    model.onGestureEnd = { [weak self] in
      guard let self else { return }
      // after the gesture's undo step is registered, so that the step holds only local changes
      schedule(0) {
        if self.waiting { self.pull() }
        self.afterGesture?()
      }
    }
  }

  /// After every change to the model: flushes shortly.
  public func changed() {
    guard !flushing else { return }
    flushing = true
    schedule(0.3) { [weak self] in
      self?.flushing = false
      self?.flush()
    }
  }

  /// Writes what changed since the store last saw the board; → whether anything did.
  @discardableResult public func flush() -> Bool {
    guard model.board != seen else { return false }
    let held = taken()
    let changes = Records.changes(from: seen, to: model.board, board: id, orders: store.orders(of: id)).filter { !held.contains($0.key) }
    seen = model.board
    guard !changes.isEmpty else { return false }
    store.apply(changes)
    return true
  }

  /// After the store merged changes for this board.
  public func pull() {
    flush()
    guard !model.inGesture else {
      waiting = true
      return
    }
    waiting = false
    var b = store.board(id)
    restack?(&b)
    seen = b
    model.applyRemote(b)
  }
}
