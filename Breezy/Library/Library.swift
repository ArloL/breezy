import AppKit
import BreezyKit

extension Notification.Name {
  static let boardsChanged = Notification.Name("BreezyBoardsChanged")
  static let syncStatusChanged = Notification.Name("BreezySyncStatusChanged")
}

/// The boards on this Mac: the store, its file and its sync engine, and the open board windows.
@MainActor final class Library {
  static var shared: Library!
  let store: Store
  let file: StoreFile
  let engine: SyncEngine
  private var timer: Timer?
  /// Boards whose windows are closing, so that the close's own flush can't close them again.
  private var closing: Set<String> = []

  init(directory: URL) throws {
    file = StoreFile(url: directory.appendingPathComponent("space.json"))
    store = Store(state: try file.load() ?? SpaceState())
    engine = SyncEngine(store: store)
    store.onDirty = { [weak self] in self?.scheduleSave() }
    store.onChange = { [weak self] boards, remote in self?.changed(boards, remote: remote) }
    file.onError = { NSApp.presentError($0) }
    engine.flushLocal = { [weak self] in self?.documents.forEach { $0.binding.flush() } }
    engine.onStatus = { _ in NotificationCenter.default.post(name: .syncStatusChanged, object: nil) }
    timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.poll() }
    }
    NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.syncNow() }
    }
  }

  var documents: [BoardDocument] { NSDocumentController.shared.documents.compactMap { $0 as? BoardDocument } }

  private func scheduleSave() { file.scheduleSave { [store] in store.state } }

  var statusLines: [String] { engine.status.lines() }

  func syncNow() { Task { await engine.sync() } }

  /// Every 5 s while a board or the Boards window shows.
  private func poll() {
    let shown = NSApp.windows.contains {
      ($0.windowController is BoardWindowController || $0.windowController is BoardsWindowController) && $0.occlusionState.contains(.visible)
    }
    if shown { syncNow() }
  }

  /// Ends edits and writes the store before quitting.
  func saveNow() {
    for d in documents {
      d.windowController?.canvas.endEditing()
      d.binding.flush()
    }
    file.save(store.state, wait: true)
  }

  func changed(_ boards: Set<String>, remote: Bool) {
    for d in documents where boards.contains(d.boardID) && !closing.contains(d.boardID) {
      if store.title(of: d.boardID) == nil {
        closing.insert(d.boardID)
        d.close()
        closing.remove(d.boardID)
        continue
      }
      if remote { d.binding.pull() }
      d.windowController?.synchronizeWindowTitleWithDocumentName()
    }
    if !remote { engine.changed() }
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
    syncNow()
    return doc.windowController
  }
}
