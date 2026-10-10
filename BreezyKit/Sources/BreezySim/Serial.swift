import Foundation
import Synchronization

/// Runs every Swift job of the process on the main queue, in the order enqueued, and tells when nothing but the
/// caller's own task was enqueued. Uses the Swift runtime's enqueue hooks: the global executor's sends its jobs to the
/// main actor, so nonisolated code such as `HTTPTransport` runs there too, and the main executor's notes which tasks
/// were enqueued.
enum Serial {
  fileprivate typealias Original = @convention(thin) (UnownedJob) -> Void
  fileprivate typealias Hook = @convention(thin) (UnownedJob, Original) -> Void

  private static let global = hook("swift_task_enqueueGlobal_hook")
  private static let main = hook("swift_task_enqueueMainExecutor_hook")
  private static let installs = Mutex(0)

  private static func hook(_ name: String) -> UnsafeMutablePointer<Hook?> {
    guard let p = dlsym(dlopen(nil, RTLD_NOW), name) else { fatalError("no \(name) in the Swift runtime") }
    return p.assumingMemoryBound(to: Hook?.self)
  }

  /// Nests: the hooks go at the last `uninstall`.
  static func install() {
    installs.withLock { n in
      n += 1
      if n == 1 {
        global.pointee = toMain
        main.pointee = noting
      }
    }
  }

  static func uninstall() {
    installs.withLock { n in
      n -= 1
      if n == 0 {
        global.pointee = nil
        main.pointee = nil
      }
    }
  }

  /// Yields until a round in which only this task was enqueued, which means every other job has run and none is
  /// waiting; false after `cap` rounds. A task enqueues itself several times per yield, as it hops between executors.
  @MainActor static func settle(cap: Int) async -> Bool {
    for _ in 0..<cap {
      first.store(0, ordering: .relaxed)
      mixed.store(false, ordering: .relaxed)
      await Task.yield()
      if !mixed.load(ordering: .relaxed) { return true }
    }
    return false
  }
}

/// The first task enqueued on the main queue this round, and whether another was.
private let first = Atomic<Int>(0)
private let mixed = Atomic<Bool>(false)

private func toMain(_ job: UnownedJob, _ original: Serial.Original) { MainActor.shared.enqueue(job) }

private func noting(_ job: UnownedJob, _ original: Serial.Original) {
  let p = unsafeBitCast(job, to: Int.self)
  let (claimed, was) = first.compareExchange(expected: 0, desired: p, ordering: .relaxed)
  if !claimed && was != p { mixed.store(true, ordering: .relaxed) }
  original(job)
}
