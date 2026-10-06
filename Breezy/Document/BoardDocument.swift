import AppKit
import BreezyKit

/// A `.breezy` file. Every change goes through `model`, whose undo manager is the document's, so
/// the Edit menu, the edited dot and autosave follow it.
final class BoardDocument: NSDocument {
  let model = BoardModel()

  override init() {
    super.init()
    undoManager = model.undoManager
    // a drag or edit in progress has no undo step yet, but its change is unsaved; closing then
    // saves it as it stands rather than ending the edit, which would wait on the close's own save
    model.onPending = { [weak self] pending in self?.updateChangeCount(pending ? .changeDone : .changeUndone) }
  }

  override class var autosavesInPlace: Bool { true }

  override func makeWindowControllers() {
    addWindowController(BoardWindowController(model: model))
  }

  /// Saves an edit in progress as it would stand once finished, without ending it.
  override func data(ofType typeName: String) throws -> Data {
    var board = model.board
    for case let wc as BoardWindowController in windowControllers {
      if let id = wc.canvas.editing?.id { board.finishEdit(id) }
    }
    return try BoardFormat.encode(board)
  }

  override func read(from data: Data, ofType typeName: String) throws {
    model.replace(try BoardFormat.decode(data).recentred(within: Double(CanvasView.origin) - 2_000))
  }
}
