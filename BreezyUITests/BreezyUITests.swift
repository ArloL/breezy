import XCTest

final class BreezyUITests: XCTestCase {
  var app: XCUIApplication!

  override func setUp() { continueAfterFailure = false }
  override func tearDown() { app?.terminate() }

  /// Launches the app on a board written from `json` into a temporary file, with a store in a
  /// temporary folder, and `arguments`; returns the board file and the store's file.
  @discardableResult
  func open(_ json: String, _ arguments: [String] = []) -> (board: URL, store: URL) {
    let tmp = FileManager.default.temporaryDirectory
    let url = tmp.appendingPathComponent(UUID().uuidString + ".breezy")
    let store = tmp.appendingPathComponent(UUID().uuidString)
    try! json.write(to: url, atomically: true, encoding: .utf8)
    app = XCUIApplication()
    app.launchArguments = ["-ApplePersistenceIgnoreState", "YES", "-BreezyBoard", url.path, "-BreezyStore", store.path] + arguments
    app.launch()
    XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 5))
    return (url, store.appendingPathComponent("Spaces/local.json"))
  }

  func testOpensABoard() {
    let url = open(#"{"format": 1, "cards": [], "lanes": []}"#).board
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
      .click(forDuration: 0.2, thenDragTo: lane.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.6)))
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
    let store = open(empty).store
    app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).doubleClick()
    app.typeText("Kept")
    app.typeKey("w", modifierFlags: .command)
    XCTAssertTrue(app.windows.firstMatch.waitForNonExistence(timeout: 5))
    let deadline = Date().addingTimeInterval(5)
    var text = ""
    while Date() < deadline {
      text = (try? String(contentsOf: store, encoding: .utf8)) ?? ""
      if text.contains(#""text":"Kept""#) { break }
      Thread.sleep(forTimeInterval: 0.2)
    }
    XCTAssertTrue(text.contains(#""text":"Kept""#))
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

  /// The app's own check of the board's edge, which reads what its views hold: the scroll view's document is the board,
  /// 1,194 pt round the cards and lanes and what showed at rest; its edge shows only while a trackpad pulls past it;
  /// grown at the left and top, by a card or a zoom, and shrunk back, nothing on screen moves.
  func testTheBoardIsBoundedAndHoldsStillAsItGrows() throws {
    let out = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".txt")
    open(#"""
    {"format": 1,
     "lanes": [{"id": "l", "x": 480, "y": 0, "w": 288, "h": 720, "title": "Doing"}],
     "cards": [{"id": "a", "x": 0, "y": 0, "w": 240, "text": "Near", "color": 1}]}
    """#, ["-BreezySelfTest", "bounded-board", "-BreezySelfTestOut", out.path])
    XCTAssertTrue(app.wait(for: .notRunning, timeout: 90))
    XCTAssertEqual(try String(contentsOf: out, encoding: .utf8), "PASS bounded-board")
  }

  /// The knobs measure the board its cards make, not the document, so dragging one and clicking a track scroll over that
  /// board: the knob dragged to the right end shows the board's right edge, and a click in the track left of it pages back.
  func testTheScrollersScrollTheBoard() {
    open(#"""
    {"format": 1, "lanes": [],
     "cards": [{"id": "a", "x": 0, "y": 0, "w": 240, "text": "Left", "color": 1},
               {"id": "b", "x": 2400, "y": 0, "w": 240, "text": "Right", "color": 2}]}
    """#, ["-AppleShowScrollBars", "Always"])
    XCTAssertTrue(app.scrollBars.firstMatch.waitForExistence(timeout: 2))
    let bar = app.scrollBars.allElementsBoundByIndex.first { $0.frame.width > $0.frame.height }!
    func value() -> Double { (bar.value as? NSNumber)?.doubleValue ?? Double(bar.value as? String ?? "") ?? -1 }
    let right = app.groups.matching(identifier: "card").matching(NSPredicate(format: "label == 'Right'")).firstMatch
    let before = right.frame.minX
    // the track's point at the knob's value is on the knob, however long the knob
    bar.coordinate(withNormalizedOffset: CGVector(dx: value(), dy: 0.5))
      .click(forDuration: 0.1, thenDragTo: bar.coordinate(withNormalizedOffset: CGVector(dx: 1.2, dy: 0.5)))
    let dragged = right.frame.minX
    XCTAssertLessThan(dragged, before - 100, "the knob dragged right moved the card from \(before) to \(dragged)")
    XCTAssertEqual(value(), 1, accuracy: 0.02)
    bar.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.5)).click()
    XCTAssertGreaterThan(right.frame.minX, dragged + 100, "a click in the track left of the knob left the card at \(right.frame.minX)")
  }
}
