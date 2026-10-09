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

  @Test func aCombinedPushReturnsWhatTheOthersWroteAndASmallEditGoesInOneRequest() async throws {
    let url = ProcessInfo.processInfo.environment["BREEZY_URL"]!
    let a = Store()
    let invite = a.startSyncing(server: url)
    let id = a.createBoard(title: "Combined", contents: board([card(newID(), 0, 0, "Hi")]))
    let ea = SyncEngine(store: a)
    await ea.sync()
    let b = Store()
    b.join(invite)
    let eb = SyncEngine(store: b)
    await eb.sync()
    let other = b.createBoard(title: "From b")
    await eb.sync()
    a.apply(Records.changes(from: a.board(id), to: board(a.board(id).cards + [card(newID(), 0, 40, "More")]), board: id, orders: a.orders(of: id)))
    await ea.sync()
    #expect(ea.status.state == .synced)
    #expect(a.title(of: other) == "From b")
    #expect(a.state.cursor == b.state.cursor + 1)
    await eb.sync()
    #expect(b.board(id) == a.board(id))
    #expect(b.state.cursor == a.state.cursor)
  }

  @Test func aBigRequestGoesDeflatedThroughTheServer() async throws {
    let url = ProcessInfo.processInfo.environment["BREEZY_URL"]!
    let a = Store()
    let invite = a.startSyncing(server: url)
    let text = (0..<400).map { "word\($0) " }.joined()
    let id = a.createBoard(title: "Big", contents: board((0..<4).map { card(newID(), 0, Double($0) * 24, text) }))
    let ea = SyncEngine(store: a)
    await ea.sync()
    #expect(ea.status.state == .synced)
    let b = Store()
    b.join(invite)
    await SyncEngine(store: b).sync()
    #expect(b.board(id) == a.board(id))
    #expect(b.board(id).cards.allSatisfy { $0.text == text })
  }
}
