import XCTest
@testable import BreezyReference

/// --zoom's board as a pinch out steps it: a drawn board redrew the whole view at its own scale each step, ~90 Mpx at
/// 25 %, and starved a live pinch to a frame each 30–60 ms.
@MainActor
final class ZoomBoardTests: XCTestCase {
  func scrolled(_ board: NSView) -> (NSWindow, NSScrollView) {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1512, height: 949), styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    let scroll = NSScrollView()
    scroll.allowsMagnification = true
    scroll.minMagnification = 0.25
    scroll.maxMagnification = 2
    scroll.documentView = board
    window.contentView = scroll
    window.orderFrontRegardless()
    addTeardownBlock { window.close() }
    return (window, scroll)
  }

  func contents(_ l: CALayer) -> Int { (l.contents == nil ? 0 : 1) + (l.sublayers ?? []).map(contents).reduce(0, +) }

  func testThePinchedBoardDrawsNothingAsItStepsOut() throws {
    let board = Reference.zoomBoard()
    let (window, scroll) = scrolled(board)
    for z in stride(from: 1.0, through: 0.25, by: -0.05) {
      scroll.magnification = z
      window.display()
      CATransaction.flush()
    }
    XCTAssertEqual(contents(try XCTUnwrap(board.layer)), 0, "the board drew into layers")
  }

  func testDotsCoverTheBoardOnlyAndHideBelow40Percent() throws {
    let (window, scroll) = scrolled(Reference.zoomBoard())
    let grid = ZoomGrid(frame: .zero)
    scroll.addSubview(grid, positioned: .above, relativeTo: scroll.contentView)
    scroll.magnification = 0.5
    scroll.contentView.scroll(to: NSPoint(x: -400, y: -200))
    grid.update(scroll)
    XCTAssertEqual(grid.frame.minX, 200, accuracy: 0.01)
    XCTAssertEqual(grid.frame.minY, 100, accuracy: 0.01)
    let rows = try XCTUnwrap(grid.layer?.sublayers?.first)
    XCTAssertFalse(rows.isHidden)
    scroll.magnification = 0.3
    grid.update(scroll)
    XCTAssertTrue(rows.isHidden)
    _ = window
  }
}
