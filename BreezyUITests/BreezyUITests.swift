import XCTest

final class BreezyUITests: XCTestCase {
  var app: XCUIApplication!

  override func setUp() { continueAfterFailure = false }
  override func tearDown() { app?.terminate() }

  /// Launches the app on a board written from `json` into a temporary file.
  @discardableResult
  func open(_ json: String) -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".breezy")
    try! json.write(to: url, atomically: true, encoding: .utf8)
    app = XCUIApplication()
    app.launchArguments = ["-ApplePersistenceIgnoreState", "YES", "-BreezyBoard", url.path]
    app.launch()
    XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 5))
    return url
  }

  func testOpensABoard() {
    let url = open(#"{"format": 1, "cards": [], "lanes": []}"#)
    XCTAssertTrue(app.windows.firstMatch.title.hasPrefix(url.deletingPathExtension().lastPathComponent))
  }

  func testDraggingACardIntoALaneStacksIt() {
    open(#"""
    {"format": 1,
     "lanes": [{"id": "l", "x": 0, "y": 0, "w": 480, "h": 720, "title": "Doing"}],
     "cards": [{"id": "a", "x": 720, "y": 0, "w": 240, "text": "Move me", "color": 1}]}
    """#)
    let lane = app.groups.matching(identifier: "lane").firstMatch
    let card = app.groups.matching(identifier: "card").firstMatch
    XCTAssertTrue(card.waitForExistence(timeout: 2))
    let scale = lane.frame.width / 480
    card.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
      .press(forDuration: 0.2, thenDragTo: lane.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.6)))
    XCTAssertEqual(card.frame.minY, lane.frame.minY + 72 * scale, accuracy: 2)
    XCTAssertTrue(lane.frame.contains(CGPoint(x: card.frame.midX, y: card.frame.midY)))
  }

  private var empty: String { #"{"format": 1, "cards": [], "lanes": []}"# }

  func testCreateTypeAndUndoACard() {
    open(empty)
    app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).doubleClick()
    app.typeText("Hello")
    app.typeKey(.escape, modifierFlags: [])
    let card = app.groups.matching(identifier: "card").firstMatch
    XCTAssertTrue(card.waitForExistence(timeout: 2))
    XCTAssertEqual(card.label, "Hello")
    app.typeKey("z", modifierFlags: .command)
    XCTAssertEqual(app.groups.matching(identifier: "card").count, 0)
  }

  func testClosingWhileEditingKeepsText() throws {
    let url = open(empty)
    app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).doubleClick()
    app.typeText("Kept")
    app.typeKey("w", modifierFlags: .command)
    XCTAssertTrue(app.windows.firstMatch.waitForNonExistence(timeout: 5))
    XCTAssertTrue(try String(contentsOf: url, encoding: .utf8).contains(#""text" : "Kept""#))
  }

  func testFindTurnsACardToAMatchOnItsBack() {
    open(#"""
    {"format": 1, "lanes": [],
     "cards": [{"id": "a", "x": 0, "y": 0, "w": 240, "text": "Front", "notes": "a needle here", "color": 1}]}
    """#)
    app.typeKey("f", modifierFlags: .command)
    app.typeText("needle")
    app.typeKey(.return, modifierFlags: [])
    let card = app.groups.matching(identifier: "card").firstMatch
    expectation(for: NSPredicate(format: "value == 'back'"), evaluatedWith: card)
    waitForExpectations(timeout: 3)
  }
}
