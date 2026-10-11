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
    if chars == "l" || chars == "L" {
      let m = convert(window!.mouseLocationOutsideOfEventStream, from: nil)
      return addLane(at: NSPoint(x: m.x - Self.origin, y: m.y - Self.origin))
    }
    if !core.key(code: event.keyCode, chars: chars) { super.keyDown(with: event) }
  }

  @objc func delete(_ sender: Any?) { deleteSelection() }

  override func selectAll(_ sender: Any?) { selection = Set(board.cards.map(\.id)) }

  func deleteSelection() { core.deleteSelection() }

  func setColor(_ color: Int) { core.setColor(color) }

  func addLane(at p: NSPoint) {
    var id = ""
    model.perform("New Lane") { b in
      let s = b.openSpot(w: Metrics.laneWidth, h: Metrics.laneHeight, near: Double(p.x) - Metrics.laneWidth / 2, Double(p.y) - Metrics.laneHeight / 2, heightOf: height)
      id = b.addLane(x: s.x, y: s.y)
    }
    selection = [id]
  }

  func addLaneAtCentre() { addLane(at: visibleWorldCentre) }

}
