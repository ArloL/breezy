import XCTest
@testable import BreezyReference

final class StrokeRecorderTests: XCTestCase {
  func recorder() -> StrokeRecorder {
    StrokeRecorder(name: "push", stage: CGSize(width: 1200, height: 762), start: CGPoint(x: 0, y: 813))
  }

  func testTimesFromFirstEvent() {
    var r = recorder()
    r.event(t: 10.000, dx: 1, dy: 0, phase: 1, momentum: 0)
    r.event(t: 10.008, dx: 2, dy: 0, phase: 4, momentum: 0)
    let s = finish(&r, from: 10.008)
    XCTAssertEqual(s.events.map { $0[0] }, [0, 8])
    XCTAssertEqual(s.events[1], [8, 2, 0, 4, 0])
  }

  func testFramesBeforeFirstEventDropped() {
    var r = recorder()
    _ = r.frame(t: 9.9, origin: CGPoint(x: 5, y: 5))
    r.event(t: 10, dx: 1, dy: 0, phase: 1, momentum: 0)
    let s = finish(&r, from: 10)
    XCTAssertFalse(s.frames.contains { $0[0] < 0 })
  }

  func testEndsAfterRestAndStillOrigin() {
    var r = recorder()
    r.event(t: 10, dx: 1, dy: 0, phase: 1, momentum: 0)
    for ms in stride(from: 0.0, through: 1499, by: 8) { XCTAssertNil(r.frame(t: 10 + ms / 1000, origin: .zero), "open at \(ms) ms") }
    var s: Stroke?
    for ms in stride(from: 1500.0, through: 1700, by: 8) where s == nil { s = r.frame(t: 10 + ms / 1000, origin: .zero) }
    XCTAssertNotNil(s)
    XCTAssertEqual(s?.name, "push")
    XCTAssertEqual(s?.stage, [1200, 762])
    XCTAssertEqual(s?.start, [0, 813])
  }

  func testMomentumOnlyStrokeEnds() {
    var r = recorder()
    r.event(t: 10, dx: 9, dy: 0, phase: 0, momentum: 1)
    r.event(t: 10.008, dx: 6, dy: 0, phase: 0, momentum: 4)
    r.event(t: 10.016, dx: 0, dy: 0, phase: 0, momentum: 8)
    XCTAssertEqual(finish(&r, from: 10.016).events.count, 3)
  }

  func testOriginStillMovingKeepsStrokeOpen() {
    var r = recorder()
    r.event(t: 10, dx: 1, dy: 0, phase: 1, momentum: 0)
    for ms in stride(from: 0.0, through: 1700, by: 8) {
      XCTAssertNil(r.frame(t: 10 + ms / 1000, origin: CGPoint(x: -ms / 100, y: 0)), "a rebound under way at \(ms) ms")
    }
  }

  /// Feeds still frames from `from` until the stroke ends, failing after 3 s.
  func finish(_ r: inout StrokeRecorder, from: Double) -> Stroke {
    for ms in stride(from: 0.0, through: 3000, by: 8) {
      if let s = r.frame(t: from + ms / 1000, origin: .zero) { return s }
    }
    XCTFail("never ended")
    return Stroke(name: "", stage: [], start: [], events: [], frames: [])
  }
}
