#if !canImport(Darwin)
import Testing
@testable import BreezyKit

/// The shim undoes as Foundation's UndoManager does without groupsByEvent, and nothing else: grouping by event would
/// have it undo otherwise, unseen, as BoardModel's mutant setting it true survived on Linux alone.
@Test func theLinuxUndoManagerRefusesGroupingByEvent() async {
  await #expect(processExitsWith: .failure) {
    UndoManager().groupsByEvent = true
  }
}
#endif
