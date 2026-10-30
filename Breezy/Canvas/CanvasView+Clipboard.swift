import AppKit
import BreezyKit

/// ⌘C, ⌘X and ⌘V on the board, through the system pasteboard: the cards as plain text and as the web app's HTML.
extension CanvasView: NSMenuItemValidation {
  private var boardID: String? { (window?.windowController as? BoardWindowController)?.boardID }

  private func write(_ clip: Clip?) {
    guard let clip else { return }
    let pb = NSPasteboard.general
    pb.clearContents()
    pb.setString(clip.html, forType: .html)
    pb.setString(clip.text, forType: .string)
  }

  @objc func copy(_ sender: Any?) { boardID.map { write(core.copySelection(board: $0)) } }

  @objc func cut(_ sender: Any?) { boardID.map { write(core.cutSelection(board: $0)) } }

  /// The copies near the middle of the view, scrolled into sight.
  @objc func paste(_ sender: Any?) {
    guard let id = boardID else { return }
    guard let html = NSPasteboard.general.string(forType: .html), let clip = Clip(html: html) else {
      return core.flight.note(.decision, "paste source", ["from": .string("none")])
    }
    let had = Set(board.cards.map(\.id)), c = visibleWorldCentre
    core.paste(clip, board: id, centre: Point(x: Double(c.x), y: Double(c.y)))
    let r = board.cards.filter { !had.contains($0.id) }.reduce(NSRect.null) { $0.union(doc(drawnRect($1))) }
    if !r.isNull { scrollToVisible(r.insetBy(dx: -48, dy: -48)) }
  }

  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    switch item.action {
    case #selector(copy(_:)), #selector(cut(_:)): selection.contains { board.card($0) != nil }
    case #selector(paste(_:)): NSPasteboard.general.availableType(from: [.html]) != nil
    default: true
    }
  }
}
