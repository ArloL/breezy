import AppKit
import BreezyKit

/// One board's window and undo, without a file: the board lives in the library's store. AppKit's
/// documents still give the window its undo manager and title.
final class BoardDocument: NSDocument {
  let boardID: String
  let model: BoardModel
  let binding: BoardBinding
  /// Its space's Collab session, while open.
  var session: Collab.Session?

  init(boardID: String, store: Store) {
    self.boardID = boardID
    // stacked as this Mac measures text; the store keeps the positions as they came
    var b = store.board(boardID)
    let heights = Dictionary(uniqueKeysWithValues: b.cards.map { ($0.id, Double(TextMetrics.frontHeight($0.text, width: CGFloat($0.w)))) })
    b.gravity { heights[$0] ?? 2 * Metrics.grid }
    model = BoardModel(board: b)
    binding = BoardBinding(id: boardID, model: model, store: store)
    super.init()
    undoManager = model.undoManager
  }

  var windowController: BoardWindowController? { windowControllers.first as? BoardWindowController }

  override func makeWindowControllers() {
    let wc = BoardWindowController(model: model, boardID: boardID)
    addWindowController(wc)
    binding.restack = { [weak wc] b in wc?.canvas.restack(&b) }
    wc.window?.identifier = NSUserInterfaceItemIdentifier("board")
    wc.window?.restorationClass = BoardRestorer.self
  }

  override var displayName: String! {
    get {
      MainActor.assumeIsolated {
        guard let g = Library.shared.spaces.group(of: boardID), let title = g.store.title(of: boardID) else { return "Board" }
        return g.space == nil ? title : "\(title) — \(g.name)"
      }
    }
    set {}
  }

  // the store saves; a document never counts as edited, so closing never asks
  override func updateChangeCount(_ change: NSDocument.ChangeType) {}
  override var isDocumentEdited: Bool { false }

  /// A closing window leaves the document before `close()`, so its edit ends here.
  override func removeWindowController(_ windowController: NSWindowController) {
    (windowController as? BoardWindowController)?.canvas.endEditing()
    (windowController as? BoardWindowController)?.canvas.stopPresence()
    super.removeWindowController(windowController)
  }

  override func close() {
    windowController?.canvas.endEditing()
    binding.flush()
    session?.close()
    super.close()
  }
}

/// Brings back the board windows open at quit; a window's state holds its board's id.
final class BoardRestorer: NSObject, NSWindowRestoration {
  static func restoreWindow(
    withIdentifier identifier: NSUserInterfaceItemIdentifier, state: NSCoder, completionHandler: @escaping (NSWindow?, Error?) -> Void
  ) {
    let window = MainActor.assumeIsolated {
      (state.decodeObject(of: NSString.self, forKey: "board") as String?).flatMap { Library.shared.open($0, display: false)?.window }
    }
    completionHandler(window, window == nil ? CocoaError(.fileNoSuchFile) : nil)
  }
}
