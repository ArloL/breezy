import AppKit
import BreezyKit

/// -BreezySelfTest <check>: the UI tests' scenarios driven in-process with synthetic events, for
/// when XCUITest cannot run (it cannot activate the app while the screen is locked). Prints PASS
/// or FAIL with a reason and quits with 0 or 1. scripts/selftest.sh runs them all.
enum SelfTest {
  static func run(_ name: String, _ wc: BoardWindowController) {
    let d = Driver(wc)
    // a check that blocks the main thread still ends
    Thread.detachNewThread {
      Thread.sleep(forTimeInterval: 20)
      let sheet = (d.window.attachedSheet ?? NSApp.modalWindow).map { w in
        (w.contentView?.subviews ?? []).compactMap { ($0 as? NSTextField)?.stringValue }.joined(separator: " | ")
      }
      print("FAIL \(name): timed out\(sheet.map { "; sheet: " + $0 } ?? "")")
      fflush(stdout)
      exit(1)
    }
    switch name {
    case "drag-into-lane": dragIntoLane(d)
    case "keys-and-piles": keysAndPiles(d)
    case "create-type-undo": createTypeUndo(d)
    case "close-while-editing": closeWhileEditing(d)
    case "close-blank-card": closeBlankCard(d)
    case "turn-and-tab": turnAndTab(d)
    case "zoom-and-state": zoomAndState(d)
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

extension SelfTest {
  /// Double-click makes a card ready to type; Esc finishes; ⌘Z removes it in one step.
  fileprivate static func createTypeUndo(_ d: Driver) {
    let name = "create-type-undo"
    d.doubleClick(d.canvas.visibleWorldCentre)
    guard d.window.firstResponder is EditorTextView else { finish(name, "no editor after double-click") }
    d.type("Hello")
    d.key("\u{1b}", code: 53)
    if d.canvas.editing != nil { finish(name, "Esc did not finish editing") }
    if d.board.cards.map(\.text) != ["Hello"] { finish(name, "cards \(d.board.cards.map(\.text))") }
    d.key("z", code: 6, mods: .command)
    if !d.board.cards.isEmpty { finish(name, "undo left \(d.board.cards.count) cards") }
    finish(name, nil)
  }

  /// Closing the window mid-edit saves the typed text.
  fileprivate static func closeWhileEditing(_ d: Driver) {
    let name = "close-while-editing"
    guard let url = d.wc.document.flatMap({ ($0 as? NSDocument)?.fileURL }) else { finish(name, "no file") }
    d.doubleClick(d.canvas.visibleWorldCentre)
    d.type("Kept")
    d.window.performClose(nil)
    var tries = 0
    func poll() {
      let text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
      if text.contains(#""text" : "Kept""#) { finish(name, nil) }
      tries += 1
      if tries > 25 {
        let sheet = d.window.attachedSheet.map { _ in "a sheet is open" } ?? "no sheet"
        finish(name, "file has no Kept (\(sheet)): \(text.prefix(200))")
      }
      d.later(0.2, poll)
    }
    d.later(0.2, poll)
  }
}

extension SelfTest {
  /// Closing right after creating a card leaves no blank card in the file.
  fileprivate static func closeBlankCard(_ d: Driver) {
    let name = "close-blank-card"
    guard let url = d.wc.document.flatMap({ ($0 as? NSDocument)?.fileURL }) else { finish(name, "no file") }
    d.doubleClick(d.canvas.visibleWorldCentre)
    d.type(" ")
    d.window.performClose(nil)
    d.later(1.5) {
      let text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
      guard let b = try? BoardFormat.decode(Data(text.utf8)) else { finish(name, "unreadable file: \(text.prefix(200))") }
      finish(name, b.cards.isEmpty ? nil : "file has \(b.cards.count) cards")
    }
  }
}

extension SelfTest {
  /// Space turns the selected card over and back; the folded corner turns it too; a double-click
  /// edits the back, Tab goes on editing the front, and the session undoes in one step.
  fileprivate static func turnAndTab(_ d: Driver) {
    let name = "turn-and-tab"
    d.click(NSPoint(x: 120, y: 24))
    d.key(" ", code: 49)
    if d.canvas.turned != "a" { finish(name, "Space did not turn the selected card") }
    let back = d.canvas.drawnRect(d.board.card("a")!)
    if back.w != Metrics.backWidth || back.h < Metrics.backMinHeight { finish(name, "back drawn at \(back)") }
    d.key(" ", code: 49)
    if d.canvas.turned != nil { finish(name, "Space did not turn it back") }
    d.click(NSPoint(x: 236, y: 44))
    if d.canvas.turned != "a" { finish(name, "the folded corner did not turn the card") }
    d.doubleClick(NSPoint(x: 120, y: 100))
    guard let e = d.canvas.editing, e.back else { finish(name, "double-click did not edit the back") }
    d.type(" more")
    d.key("\t", code: 48)
    guard let f = d.canvas.editing, !f.back, d.canvas.turned == nil else { finish(name, "Tab did not switch to the front") }
    d.type("!")
    d.key("\u{1b}", code: 53)
    let c = d.board.card("a")!
    if c.notes != "Back more" || c.text != "Front!" { finish(name, "card is \(c.text) / \(c.notes ?? "nil")") }
    d.key("z", code: 6, mods: .command)
    let u = d.board.card("a")!
    if u.notes != "Back" || u.text != "Front" { finish(name, "undo left \(u.text) / \(u.notes ?? "nil")") }
    finish(name, nil)
  }
}

extension SelfTest {
  /// ⇧0 returns to 100 %; scrolling never edits the document; position and zoom survive window
  /// restoration.
  fileprivate static func zoomAndState(_ d: Driver) {
    let name = "zoom-and-state"
    let sv = d.wc.scrollView
    sv.magnification = 0.5
    d.click(NSPoint(x: 0, y: 600))
    d.key("=", code: 29, mods: .shift)
    d.later(0.6) {
      if abs(sv.magnification - 1) > 0.001 { finish(name, "⇧0 left zoom at \(sv.magnification)") }
      d.wc.place(origin: NSPoint(x: CanvasView.origin - 300, y: CanvasView.origin - 200), zoom: 0.75)
      if (d.wc.document as? NSDocument)?.isDocumentEdited == true { finish(name, "scrolling edited the document") }
      let archiver = NSKeyedArchiver(requiringSecureCoding: false)
      d.wc.window(d.window, willEncodeRestorableState: archiver)
      archiver.finishEncoding()
      d.wc.place(origin: NSPoint(x: CanvasView.origin, y: CanvasView.origin), zoom: 1)
      guard let unarchiver = try? NSKeyedUnarchiver(forReadingFrom: archiver.encodedData) else { finish(name, "no state") }
      unarchiver.requiresSecureCoding = false
      d.wc.window(d.window, didDecodeRestorableState: unarchiver)
      let o = sv.contentView.bounds.origin
      if abs(sv.magnification - 0.75) > 0.001 || abs(o.x - (CanvasView.origin - 300)) > 1 || abs(o.y - (CanvasView.origin - 200)) > 1 {
        finish(name, "restored to \(o) at \(sv.magnification)")
      }
      finish(name, nil)
    }
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
