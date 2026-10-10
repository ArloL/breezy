import Foundation

/// The glue between a space group's engine, live layer and gesture holds and the boards open on it, as the web's
/// collab.js; the app keeps visibility, drawing and windows. While a gesture holds items, what it changes goes live; at
/// its end the board is pushed at once, then let go. Any other edit, an edit ending a gesture that held nothing included,
/// is pushed at once and, when its push goes now, shown on others' screens ahead of it.
@MainActor public final class Collab {
  public let group: Spaces.Group
  let holds: GestureHolds
  private var sessions: [Session] = []

  /// `holds` is shared by the device's groups.
  public init(group: Spaces.Group, holds: GestureHolds) {
    self.group = group
    self.holds = holds
    // others follow a held gesture live, and see its intermediate states pushed as changes they restack around
    group.engine.holdBack = { [weak self] in
      guard let self, let live = self.group.live else { return false }
      return busy && live.connected && !live.mine.isEmpty
    }
  }

  /// Whether a board open on the group is in a gesture.
  public var busy: Bool { sessions.contains { $0.model?.inGesture == true } }

  /// Board `id` open in `model` and `binding`, whose `afterEdit` and `afterGesture` the session takes; `caret` is where
  /// a gesture's text caret is.
  public func open(_ id: String, model: BoardModel, binding: BoardBinding, caret: @escaping () -> Caret? = { nil }) -> Session {
    let s = Session(self, id, model, binding, caret)
    sessions.append(s)
    binding.taken = { [weak group] in group?.live?.taken ?? [] }
    // a gesture's end finishes even after the board closed, as a window closed mid-edit does
    binding.afterEdit = { s.edited() }
    binding.afterGesture = { s.ended() }
    return s
  }

  /// About once a second: the live layer's tick, and holds let go that no gesture or finish explains.
  public func tick() {
    guard let live = group.live, let space = group.space else { return }
    live.tick()
    holds.sweep(space, holding: !live.mine.isEmpty, busy: busy, release: live.release)
  }

  @MainActor public final class Session {
    let collab: Collab
    let id: String
    weak var model: BoardModel?
    weak var binding: BoardBinding?
    let caret: () -> Caret?
    /// The model was in a gesture at the last edit.
    private var gesturing = false
    /// A gesture asked for holds and has not finished yet.
    private var unfinished = false

    init(_ collab: Collab, _ id: String, _ model: BoardModel, _ binding: BoardBinding, _ caret: @escaping () -> Caret?) {
      self.collab = collab
      self.id = id
      self.model = model
      self.binding = binding
      self.caret = caret
    }

    /// Asks the relay to hold `ids` for the gesture starting.
    public func hold(_ ids: Set<String>) {
      guard let live = collab.group.live else { return }
      unfinished = true
      live.hold(ids)
      // what the gesture did before it held, such as making the card it edits, shows now rather than at its next change
      edited()
    }

    /// After every change to the model, after the binding's own handling.
    public func edited() {
      guard let model, let binding else { return }
      let group = collab.group, live = group.live
      if let start = model.gestureStartBoard {
        gesturing = true
        guard let live, !live.mine.isEmpty else { return }
        live.sendLive(board: id, items: Records.liveFields(from: start, to: model.board, ids: live.mine, board: id), caret: caret(),
                      starts: Records.startPositions(start, ids: live.mine))
        return
      }
      let ended = gesturing
      gesturing = false
      guard ended && unfinished else {
        let before = binding.seen
        guard binding.flush(), group.space != nil else { return }
        // shown only when its push goes now, as others would see it undone when the preview lapses
        let now = group.engine.pushesNow
        Task { await group.engine.sync() }
        let b = model.board
        let ids = Set(before.cards.map(\.id) + before.lanes.map(\.id) + b.cards.map(\.id) + b.lanes.map(\.id))
        if let live, now { live.sendEdit(board: id, items: Records.liveFields(from: before, to: b, ids: ids, board: id)) }
        return
      }
      unfinished = false
      guard let space = group.space else { return }
      let collab = collab
      collab.holds.finish(
        space, flush: { binding.flush() }, sync: { await group.engine.sync() }, busy: { collab.busy },
        release: { [weak group] in group?.live?.release() })
    }

    /// After a gesture ends or is cancelled. The model tells no edit when a gesture ends, as the web's does, so this is
    /// one.
    public func ended() { edited() }

    /// The board is no longer open: its model no longer counts as busy.
    public func close() { collab.sessions.removeAll { $0 === self } }
  }
}
