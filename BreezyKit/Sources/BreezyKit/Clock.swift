import Foundation

/// Runs work on the main actor after a delay in seconds. The apps use `afterOnMain`; the fuzzer passes its virtual clock.
public typealias Schedule = (TimeInterval, @escaping @MainActor () -> Void) -> Void

public func afterOnMain(_ delay: TimeInterval, _ work: @escaping @MainActor () -> Void) {
  DispatchQueue.main.asyncAfter(deadline: .now() + delay) { MainActor.assumeIsolated(work) }
}

/// Milliseconds since boot, which only go forward.
public func systemUptime() -> Double { ProcessInfo.processInfo.systemUptime * 1000 }
