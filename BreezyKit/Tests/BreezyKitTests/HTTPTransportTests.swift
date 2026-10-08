import Foundation
import Testing
@testable import BreezyKit

/// Runs only from server/test.sh, which serves sync.php and sets BREEZY_URL.
@Suite(.enabled(if: ProcessInfo.processInfo.environment["BREEZY_URL"] != nil))
@MainActor struct HTTPTransportTests {
  @Test func syncsThroughTheServer() async {
    let url = ProcessInfo.processInfo.environment["BREEZY_URL"]!
    let a = Store()
    let invite = a.startSyncing(server: url)
    let id = a.createBoard(title: "Over HTTP", contents: board([card(newID(), 0, 0, "Hi")]))
    let ea = SyncEngine(store: a)
    await ea.sync()
    #expect(ea.status.state == .synced)
    let b = Store()
    b.join(invite)
    await SyncEngine(store: b).sync()
    #expect(b.title(of: id) == "Over HTTP")
    #expect(b.board(id) == a.board(id))
  }
}
