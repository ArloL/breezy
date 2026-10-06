import AppKit
import BreezyKit

extension CanvasView {
  override func keyDown(with event: NSEvent) {
    let mods = event.modifierFlags.intersection([.command, .option, .control, .shift])
    // by key position, as ⇧0 types "=" on some layouts
    if event.keyCode == 29 && mods == .shift {
      _ = tryToPerform(#selector(BoardWindowController.actualSize(_:)), with: self)
      return
    }
    guard mods.subtracting(.shift).isEmpty else { return super.keyDown(with: event) }
    let chars = event.charactersIgnoringModifiers ?? ""
    switch (event.keyCode, chars) {
    case (49, _): turnCard()
    case (53, _): if turned != nil { turn(nil) } else { selection = [] }
    case (51, _), (117, _): deleteSelection()
    case (_, "1"), (_, "2"), (_, "3"), (_, "4"), (_, "5"): setColor(Int(chars)!)
    case (_, "l"), (_, "L"):
      let m = convert(window!.mouseLocationOutsideOfEventStream, from: nil)
      addLane(at: NSPoint(x: m.x - Self.origin, y: m.y - Self.origin))
    default: super.keyDown(with: event)
    }
  }

  @objc func delete(_ sender: Any?) { deleteSelection() }

  override func selectAll(_ sender: Any?) { selection = Set(board.cards.map(\.id)) }

  func deleteSelection() {
    guard !selection.isEmpty else { return }
    let ids = selection
    model.begin()
    model.update { $0.remove(ids) }
    model.update { $0.gravity(height) }
    model.end("Delete")
    selection = []
  }

  func setColor(_ color: Int) {
    let ids = selection
    model.perform("Colour") { $0.setColor(ids, color) }
  }

  func addLane(at p: NSPoint) {
    var id = ""
    model.perform("New Lane") { id = $0.addLane(x: Double(p.x) - Metrics.laneWidth / 2, y: Double(p.y) - Metrics.laneHeight / 2) }
    selection = [id]
  }

  func addLaneAtCentre() { addLane(at: visibleWorldCentre) }

}
