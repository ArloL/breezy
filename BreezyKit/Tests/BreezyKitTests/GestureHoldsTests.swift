import Testing
@testable import BreezyKit

/// Syncs that end when the test says.
@MainActor private final class Syncs {
  var waiting: [CheckedContinuation<Void, Never>] = []

  func sync() async { await withCheckedContinuation { waiting.append($0) } }

  /// Until `n` syncs are under way.
  func started(_ n: Int) async {
    while waiting.count < n { await Task.yield() }
  }

  func end(_ i: Int) { waiting[i].resume() }
}

@MainActor @Test func aFinishLetsGoOnlyAfterItsPush() async {
  let holds = GestureHolds(), syncs = Syncs()
  var log: [String] = []
  let t = holds.finish("S", flush: { log.append("flush") }, sync: { await syncs.sync() }, busy: { false }, release: { log.append("release") })
  await syncs.started(1)
  #expect(log == ["flush"])
  syncs.end(0)
  await t.value
  #expect(log == ["flush", "release"])
}

@MainActor @Test func aGestureEndingWhileAnEarlierFinishSyncsIsPushedAndOnlyTheLatestLetsGo() async {
  let holds = GestureHolds(), syncs = Syncs()
  var flushed = 0, released = 0
  func finish() -> Task<Void, Never> {
    holds.finish("S", flush: { flushed += 1 }, sync: { await syncs.sync() }, busy: { false }, release: { released += 1 })
  }
  let first = finish()
  await syncs.started(1)
  let second = finish()
  await syncs.started(2)
  #expect(flushed == 2)
  syncs.end(0)
  await first.value
  #expect(released == 0)
  syncs.end(1)
  await second.value
  #expect(released == 1)
}

@MainActor @Test func aGestureCancelledBeforeAnyChangeStillLetsGo() async {
  let holds = GestureHolds()
  var released = false
  await holds.finish("S", flush: {}, sync: {}, busy: { false }, release: { released = true }).value
  #expect(released)
}

@MainActor @Test func aFinishKeepsTheHoldsWhileAnotherBoardOfTheSpaceIsInAGesture() async {
  let holds = GestureHolds()
  var busy = true, released = 0
  await holds.finish("S", flush: {}, sync: {}, busy: { busy }, release: { released += 1 }).value
  #expect(released == 0)
  holds.sweep("S", holding: true, busy: true) { released += 1 }
  holds.sweep("S", holding: true, busy: true) { released += 1 }
  #expect(released == 0)
  busy = false
  holds.sweep("S", holding: true, busy: busy) { released += 1 }
  holds.sweep("S", holding: true, busy: busy) { released += 1 }
  #expect(released == 1)
}

@MainActor @Test func holdsNoGestureOrFinishExplainsGoOnTheSecondTick() async {
  let holds = GestureHolds(), syncs = Syncs()
  var released = 0
  holds.sweep("S", holding: true, busy: false) { released += 1 }
  #expect(released == 0)
  holds.sweep("S", holding: true, busy: false) { released += 1 }
  #expect(released == 1)
  holds.sweep("S", holding: false, busy: false) { released += 1 }
  holds.sweep("S", holding: false, busy: false) { released += 1 }
  #expect(released == 1)

  let t = holds.finish("S", flush: {}, sync: { await syncs.sync() }, busy: { true }, release: {})
  await syncs.started(1)
  for _ in 0..<3 { holds.sweep("S", holding: true, busy: false) { released += 1 } }
  #expect(released == 1)
  syncs.end(0)
  await t.value
  holds.sweep("S", holding: true, busy: false) { released += 1 }
  holds.sweep("S", holding: true, busy: false) { released += 1 }
  #expect(released == 2)
}
