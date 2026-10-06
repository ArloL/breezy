import AppKit
import BreezyKit

/// A `.breezy` file. Every change goes through `model`, whose undo manager is the document's, so
/// the Edit menu, the edited dot and autosave follow it.
final class BoardDocument: NSDocument {
  let model = BoardModel()

  override init() {
    super.init()
    undoManager = model.undoManager
  }

  override class var autosavesInPlace: Bool { true }

  override func makeWindowControllers() {
    addWindowController(BoardWindowController(model: model))
  }

  override func data(ofType typeName: String) throws -> Data {
    try BoardFormat.encode(model.board)
  }

  override func read(from data: Data, ofType typeName: String) throws {
    model.replace(try BoardFormat.decode(data).recentred(within: Double(CanvasView.origin) - 2_000))
  }
}
