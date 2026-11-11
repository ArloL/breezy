import XCTest
@testable import BreezyReference

final class FrameWriterTests: XCTestCase {
  let shown = FrameWriter.Shown(zoom: 1, cam: CGPoint(x: 100, y: 200), view: CGSize(width: 1200, height: 800),
                                board: CGRect(x: 0, y: 0, width: 40032, height: 40032), knobH: 0.03, knobV: 0.02)
  func at(_ zoom: Double) -> FrameWriter.Shown { var s = shown; s.zoom = zoom; return s }
  func col(_ s: FrameWriter.Stroke, _ f: String) -> [Double?] { s.frames.rows.map { $0[FrameWriter.fields.firstIndex(of: f)!] } }

  func pinch(_ w: inout FrameWriter) {
    w.magnify(t: 10, by: -0.01, phase: .began, at: CGPoint(x: 600, y: 400), raw: Data([1]))
    _ = w.frame(t: 10.008, shown: at(0.99))
    w.magnify(t: 10.016, by: -0.1, phase: .changed, at: CGPoint(x: 600, y: 400), raw: Data([2]))
    _ = w.frame(t: 10.017, shown: at(0.9))
    w.magnify(t: 10.03, by: 0, phase: .ended, at: CGPoint(x: 600, y: 400), raw: Data([3]))
    _ = w.frame(t: 10.033, shown: at(0.9))
  }

  func testPinchFramesCarryZoomAndKnobs() throws {
    var w = FrameWriter(name: "pinch")
    pinch(&w)
    var s: FrameWriter.Stroke?
    var t = 10.05
    while s == nil, t < 13 { s = w.frame(t: t, shown: at(0.9)); t += 0.0166 }
    let stroke = try XCTUnwrap(s)
    XCTAssertEqual(col(stroke, "zoom").prefix(3), [0.99, 0.9, 0.9])
    XCTAssertEqual(col(stroke, "magnify").prefix(3), [-0.01, -0.1, 0])
    XCTAssertEqual(col(stroke, "gesture").prefix(4), [1, 2, 3, 0])
    XCTAssertEqual(col(stroke, "knobH")[0], 0.03)
    XCTAssertEqual(col(stroke, "t")[0], 8)
    XCTAssertEqual(col(stroke, "px")[0], 600)
    XCTAssertEqual(stroke.raw.map { $0[1] }, [Data([1]), Data([2]), Data([3])].map { $0.base64EncodedString() })
  }

  func testEndsOnlyOnceStillAndRested() {
    var w = FrameWriter(name: "pinch")
    pinch(&w)
    XCTAssertNil(w.frame(t: 11.0, shown: at(0.9)))
    XCTAssertNil(w.frame(t: 11.4, shown: at(0.9)))
    XCTAssertNotNil(w.frame(t: 11.6, shown: at(0.9)))
  }

  func testFieldsMatchTheChecker() throws {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../scripts/frames/fields.json").standardized
    let listed = try JSONDecoder().decode([String: [String]].self, from: Data(contentsOf: url))
    XCTAssertEqual(FrameWriter.fields, listed["common"]! + listed["mac"]!)
  }
}
