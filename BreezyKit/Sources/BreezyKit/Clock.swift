import Foundation

/// Runs work on the main actor after a delay in seconds. The apps use `afterOnMain`; the fuzzer passes its virtual clock.
public typealias Schedule = (TimeInterval, @escaping @MainActor () -> Void) -> Void

public func afterOnMain(_ delay: TimeInterval, _ work: @escaping @MainActor () -> Void) {
  DispatchQueue.main.asyncAfter(deadline: .now() + delay) { MainActor.assumeIsolated(work) }
}

/// Milliseconds since boot, which only go forward.
/// ms since boot, sleep included, as CLOCK_MONOTONIC counts on Darwin: timeouts see the time a Mac slept.
public func systemUptime() -> Double { Double(clock_gettime_nsec_np(CLOCK_MONOTONIC)) / 1_000_000 }

/// A `Date` that only moves forward, from `uptime` in ms: for timeouts, which a wall clock set back would stall.
public func steady(_ uptime: @escaping () -> Double = systemUptime) -> () -> Date {
  { Date(timeIntervalSinceReferenceDate: uptime() / 1000) }
}
