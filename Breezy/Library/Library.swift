import AppKit
import BreezyKit

extension Notification.Name {
  static let boardsChanged = Notification.Name("BreezyBoardsChanged")
}

/// The boards on this Mac: the store and its file, and the open board windows.
@MainActor final class Library {
  static var shared: Library!
  let store: Store
  let file: StoreFile

  init(directory: URL) throws {
    file = StoreFile(url: directory.appendingPathComponent("space.json"))
    store = Store(state: try file.load() ?? SpaceState())
    store.onDirty = { [weak self] in self?.scheduleSave() }
    store.onChange = { [weak self] boards, remote in self?.changed(boards, remote: remote) }
    file.onError = { NSApp.presentError($0) }
  }

  var documents: [BoardDocument] { NSDocumentController.shared.documents.compactMap { $0 as? BoardDocument } }

  private func scheduleSave() { file.scheduleSave { [store] in store.state } }

  /// Ends edits and writes the store before quitting.
  func saveNow() {
    for d in documents {
      d.windowController?.canvas.endEditing()
      d.binding.flush()
    }
    file.save(store.state, wait: true)
  }

  func changed(_ boards: Set<String>, remote: Bool) {
    for d in documents where boards.contains(d.boardID) {
      if store.title(of: d.boardID) == nil {
        d.close()
        continue
      }
      if remote { d.binding.pull() }
      d.windowController?.synchronizeWindowTitleWithDocumentName()
    }
    NotificationCenter.default.post(name: .boardsChanged, object: nil)
  }

  /// Board `id`'s window, made if need be; nil when there is no such board.
  @discardableResult
  func open(_ id: String, display: Bool = true) -> BoardWindowController? {
    let doc: BoardDocument
    if let open = documents.first(where: { $0.boardID == id }) {
      doc = open
    } else {
      guard store.title(of: id) != nil else { return nil }
      doc = BoardDocument(boardID: id, store: store)
      NSDocumentController.shared.addDocument(doc)
      doc.makeWindowControllers()
    }
    if display { doc.showWindows() }
    return doc.windowController
  }
}
