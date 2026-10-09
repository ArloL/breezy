import Foundation

/// When what a space's gestures hold is let go. A gesture's finish writes its changes to the store and pushes them,
/// then lets go, so that others have the push before the release; only the space's latest finish lets go, and only
/// when none of the space's boards is in a gesture by then. Once a second, `sweep` lets go of holds that neither a
/// gesture nor a finish explains, as when a finish never ran.
@MainActor public final class GestureHolds {
  private var latest: [String: Int] = [:]
  private var running: [String: Int] = [:]
  private var idle: Set<String> = []

  public init() {}

  /// A gesture of `space` ended or was cancelled: `flush` now, then `sync`, then `release` unless a later finish of
  /// the space came meanwhile or `busy` says one of its boards is in a gesture.
  @discardableResult
  public func finish(
    _ space: String, flush: () -> Void, sync: @escaping () async -> Void, busy: @escaping () -> Bool, release: @escaping () -> Void
  ) -> Task<Void, Never> {
    flush()
    let n = latest[space, default: 0] + 1
    latest[space] = n
    running[space, default: 0] += 1
    return Task {
      await sync()
      running[space, default: 1] -= 1
      if latest[space] == n && !busy() { release() }
    }
  }

  /// About once a second for each space: lets go when it is `holding` but, on two ticks running, was not `busy` with a
  /// gesture and had no finish under way. The second tick leaves room for a gesture that ended just now, whose finish
  /// is about to start.
  public func sweep(_ space: String, holding: Bool, busy: Bool, release: () -> Void) {
    guard holding, !busy, running[space, default: 0] == 0 else {
      idle.remove(space)
      return
    }
    guard !idle.insert(space).inserted else { return }
    idle.remove(space)
    release()
  }
}
