import XCTest
@testable import BreezyReference

/// The owner's pinch in past 200 % (take-5's pinch-in-past-max-3), replayed into AppKit's scroll view as the reference
/// app's --zoom has it: it must end where the owner's did, from the same start.
@MainActor
final class RawReplayTests: XCTestCase {
  struct Fixture: Decodable {
    let raw: [[String]]
    let window: [Double]
    let start: [Double]
    /// The first pinch event's place in the view, as recorded.
    let pointer: [Double]
    /// The view as it came to rest: zoom, camX, camY.
    let end: [Double]
  }

  func testAPinchReplaysAboutWhereTheOwnersFingersWere() throws {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("pinch-in-past-max.json")
    let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1512, height: 949), styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    addTeardownBlock { window.close() }
    let scroll = NSScrollView()
    scroll.allowsMagnification = true
    scroll.minMagnification = 0.25
    scroll.maxMagnification = 2
    scroll.documentView = Reference.zoomBoard()
    window.contentView = scroll
    window.center()
    window.orderFrontRegardless()
    scroll.magnification = f.start[0]
    scroll.contentView.scroll(to: NSPoint(x: f.start[1], y: f.start[2]))
    scroll.reflectScrolledClipView(scroll.contentView)
    // where a replay left it, far from the pinch
    CGWarpMouseCursorPosition(CGPoint(x: 5, y: 5))

    var pointer: CGPoint?
    let handed = expectation(description: "handed")
    RawReplay.play(f.raw, recorded: f.window, into: window, observe: { e in
      guard e.type == .magnify, pointer == nil else { return }
      let clip = scroll.contentView, q = clip.convert(RawReplay.inWindow(e, of: window), from: nil), z = scroll.magnification
      pointer = CGPoint(x: (q.x - clip.bounds.minX) * z, y: (q.y - clip.bounds.minY) * z)
    }) { n in
      XCTAssertEqual(n, f.raw.count)
      handed.fulfill()
    }
    wait(for: [handed], timeout: 20)
    // AppKit springs back from past 200 % after the pinch's end
    RunLoop.main.run(until: Date().addingTimeInterval(1.5))

    let p = try XCTUnwrap(pointer)
    XCTAssertEqual(p.x, f.pointer[0], accuracy: 0.5)
    XCTAssertEqual(p.y, f.pointer[1], accuracy: 0.5)
    XCTAssertEqual(scroll.magnification, f.end[0], accuracy: 0.001)
    XCTAssertEqual(scroll.contentView.bounds.minX, f.end[1], accuracy: 1)
    XCTAssertEqual(scroll.contentView.bounds.minY, f.end[2], accuracy: 1)
  }
}
