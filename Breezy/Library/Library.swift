import AppKit
import BreezyKit
import Network

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
  private let path = NWPathMonitor()
  private var pathSeen = false
  private var liveTimer: Timer?
  private var peopleSeen = ""
  /// Boards whose windows are closing, so that the close's own flush can't close them again.
  private var closing: Set<String> = []
  /// When what gestures hold is let go.
  private let holds = GestureHolds()

  init(directory: URL) throws {
    spaces = try Spaces(directory: directory, me: Self.me(), peerTransport: { WebPeerTransport() })
    spaces.onChange = { [weak self] group, boards, remote in self?.changed(group, boards, remote: remote) }
    spaces.onStatus = { _ in NotificationCenter.default.post(name: .syncStatusChanged, object: nil) }
    spaces.onError = { NSApp.presentError($0) }
    spaces.flushLocal = { [weak self] in self?.documents.forEach { $0.binding.flush() } }
    spaces.onLive = { [weak self] g in self?.liveChanged(g) }
    spaces.onRefused = { [weak self] g, ids in
      for d in self?.documents ?? [] where g.store.title(of: d.boardID) != nil { d.windowController?.canvas.refused(ids) }
    }
    liveTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        for g in self.spaces.spaces {
          guard let live = g.live, let space = g.space else { continue }
          live.tick()
          self.holds.sweep(space, holding: !live.mine.isEmpty, busy: self.inGesture(g), release: live.release)
        }
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
      MainActor.assumeIsolated { self?.spaces.retryAll() }
    }
    NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.spaces.retryAll(changed: true) }
    }
    // a network that comes back or changes leaves sockets and requests on the old one dead, often without a word
    path.pathUpdateHandler = { [weak self] p in
      let up = p.status == .satisfied
      MainActor.assumeIsolated {
        guard let self else { return }
        // the first says how the network is at the start
        if self.pathSeen && up { self.spaces.retryAll(changed: true) }
        self.pathSeen = true
      }
    }
    path.start(queue: .main)
  }

  var documents: [BoardDocument] { NSDocumentController.shared.documents.compactMap { $0 as? BoardDocument } }

  /// Each space's status, prefixed by its name, for the Breezy menu.
  var statusLines: [String] {
    spaces.groups.filter { $0.space != nil }.flatMap { g in (g.engine.status.lines() + [g.live?.directStatus].compactMap { $0 }).map { "\(g.name) — \($0)" } }
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
    canvas.presenceNow = { [weak self] in
      guard let live = self?.spaces.group(of: id)?.live else { return nil }
      return (CanvasPresence(live, board: id), live.animating(on: id))
    }
    canvas.hold = { [weak self, weak doc] ids in
      self?.spaces.group(of: id)?.live?.hold(ids)
      // what the gesture did before it held, such as making the card it edits, shows now rather than at its next change
      doc?.binding.afterEdit?()
    }
    doc.binding.taken = { [weak self] in self?.spaces.group(of: id)?.live?.taken ?? [] }
    // others follow a held gesture live, and see its intermediate states pushed as changes they restack around
    if let g = spaces.group(of: id) {
      g.engine.holdBack = { [weak self, weak g] in
        guard let self, let g else { return false }
        return inGesture(g) && g.live?.mine.isEmpty == false
      }
    }
    doc.binding.afterEdit = { [weak self, weak doc] in
      guard let self, let doc, let g = spaces.group(of: id) else { return }
      // an edit outside a gesture, such as a recolour, goes out at once rather than with a later cycle, and shows on
      // others' screens ahead of its push
      let before = doc.binding.seen
      if !doc.model.inGesture, g.space != nil, doc.binding.flush() {
        Task { await g.engine.sync() }
        let b = doc.model.board
        g.live?.sendEdit(board: id, items: Records.liveFields(from: before, to: b, ids: Set(b.cards.map(\.id) + b.lanes.map(\.id)), board: id))
      }
      guard let live = g.live, !live.mine.isEmpty, let start = doc.model.gestureStartBoard else { return }
      live.sendLive(board: id, items: Records.liveFields(from: start, to: doc.model.board, ids: live.mine, board: id),
                    caret: doc.windowController?.canvas.caret(), starts: Records.startPositions(start, ids: live.mine))
    }
    // at a gesture's end, even when its window closed meanwhile: push at once, then let go
    doc.binding.afterGesture = { [weak self, weak binding = doc.binding] in
      guard let self, let binding, let g = spaces.group(of: id), let space = g.space, let live = g.live, !live.mine.isEmpty else { return }
      holds.finish(
        space, flush: { binding.flush() }, sync: { await g.engine.sync() }, busy: { [weak self] in self?.inGesture(g) ?? false },
        release: { [weak g] in g?.live?.release() })
    }
  }

  /// Whether a board of `g` is in a gesture.
  private func inGesture(_ g: Spaces.Group) -> Bool {
    documents.contains { g.store.title(of: $0.boardID) != nil && $0.model.inGesture }
  }

  /// Connects each space's live layer while one of its boards or the Boards window shows, and says which board is in front
  /// and which show.
  func updateLive() {
    let visible = NSApp.isHidden ? [] : NSApp.windows.filter { $0.occlusionState.contains(.visible) }
    let listShown = visible.contains { $0.windowController is BoardsWindowController }
    let shown = visible.compactMap { ($0.windowController?.document as? BoardDocument)?.boardID }
    let key = (NSApp.keyWindow?.windowController?.document as? BoardDocument)?.boardID
    for g in spaces.spaces {
      guard let live = g.live else { continue }
      if listShown || shown.contains(where: { g.store.title(of: $0) != nil }) { live.connect() } else { live.close() }
      let board = key.flatMap { g.store.title(of: $0) != nil ? $0 : nil }
      let others = shown.filter { $0 != board && g.store.title(of: $0) != nil }
      let selection = board.flatMap { b in documents.first { $0.boardID == b }?.windowController?.canvas.selection }
      live.setPresence(board: board, boards: (board.map { [$0] } ?? []) + others, selection: selection.map { $0.sorted() } ?? [])
    }
  }

  /// Something changed in `g`'s live layer: its board windows and the Boards window follow.
  func liveChanged(_ g: Spaces.Group) {
    updateLive()
    for d in documents where g.store.title(of: d.boardID) != nil {
      guard let canvas = d.windowController?.canvas else { continue }
      // while the display link runs, it shows the presence each frame
      if !canvas.animatingPresence { canvas.presence = CanvasPresence(g.live, board: d.boardID) }
      if g.live?.animating(on: d.boardID) == true { canvas.animatePresence() }
      d.windowController?.showPeople(g.live?.people(on: d.boardID) ?? [])
    }
    // the list follows only when who is on which board changes, not with every cursor
    let seen = spaces.spaces.flatMap { g in
      (g.live.map { Array($0.peers.values) } ?? []).compactMap { p in p.person.map { "\(p.board ?? "") \($0.device) \($0.name)" } }
    }.sorted().joined(separator: "\n")
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
