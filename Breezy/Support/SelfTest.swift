import AppKit
import BreezyKit

/// -BreezySelfTest <check>: the UI tests' scenarios driven in-process with synthetic events, for
/// when XCUITest cannot run (it cannot activate the app while the screen is locked). Prints PASS
/// or FAIL with a reason and quits with 0 or 1. scripts/selftest.sh runs them all.
enum SelfTest {
  static func run(_ name: String, _ wc: BoardWindowController) {
    let d = Driver(wc)
    switch name {
    case "drag-into-lane": dragIntoLane(d)
    case "keys-and-piles": keysAndPiles(d)
    default: finish(name, "unknown check")
    }
  }

  static func finish(_ name: String, _ failure: String?) -> Never {
    print(failure.map { "FAIL \(name): \($0)" } ?? "PASS \(name)")
    fflush(stdout)
    exit(failure == nil ? 0 : 1)
  }

  /// A card dragged into a lane floats up to the top of the lane.
  private static func dragIntoLane(_ d: Driver) {
    let name = "drag-into-lane"
    guard let card = d.board.card("a"), let lane = d.board.lane("l") else { finish(name, "fixture missing") }
    let from = NSPoint(x: card.x + card.w / 2, y: card.y + 24)
    d.drag(from: from, to: NSPoint(x: lane.x + lane.w * 0.3, y: lane.y + lane.h * 0.6))
    guard let moved = d.board.card("a") else { finish(name, "card gone") }
    let centre = moved.rect(height: d.canvas.height("a"))
    if moved.y != lane.y + Metrics.stackTop { finish(name, "card at y \(moved.y), want \(lane.y + Metrics.stackTop)") }
    if !lane.rect.containsCentre(of: centre) { finish(name, "card not in lane: \(moved.x), \(moved.y)") }
    if !d.model.undoManager.canUndo { finish(name, "no undo step") }
    finish(name, nil)
  }
}

extension SelfTest {
  /// Click to select, a colour key, ⌫ with the stack closing up, a selection box, ⌥-drag of a pile.
  fileprivate static func keysAndPiles(_ d: Driver) {
    let name = "keys-and-piles"
    func centre(_ id: String) -> NSPoint {
      let c = d.board.card(id)!
      return NSPoint(x: c.x + c.w / 2, y: c.y + d.canvas.height(id) / 2)
    }
    d.click(centre("b"))
    if d.canvas.selection != ["b"] { finish(name, "click selected \(d.canvas.selection)") }
    d.key("3", code: 20)
    if d.board.card("b")?.color != 3 { finish(name, "colour key did nothing") }
    d.key("\u{7f}", code: 51)
    if d.board.card("b") != nil { finish(name, "delete did nothing") }
    if d.board.card("c")?.y != 144 { finish(name, "stack did not close up: c at \(d.board.card("c")!.y)") }
    d.drag(from: NSPoint(x: 600, y: 600), to: NSPoint(x: 10, y: 60))
    if d.canvas.selection != ["a", "c"] { finish(name, "box selected \(d.canvas.selection)") }
    d.drag(from: centre("a"), to: NSPoint(x: 840, y: 96), mods: .option)
    let xs = ["a", "c"].map { d.board.card($0)!.x }
    if xs != [720, 720] { finish(name, "pile not carried: x \(xs)") }
    d.key("z", code: 6, mods: .command)
    if d.board.card("a")?.x != 24 { finish(name, "undo did not restore the pile") }
    finish(name, nil)
  }
}

/// Sends synthetic events to a board window; points are world coordinates.
final class Driver {
  let wc: BoardWindowController
  var canvas: CanvasView { wc.canvas }
  var model: BoardModel { wc.canvas.model }
  var board: Board { model.board }
  var window: NSWindow { wc.window! }

  init(_ wc: BoardWindowController) {
    self.wc = wc
  }

  func point(_ p: NSPoint) -> NSPoint {
    canvas.convert(NSPoint(x: p.x + CanvasView.origin, y: p.y + CanvasView.origin), to: nil)
  }

  func mouse(_ type: NSEvent.EventType, _ p: NSPoint, clicks: Int = 1, mods: NSEvent.ModifierFlags = []) {
    let e = NSEvent.mouseEvent(
      with: type, location: point(p), modifierFlags: mods, timestamp: ProcessInfo.processInfo.systemUptime,
      windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: clicks, pressure: 1)!
    window.sendEvent(e)
  }

  func click(_ p: NSPoint, clicks: Int = 1, mods: NSEvent.ModifierFlags = []) {
    mouse(.leftMouseDown, p, clicks: clicks, mods: mods)
    mouse(.leftMouseUp, p, clicks: clicks, mods: mods)
  }

  func doubleClick(_ p: NSPoint) {
    click(p)
    click(p, clicks: 2)
  }

  func drag(from a: NSPoint, to b: NSPoint, mods: NSEvent.ModifierFlags = []) {
    mouse(.leftMouseDown, a, mods: mods)
    for i in 1...10 {
      let t = CGFloat(i) / 10
      mouse(.leftMouseDragged, NSPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t), mods: mods)
    }
    mouse(.leftMouseUp, b, mods: mods)
  }

  /// A key press; with ⌘ it sends the action of the menu item with that key equivalent along the
  /// window's responder chain, as AppKit does for the key window (there is none on a locked screen).
  func key(_ chars: String, code: UInt16, mods: NSEvent.ModifierFlags = []) {
    if mods.contains(.command) {
      guard let item = menuItem(chars, mods, in: NSApp.mainMenu!), let action = item.action else { return }
      _ = window.firstResponder?.tryToPerform(action, with: item)
      return
    }
    let e = NSEvent.keyEvent(
      with: .keyDown, location: .zero, modifierFlags: mods, timestamp: ProcessInfo.processInfo.systemUptime,
      windowNumber: window.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars,
      isARepeat: false, keyCode: code)!
    window.sendEvent(e)
  }

  private func menuItem(_ key: String, _ mods: NSEvent.ModifierFlags, in menu: NSMenu) -> NSMenuItem? {
    for item in menu.items {
      if let sub = item.submenu, let found = menuItem(key, mods, in: sub) { return found }
      if item.keyEquivalent == key && item.keyEquivalentModifierMask == mods { return item }
    }
    return nil
  }

  /// Types into whatever text view or field editor has focus.
  func type(_ text: String) {
    (window.firstResponder as? NSTextView)?.insertText(text, replacementRange: NSRange(location: NSNotFound, length: 0))
  }

  /// Runs `step` after the run loop has had `delay` seconds, for work AppKit finishes asynchronously.
  func later(_ delay: Double = 0.3, _ step: @escaping () -> Void) {
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: step)
  }
}
