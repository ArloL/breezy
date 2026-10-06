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
}
