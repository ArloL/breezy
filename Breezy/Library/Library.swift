import AppKit
import BreezyKit

extension Notification.Name {
  static let boardsChanged = Notification.Name("BreezyBoardsChanged")
  static let syncStatusChanged = Notification.Name("BreezySyncStatusChanged")
}

/// The boards on this Mac: their groups, each with its file and sync engine, and the open board windows.
@MainActor final class Library {
  static var shared: Library!
  let spaces: Spaces
  private var timer: Timer?
  /// Boards whose windows are closing, so that the close's own flush can't close them again.
  private var closing: Set<String> = []

  init(directory: URL) throws {
    spaces = try Spaces(directory: directory)
    spaces.onChange = { [weak self] group, boards, remote in self?.changed(group, boards, remote: remote) }
    spaces.onStatus = { _ in NotificationCenter.default.post(name: .syncStatusChanged, object: nil) }
    spaces.onError = { NSApp.presentError($0) }
    spaces.flushLocal = { [weak self] in self?.documents.forEach { $0.binding.flush() } }
    timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.poll() }
    }
    NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.syncNow() }
    }
  }

  var documents: [BoardDocument] { NSDocumentController.shared.documents.compactMap { $0 as? BoardDocument } }

  /// Each space's status, prefixed by its name, for the Breezy menu.
  var statusLines: [String] {
    spaces.groups.filter { $0.space != nil }.flatMap { g in g.engine.status.lines().map { "\(g.name) — \($0)" } }
  }

  /// The group of the key board window, else of the Boards window's selection, else On this device.
  var currentGroup: Spaces.Group {
    if let d = NSApp.keyWindow?.windowController?.document as? BoardDocument, let g = spaces.group(of: d.boardID) { return g }
    return BoardsWindowController.shared.selectedGroup ?? spaces.local
  }

  func syncNow() { spaces.syncAll() }

  /// Every 5 s while a board or the Boards window shows.
  private func poll() {
    let shown = NSApp.windows.contains {
      ($0.windowController is BoardWindowController || $0.windowController is BoardsWindowController) && $0.occlusionState.contains(.visible)
    }
    if shown { syncNow() }
  }

  /// Ends edits and writes every group before quitting.
  func saveNow() {
    for d in documents {
      d.windowController?.canvas.endEditing()
      d.binding.flush()
    }
    spaces.saveNow()
  }

  /// A change in `group`: its boards' windows follow, and all its windows retitle when its name changed.
  func changed(_ group: Spaces.Group, _ boards: Set<String>, remote: Bool) {
    let renamed = group.space.map { boards.contains($0) } ?? false
    for d in documents where !closing.contains(d.boardID) {
      let mine = boards.contains(d.boardID)
      guard mine || (renamed && group.store.title(of: d.boardID) != nil) else { continue }
      if mine {
        if group.store.title(of: d.boardID) == nil {
          closing.insert(d.boardID)
          d.close()
          closing.remove(d.boardID)
          continue
        }
        if remote { d.binding.pull() }
      }
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
      guard let group = spaces.group(of: id) else { return nil }
      doc = BoardDocument(boardID: id, store: group.store)
      NSDocumentController.shared.addDocument(doc)
      doc.makeWindowControllers()
    }
    if display { doc.showWindows() }
    syncNow()
    return doc.windowController
  }

  /// Moves board `id` to `target`; its window, if open, closes with the original and opens on the copy.
  func move(_ id: String, to target: Spaces.Group) {
    let doc = documents.first { $0.boardID == id }
    doc?.windowController?.canvas.endEditing()
    doc?.binding.flush()
    guard let new = spaces.move(id, to: target) else { return }
    if doc != nil { open(new) }
  }

  /// Closes `group`'s boards and forgets its space on this Mac.
  func leave(_ group: Spaces.Group) {
    for d in documents where group.store.title(of: d.boardID) != nil { d.close() }
    spaces.leave(group)
    NotificationCenter.default.post(name: .boardsChanged, object: nil)
  }
}
