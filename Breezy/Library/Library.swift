import AppKit
import BreezyKit

extension Notification.Name {
  static let boardsChanged = Notification.Name("BreezyBoardsChanged")
  static let peopleChanged = Notification.Name("BreezyPeopleChanged")
  static let syncStatusChanged = Notification.Name("BreezySyncStatusChanged")
}

/// The boards on this Mac: their groups, each with its file and sync engine, and the open board windows.
@MainActor final class Library {
  static var shared: Library!
  let spaces: Spaces
  private var timer: Timer?
  private var liveTimer: Timer?
  private var peopleSeen = ""
  /// Boards whose windows are closing, so that the close's own flush can't close them again.
  private var closing: Set<String> = []

  init(directory: URL) throws {
    spaces = try Spaces(directory: directory, me: Self.me())
    spaces.onChange = { [weak self] group, boards, remote in self?.changed(group, boards, remote: remote) }
    spaces.onStatus = { _ in NotificationCenter.default.post(name: .syncStatusChanged, object: nil) }
    spaces.onError = { NSApp.presentError($0) }
    spaces.flushLocal = { [weak self] in self?.documents.forEach { $0.binding.flush() } }
    spaces.onLive = { [weak self] g in self?.liveChanged(g) }
    liveTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        for g in self.spaces.spaces { g.live?.tick() }
        self.updateLive()
      }
    }
    for name in [NSWindow.didBecomeKeyNotification, NSWindow.didChangeOcclusionStateNotification] {
      NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.updateLive() }
      }
    }
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
    if shown { spaces.syncAll(polling: true) }
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
      wire(doc)
    }
    if let g = spaces.group(of: id) { liveChanged(g) }
    if display { doc.showWindows() }
    syncNow()
    return doc.windowController
  }

  /// This Mac as others see it: an id made once, and the macOS account's name until it is changed.
  static func me() -> Person {
    let d = UserDefaults.standard
    let device = d.string(forKey: "BreezyDevice").flatMap { Base64URL.decode($0)?.count == 16 ? $0 : nil } ?? newID()
    d.set(device, forKey: "BreezyDevice")
    return Person(device: device, name: d.string(forKey: "BreezyName") ?? NSFullUserName())
  }

  func setName(_ name: String) {
    UserDefaults.standard.set(name, forKey: "BreezyName")
    spaces.me = Person(device: spaces.me.device, name: name)
  }

  /// Hooks board `doc`'s window to its space's live layer, looked up each time, as the layer may come and go.
  private func wire(_ doc: BoardDocument) {
    let id = doc.boardID
    guard let canvas = doc.windowController?.canvas else { return }
    canvas.onPointer = { [weak self] p in
      self?.spaces.group(of: id)?.live?.sendCursor(board: id, x: p.map { Double($0.x) }, y: p.map { Double($0.y) })
    }
    canvas.onSelection = { [weak self] in self?.updateLive() }
  }

  /// Connects each space's live layer while one of its boards or the Boards window shows, and says which board is in front.
  func updateLive() {
    let visible = NSApp.isHidden ? [] : NSApp.windows.filter { $0.occlusionState.contains(.visible) }
    let listShown = visible.contains { $0.windowController is BoardsWindowController }
    let shown = visible.compactMap { ($0.windowController?.document as? BoardDocument)?.boardID }
    let key = (NSApp.keyWindow?.windowController?.document as? BoardDocument)?.boardID
    for g in spaces.spaces {
      guard let live = g.live else { continue }
      if listShown || shown.contains(where: { g.store.title(of: $0) != nil }) { live.connect() } else { live.close() }
      let board = key.flatMap { g.store.title(of: $0) != nil ? $0 : nil }
      let selection = board.flatMap { b in documents.first { $0.boardID == b }?.windowController?.canvas.selection }
      live.setPresence(board: board, selection: selection.map { $0.sorted() } ?? [])
    }
  }

  /// Something changed in `g`'s live layer: its board windows and the Boards window follow.
  func liveChanged(_ g: Spaces.Group) {
    updateLive()
    for d in documents where g.store.title(of: d.boardID) != nil {
      d.windowController?.canvas.presence = CanvasPresence(g.live, board: d.boardID)
      d.windowController?.showPeople(g.live?.people(on: d.boardID) ?? [])
    }
    // the list reloads only when who is on which board changes, not with every cursor
    let seen = spaces.spaces.flatMap { g in g.store.boards.map { b in b.id + ":" + (g.live?.people(on: b.id) ?? []).map(\.device).joined(separator: ",") } }
      .joined(separator: ";")
    if seen != peopleSeen {
      peopleSeen = seen
      NotificationCenter.default.post(name: .peopleChanged, object: nil)
    }
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
