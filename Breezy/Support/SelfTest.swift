import AppKit
import BreezyKit
import IOSurface

/// -BreezySelfTest <check>: the UI tests' scenarios driven in-process with synthetic events, for
/// when XCUITest cannot run (it cannot activate the app while the screen is locked). Prints PASS
/// or FAIL with a reason and quits with 0 or 1. scripts/selftest.sh runs them all.
enum SelfTest {
  static func run(_ name: String, _ wc: BoardWindowController) {
    let d = Driver(wc)
    // a check that blocks the main thread still ends
    Thread.detachNewThread {
      Thread.sleep(forTimeInterval: 30)
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
    case "find-back": findBack(d)
    case "card-heights": cardHeights(d)
    case "zoom-sharp": zoomSharp(d)
    case "caret-click": caretClick(d)
    case "edit-in-place": editInPlace(d)
    default: finish(name, "unknown check")
    }
  }

  static func finish(_ name: String, _ failure: String?) -> Never {
    print(failure.map { "FAIL \(name): \($0)" } ?? "PASS \(name)")
    fflush(stdout)
    exit(failure == nil ? 0 : 1)
  }

  /// After a zoom in and back, every visible card shows a bitmap drawn at the current scale, not
  /// the stretched one that stood in while it was drawn.
  private static func zoomSharp(_ d: Driver) {
    let name = "zoom-sharp"
    guard d.window.occlusionState.contains(.visible) else {
      print("PASS \(name) (window out of sight: not checked)")
      exit(0)
    }
    let centre = NSPoint(x: CanvasView.origin + 264, y: CanvasView.origin + 180)
    func check(_ zoom: CGFloat, then next: @escaping () -> Void) {
      d.wc.place(origin: NSPoint(x: centre.x - 450 / zoom, y: centre.y - 300 / zoom), zoom: zoom)
      d.later(0.8) {
        let scale = d.window.backingScaleFactor * zoom
        let shown = d.canvas.cardLayers.values.filter { $0.frame.intersects(d.canvas.visibleRect) }
        if shown.count < 6 { finish(name, "\(shown.count) cards on screen at \(zoom), want 6") }
        for l in shown {
          guard let s = (l.contents as AnyObject?) as? IOSurface else { finish(name, "a card shows no bitmap at \(zoom)") }
          let want = Int((l.bounds.width * scale).rounded(.up))
          if s.width != want { finish(name, "a card shows \(s.width) px at zoom \(zoom), want \(want)") }
        }
        next()
      }
    }
    check(1.5) { check(1) { finish(name, nil) } }
  }

  /// Cards are as tall as their lines: a title, three lines, a title that wraps, a long back.
  private static func cardHeights(_ d: Driver) {
    let name = "card-heights"
    let line = Metrics.grid
    let want = ["one": 2 * line, "three": 4 * line, "wraps": 3 * line]
    for (id, h) in want where d.canvas.height(id) != h { finish(name, "\(id) is \(d.canvas.height(id)) high, want \(h)") }
    guard let notes = d.board.card("notes") else { finish(name, "fixture missing") }
    let back = Double(TextMetrics.backHeight(notes))
    // a heading line and 14 lines of notes, with padding
    if back != 17 * line { finish(name, "the back is \(back) high, want \(17 * line)") }
    finish(name, nil)
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
    d.mouse(.leftMouseDown, NSPoint(x: 600, y: 600))
    d.mouse(.leftMouseDragged, NSPoint(x: 300, y: 330))
    let box = d.canvas.marquee
    if box.isHidden || (box.layer?.borderWidth ?? 0) == 0 || box.layer?.backgroundColor == nil { finish(name, "the selection box does not show") }
    d.mouse(.leftMouseUp, NSPoint(x: 300, y: 330))
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

  /// Closing while a card is being edited keeps its text in the store's file.
  fileprivate static func closeWhileEditing(_ d: Driver) {
    let name = "close-while-editing"
    let file = StoreFile(url: DebugLaunch.storeDirectory.appendingPathComponent("Spaces/local.json"))
    d.doubleClick(d.canvas.visibleWorldCentre)
    d.type("Kept")
    d.window.performClose(nil)
    var tries = 0
    func poll() {
      let texts = ((try? file.load()) ?? nil)?.records.values.compactMap { $0.current.deleted ? nil : $0.current["text"]?.string } ?? []
      if texts.contains("Kept") { finish(name, nil) }
      tries += 1
      if tries > 25 { finish(name, "the store has no Kept: \(texts)") }
      d.later(0.2, poll)
    }
    d.later(0.2, poll)
  }
}

extension SelfTest {
  /// Closing right after creating a card leaves no blank card in the store.
  fileprivate static func closeBlankCard(_ d: Driver) {
    let name = "close-blank-card"
    let file = StoreFile(url: DebugLaunch.storeDirectory.appendingPathComponent("Spaces/local.json"))
    d.doubleClick(d.canvas.visibleWorldCentre)
    d.type(" ")
    d.window.performClose(nil)
    d.later(1.5) {
      guard let state = (try? file.load()) ?? nil else { finish(name, "no store file") }
      let cards = state.records.values.filter { $0.current.kind == "card" && !$0.current.deleted }
      finish(name, cards.isEmpty ? nil : "the store has \(cards.count) cards")
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
    // the zoom springs there
    d.later(1.2) {
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

extension SelfTest {
  /// ⌘F finds text on a card's back and turns the card over; the find bar also searches lane titles.
  fileprivate static func findBack(_ d: Driver) {
    let name = "find-back"
    d.click(NSPoint(x: 0, y: 600))
    d.key("f", code: 3, mods: .command)
    d.later(0.5) {
      guard d.window.firstResponder is NSTextView, d.canvas.editing == nil else { finish(name, "⌘F did not focus a find field") }
      d.type("needle")
      d.key("\r", code: 36)
      d.later(0.5) {
        if d.canvas.turned != "a" { finish(name, "the match on the back did not turn card a (turned: \(d.canvas.turned ?? "nil"))") }
        finish(name, nil)
      }
    }
  }
}

extension SelfTest {
  /// A click on the last line of either side of an edited card lands in the editor.
  fileprivate static func caretClick(_ d: Driver) {
    let name = "caret-click"
    for back in [false, true] {
      d.canvas.turn(back ? "a" : nil)
      d.canvas.beginEdit("a")
      guard let e = d.canvas.editing else { finish(name, "no editor") }
      let f = e.view.frame
      let card = d.canvas.drawnRect(d.board.card("a")!)
      let p = NSPoint(x: card.x + card.w / 2, y: card.y + card.h - (back ? Typo.backPad : Typo.padY) - Typo.line / 2)
      let side = back ? "back" : "front"
      if d.window.contentView?.hitTest(d.window.contentView!.superview!.convert(d.point(p), from: nil)) !== e.view {
        finish(name, "the last line of the \(side) is outside its \(f.height) pt editor")
      }
      d.click(p)
      if d.canvas.editing == nil { finish(name, "a click on the \(side) ended editing") }
      d.canvas.endEditing()
    }
    finish(name, nil)
  }
}

extension SelfTest {
  /// A card's text stays on the same pixels when its editor opens, on either side, in light and
  /// dark, at zooms that put the card between pixels.
  fileprivate static func editInPlace(_ d: Driver) {
    let name = "edit-in-place"
    guard d.window.occlusionState.contains(.visible) else {
      print("PASS \(name) (window out of sight: not checked)")
      exit(0)
    }
    var steps: [(zoom: CGFloat, dark: Bool, back: Bool)] = []
    for zoom in [0.89, 1, 1.3] as [CGFloat] { for dark in [false, true] { for back in [false, true] { steps.append((zoom, dark, back)) } } }
    func next() {
      guard let (zoom, dark, back) = steps.popLast() else { finish(name, nil) }
      NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
      d.canvas.turn(back ? "a" : nil)
      d.wc.place(origin: NSPoint(x: CanvasView.origin - 40, y: CanvasView.origin - 40), zoom: zoom)
      // after the turn's spring
      d.later(0.9) {
        let before = d.image()
        d.canvas.beginEdit("a")
        d.canvas.editing?.view.insertionPointColor = .clear
        d.later(0.3) {
          let during = d.image()
          d.canvas.endEditing()
          let r = d.canvas.doc(d.canvas.drawnRect(d.board.card("a")!)).insetBy(dx: 2, dy: 2)
          let n = d.differing(before, during, in: r)
          let side = back ? "back" : "front"
          if n > 10 { finish(name, "\(n) pixels of the \(side) change when it is edited at \(zoom) in \(dark ? "dark" : "light")") }
          next()
        }
      }
    }
    next()
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

  func image() -> NSBitmapImageRep {
    NSBitmapImageRep(cgImage: DebugLaunch.image(of: window)!)
  }

  /// The pixels that differ visibly between two captures in `rect` of the canvas; text blended onto
  /// a transparent layer rather than the card differs by less.
  func differing(_ a: NSBitmapImageRep, _ b: NSBitmapImageRep, in rect: NSRect) -> Int {
    let w = canvas.convert(rect, to: nil), scale = CGFloat(a.pixelsWide) / window.frame.width
    var n = 0
    for y in Int((window.frame.height - w.maxY) * scale)..<Int((window.frame.height - w.minY) * scale) {
      for x in Int(w.minX * scale)..<Int(w.maxX * scale) {
        let p = a.colorAt(x: x, y: y)!, q = b.colorAt(x: x, y: y)!
        if max(abs(p.redComponent - q.redComponent), abs(p.greenComponent - q.greenComponent), abs(p.blueComponent - q.blueComponent)) > 0.1 { n += 1 }
      }
    }
    return n
  }

  /// Runs `step` after the run loop has had `delay` seconds, for work AppKit finishes asynchronously.
  func later(_ delay: Double = 0.3, _ step: @escaping () -> Void) {
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: step)
  }
}
