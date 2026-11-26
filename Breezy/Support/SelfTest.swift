import AppKit
import BreezyKit
import IOSurface

/// -BreezySelfTest <check>: the UI tests' scenarios driven in-process with synthetic events, for
/// when XCUITest cannot run (it cannot activate the app while the screen is locked). Prints PASS,
/// FAIL with a reason, or SKIP when it could not look, and quits with 0, 1 or 2. scripts/selftest.sh
/// runs them all.
enum SelfTest {
  static func run(_ name: String, _ wc: BoardWindowController) {
    let d = Driver(wc)
    // a check that blocks the main thread still ends
    Thread.detachNewThread {
      Thread.sleep(forTimeInterval: 60)
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
    case "frames": MainActor.assumeIsolated { frames(d) }
    case "taken-events": MainActor.assumeIsolated { takenEvents(d) }
    case "replay": MainActor.assumeIsolated { replay(d) }
    case "gesture-marks": MainActor.assumeIsolated { gestureMarks(d) }
    case "bounded-board": boundedBoard(d)
    case "bounded-rests": MainActor.assumeIsolated { boundedRests(d) }
    case "fades": MainActor.assumeIsolated { fades(d) }
    default: finish(name, "unknown check")
    }
  }

  /// A check of pixels needs the window on screen; behind a locked or sleeping screen nothing is drawn to compare.
  static func skipUnlessVisible(_ name: String, _ d: Driver) {
    guard !d.window.occlusionState.contains(.visible) else { return }
    print("SKIP \(name): the window is out of sight, so nothing is drawn to check")
    fflush(stdout)
    exit(2)
  }

  static func finish(_ name: String, _ failure: String?) -> Never {
    let line = failure.map { "FAIL \(name): \($0)" } ?? "PASS \(name)"
    print(line)
    fflush(stdout)
    // for the UI tests, which cannot read the app's output
    if let out = UserDefaults.standard.string(forKey: "BreezySelfTestOut") { try? line.write(toFile: out, atomically: true, encoding: .utf8) }
    exit(failure == nil ? 0 : 1)
  }

  /// After a zoom in and back, every visible card shows a bitmap drawn at the current scale, not
  /// the stretched one that stood in while it was drawn.
  private static func zoomSharp(_ d: Driver) {
    let name = "zoom-sharp"
    skipUnlessVisible(name, d)
    let centre = NSPoint(x: 264, y: 180)
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
  /// Space turns the selected card over and back; a double-click on its corner turns it too; a
  /// double-click edits the back, Tab goes on editing the front, and the session undoes in one step.
  fileprivate static func turnAndTab(_ d: Driver) {
    let name = "turn-and-tab"
    d.click(NSPoint(x: 120, y: 24))
    d.key(" ", code: 49)
    if d.canvas.turned != "a" { finish(name, "Space did not turn the selected card") }
    let back = d.canvas.drawnRect(d.board.card("a")!)
    if back.w != Metrics.backWidth || back.h < Metrics.backMinHeight { finish(name, "back drawn at \(back)") }
    d.key(" ", code: 49)
    if d.canvas.turned != nil { finish(name, "Space did not turn it back") }
    d.doubleClick(NSPoint(x: 236, y: 44))
    if d.canvas.turned != "a" { finish(name, "a double-click on the corner did not turn the card") }
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
      d.wc.place(origin: NSPoint(x: -300, y: -200), zoom: 0.75)
      if (d.wc.document as? NSDocument)?.isDocumentEdited == true { finish(name, "scrolling edited the document") }
      let archiver = NSKeyedArchiver(requiringSecureCoding: false)
      d.wc.window(d.window, willEncodeRestorableState: archiver)
      archiver.finishEncoding()
      d.wc.place(origin: .zero, zoom: 1)
      guard let unarchiver = try? NSKeyedUnarchiver(forReadingFrom: archiver.encodedData) else { finish(name, "no state") }
      unarchiver.requiresSecureCoding = false
      d.wc.window(d.window, didDecodeRestorableState: unarchiver)
      let o = d.canvas.showing.origin
      if abs(sv.magnification - 0.75) > 0.001 || abs(o.x + 300) > 1 || abs(o.y + 200) > 1 {
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
    skipUnlessVisible(name, d)
    var steps: [(zoom: CGFloat, dark: Bool, back: Bool)] = []
    for zoom in [0.89, 1, 1.3] as [CGFloat] { for dark in [false, true] { for back in [false, true] { steps.append((zoom, dark, back)) } } }
    // every step's count, with -BreezyCaptureOut <json> kept as the plant editor-shift's capture
    // (scripts/test/mac-plants.test.ts), and the first that changed failing the test
    var rows: [[Double]] = [], failure: String?
    func next() {
      guard let (zoom, dark, back) = steps.popLast() else {
        if let out = UserDefaults.standard.string(forKey: "BreezyCaptureOut") {
          let capture: [String: Any] = ["fields": ["zoom", "dark", "back", "changed"], "rows": rows]
          try? JSONSerialization.data(withJSONObject: capture).write(to: URL(fileURLWithPath: out))
        }
        finish(name, failure)
      }
      NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
      d.canvas.turn(back ? "a" : nil)
      d.wc.place(origin: NSPoint(x: -40, y: -40), zoom: zoom)
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
          rows.append([Double(zoom), dark ? 1 : 0, back ? 1 : 0, Double(n)])
          if n > 10 && failure == nil { failure = "\(n) pixels of the \(side) change when it is edited at \(zoom) in \(dark ? "dark" : "light")" }
          next()
        }
      }
    }
    next()
  }
}

extension SelfTest {
  /// The scroll view's document is the board: its cards and lanes, 1,194 pt round them, and what showed at rest, so
  /// that its edge shows only while the view is pulled past it, and AppKit springs it back. Grown at its left and top
  /// and shrunk back, by a card or by a zoom, nothing on screen moves. With -BreezyShots <dir> it captures each step.
  fileprivate static func boundedBoard(_ d: Driver) {
    let name = "bounded-board"
    let c = d.canvas, sv = d.wc.scrollView, clip = sv.contentView, grid = d.wc.grid
    let shots = UserDefaults.standard.string(forKey: "BreezyShots")
    func shot(_ step: String) {
      guard let shots else { return }
      try? d.image().representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: shots).appendingPathComponent("\(step).png"))
    }
    func near(_ a: NSPoint, _ b: NSPoint, within e: CGFloat = 0.01) -> Bool { abs(a.x - b.x) <= e && abs(a.y - b.y) <= e }
    func edgeShows() -> Bool { !grid.paperFrame.insetBy(dx: -0.5, dy: -0.5).contains(grid.convert(clip.bounds, from: clip)) }
    func bounded(_ when: String) {
      let content = BoardBounds.extent(d.board.cards.map(c.drawnRect) + d.board.lanes.map(\.rect))
      let s = c.showing, b = c.bounds
      let want = BoardBounds.board(content, seen: Rect(x: s.minX, y: s.minY, w: s.width, h: s.height)).outward
      // past its bottom and right by at most a legacy scroller, which shows or hides with the size and moves the view
      let slack = sv.scrollerStyle == .legacy ? NSScroller.scrollerWidth(for: .regular, scrollerStyle: .legacy) / sv.magnification + 1 : 0
      if b.minX != want.x || b.minY != want.y || !(want.w...want.w + slack).contains(b.width) || !(want.h...want.h + slack).contains(b.height) {
        finish(name, "\(when): the document is \(b), the board \(want); the view \(s) at \(sv.magnification), scrolling \(sv.scrolling), magnifying \(sv.magnifying), scrollers hidden \(sv.horizontalScroller?.isHidden ?? true) \(sv.verticalScroller?.isHidden ?? true)")
      }
      if c.frame.size != b.size { finish(name, "\(when): the document's frame is \(c.frame.size), the board's \(b.size)") }
      if !b.insetBy(dx: -0.01, dy: -0.01).contains(s) { finish(name, "\(when): the view shows \(s), past the board \(b)") }
      if edgeShows() { finish(name, "\(when): the edge shows, the paper \(grid.paperFrame) under \(grid.convert(clip.bounds, from: clip))") }
    }
    func screen(_ id: String) -> NSPoint { c.convert(c.doc(c.drawnRect(d.board.card(id)!)).origin, to: nil) }
    func centre() -> NSPoint { NSPoint(x: c.showing.midX, y: c.showing.midY) }
    // AppKit puts the scroll position on whole pixels, which a zoom's centre can be half a screen point from
    func centred(_ mid: NSPoint) -> Bool { near(centre(), mid, within: 0.5 / sv.magnification) }
    bounded("opened")
    shot("opened")
    d.wc.place(origin: c.bounds.origin, zoom: 1)
    bounded("at the top left")
    shot("top-left")
    let corner = c.bounds, shown = c.showing, a = screen("a"), at = clip.bounds.origin
    // a card far up and to the left grows the board there: the clip view's points move, what shows does not
    d.model.perform("Far") { $0.cards.append(Card(id: "far", x: corner.minX - 2400, y: corner.minY - 1200, text: "Far")) }
    let grown = CGVector(dx: corner.minX - c.bounds.minX, dy: corner.minY - c.bounds.minY)
    if grown.dx < 2400 || grown.dy < 1200 { finish(name, "a card past the top left grew the board by \(grown)") }
    if !near(c.showing.origin, shown.origin) { finish(name, "growing moved the view from \(shown.origin) to \(c.showing.origin)") }
    if !near(screen("a"), a) { finish(name, "growing moved card a on screen from \(a) to \(screen("a"))") }
    if !near(clip.bounds.origin, NSPoint(x: at.x + grown.dx, y: at.y + grown.dy)) { finish(name, "the scroll position is \(clip.bounds.origin)") }
    d.model.undoManager.undo()
    if d.board.card("far") != nil { finish(name, "undo left the far card") }
    if c.bounds != corner { finish(name, "the board is \(c.bounds) once the far card went, was \(corner)") }
    if !near(c.showing.origin, shown.origin) || !near(screen("a"), a) { finish(name, "shrinking moved what shows") }
    // zoomed out around the middle, the view shows past the top left: the board takes it in, and the middle holds
    let mid = centre()
    sv.setMagnification(0.25, centeredAt: c.clipPoint(mid))
    if !centred(mid) { finish(name, "zooming out moved the middle from \(mid) to \(centre())") }
    if !c.bounds.insetBy(dx: -0.01, dy: -0.01).contains(c.showing) { finish(name, "zoomed out, the view shows \(c.showing) past the board \(c.bounds)") }
    d.later(0.4) {
      bounded("zoomed out")
      shot("zoomed-out")
      sv.setMagnification(1, centeredAt: c.clipPoint(mid))
      if !centred(mid) { finish(name, "zooming in moved the middle from \(mid) to \(centre())") }
      d.later(0.4) {
        // at rest again, the board lets go of what the zoom showed
        bounded("zoomed back in")
        if c.bounds != corner { finish(name, "the board is \(c.bounds) after zooming back, was \(corner)") }
        pull(d, name: name, down: true, edgeShows: edgeShows, shot: shot) {
          bounded("after the pull down")
          pull(d, name: name, down: false, edgeShows: edgeShows, shot: shot) {
            bounded("after the pull right")
            pullsAfterZooms(d, name: name, corner: corner, edgeShows: edgeShows, shot: shot) {
              boundedAnyway(d, name: name, corner: corner, bounded: bounded) { finish(name, nil) }
            }
          }
        }
      }
    }
  }

  /// A pan straight after a zoom is a pan, held at the edge as any other: whether the zoom was set at once, a spring the
  /// scroll stops, or a pinch held still past the rest before it lifted. From the board's top left, zoomed out around
  /// it, a mouse's wheel turned up and left stops at the edge, and a trackpad pulls past it.
  private static func pullsAfterZooms(_ d: Driver, name: String, corner: NSRect, edgeShows: @escaping () -> Bool,
                                      shot: @escaping (String) -> Void, then: @escaping () -> Void) {
    let sv = d.wc.scrollView, clip = sv.contentView, c = d.canvas, nc = NotificationCenter.default
    func atCorner(_ next: @escaping () -> Void) {
      d.wc.place(origin: corner.origin, zoom: 1)
      d.later(0.3, next)
    }
    func wheel(_ after: String) {
      let before = c.bounds, at = c.showing.origin
      let e = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: 3, wheel2: 3, wheel3: 0)!
      sv.scrollWheel(with: NSEvent(cgEvent: e)!)
      if c.bounds != before || c.showing.origin != at {
        finish(name, "a wheel turned past the top left \(after) moved the view to \(c.showing.origin) on \(c.bounds), was \(at) on \(before)")
      }
    }
    // a selection box held at the view's top left scrolls the board there, as far as its edge
    func edgeScroll(_ after: String, then next: @escaping () -> Void) {
      let before = c.bounds, s = c.showing, z = sv.magnification
      d.mouse(.leftMouseDown, NSPoint(x: s.minX + 300 / z, y: s.minY + 300 / z))
      d.mouse(.leftMouseDragged, NSPoint(x: s.minX + 4 / z, y: s.minY + 4 / z))
      d.later(0.6) {
        let now = c.showing.origin
        d.mouse(.leftMouseUp, NSPoint(x: now.x + 4 / z, y: now.y + 4 / z))
        if c.bounds != before || now != before.origin {
          finish(name, "a selection box held at the top left \(after) scrolled the view to \(now) on \(c.bounds), the board was \(before)")
        }
        next()
      }
    }
    atCorner {
      sv.setMagnification(0.5, centeredAt: clip.bounds.origin)
      wheel("after a zoom")
      edgeScroll("after a zoom") {
      pull(d, name: name, down: true, as: "down after a zoom", edgeShows: edgeShows, shot: shot) {
        atCorner {
          sv.springMagnification(to: 0.5, centeredAt: clip.bounds.origin)
          d.later(0.05) {
            wheel("during a spring zoom")
            pull(d, name: name, down: true, as: "down after a spring zoom", edgeShows: edgeShows, shot: shot) {
              atCorner {
                // a pinch, as AppKit brackets one, held still past the rest before it lifts
                nc.post(name: NSScrollView.willStartLiveMagnifyNotification, object: sv)
                sv.setMagnification(0.5, centeredAt: clip.bounds.origin)
                d.later(0.3) {
                  nc.post(name: NSScrollView.didEndLiveMagnifyNotification, object: sv)
                  d.later(0.3) {
                    wheel("after a pinch held still")
                    edgeScroll("after a pinch held still") {
                      pull(d, name: name, down: true, as: "down after a pinch held still", edgeShows: edgeShows, shot: shot) {
                        // a zoom whose proposals' sizes are not whole points
                        atCorner {
                          sv.setMagnification(0.7312, centeredAt: clip.bounds.origin)
                          edgeScroll("after a zoom to 73.12 %", then: then)
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
      }
    }
  }

  /// A trackpad's two fingers pull the view down, or right, past the board's top or left edge: AppKit stretches it,
  /// and the edge shows, plain; let go, it springs back and the board stays as it was.
  private static func pull(_ d: Driver, name: String, down: Bool, as label: String? = nil, edgeShows: @escaping () -> Bool,
                           shot: @escaping (String) -> Void, then: @escaping () -> Void) {
    let sv = d.wc.scrollView, c = d.canvas
    let way = label ?? (down ? "down" : "right"), before = c.bounds
    func scroll(_ phase: CGScrollPhase, _ delta: Int32) {
      let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: down ? delta : 0, wheel2: down ? 0 : delta, wheel3: 0)!
      e.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
      e.setIntegerValueField(.scrollWheelEventScrollPhase, value: Int64(phase.rawValue))
      sv.scrollWheel(with: NSEvent(cgEvent: e)!)
    }
    // what the recording holds from the pull on, for a failure to show: the frames' view and board tops and phases,
    // the board's rests, and the scrollers
    let began = ProcessInfo.processInfo.systemUptime * 1000
    @MainActor func evidence(since t0: Double) -> String {
      let r = c.core.flight.recording(), f = Flight.frameFields
      let rows = (r.frames?.rows ?? []).filter { ($0[0] ?? 0) >= t0 }.map { row in
        ["t", "zoom", "camY", "boardY", "boardH", "wheelPhase", "momentumPhase"].map { k in row[f.firstIndex(of: k)!].map { String(format: "%.1f", k == "t" ? $0 - t0 : $0) } ?? "-" }.joined(separator: " ")
      }
      let rests = r.entries.filter { $0.what == "board rest" }.suffix(4).map { "\($0.data ?? [:])" }
      return "scrollers \(sv.scrollerStyle == .legacy ? "legacy" : "overlay"), scale \(d.window.backingScaleFactor); frames (t zoom camY boardY boardH wheel momentum): \(rows.joined(separator: " | ")); rests: \(rests.joined(separator: " | "))"
    }
    scroll(.began, 0)
    var steps = 12
    func step() {
      scroll(.changed, 30)
      steps -= 1
      guard steps == 0 else { return d.later(0.016, step) }
      d.later(0.1) {
        let s = c.showing
        if down ? s.minY >= c.bounds.minY : s.minX >= c.bounds.minX { finish(name, "the pull \(way) did not stretch past the edge: \(s) on \(c.bounds)") }
        if !edgeShows() { finish(name, "pulled \(way) past the edge, no edge shows") }
        shot("pulled-" + way.replacingOccurrences(of: " ", with: "-"))
        scroll(.ended, 0)
        d.later(1.5) {
          // zoomed out, AppKit's own bounce stops up to 10 px short of the edge (a stock NSScrollView: 4 px at 50 % on
          // 1x, 4 px at 25 % on 2x) and the rest takes in what shows: the board may grow at the pulled edge, to the
          // view's whole point, which a spring zoom's step may have left a pixel further
          let b = c.bounds, s = c.showing, px = 1 / (d.window.backingScaleFactor * sv.magnification), short = 12 * px
          let gap = down ? before.minY - b.minY : before.minX - b.minX
          let leftShort = (0...short).contains(gap) && abs((down ? s.minY : s.minX) - (down ? b.minY : b.minX)) <= px + 1
            && (down ? b.minX == before.minX && b.width == before.width && b.maxY == before.maxY
                     : b.minY == before.minY && b.height == before.height && b.maxX == before.maxX)
          if b != before && !leftShort {
            finish(name, "the pull \(way) left the board at \(b), was \(before), the view at \(s); \(MainActor.assumeIsolated { evidence(since: began) })")
          }
          then()
        }
      }
    }
    d.later(0.016, step)
  }
}

extension SelfTest {
  /// A trackpad's pinch, as the window server sends one: a gesture event of HID type zoom, `m` the magnification's
  /// change, in phase began 1, changed 2 or ended 4, at window point `p`.
  static func magnifyEvent(_ phase: Int64, _ m: Double, at p: NSPoint, in w: NSWindow) -> NSEvent {
    let e = CGEvent(source: nil)!
    e.type = CGEventType(rawValue: 29)!
    e.setIntegerValueField(CGEventField(rawValue: 110)!, value: 8)
    e.setDoubleValueField(CGEventField(rawValue: 113)!, value: m)
    e.setIntegerValueField(CGEventField(rawValue: 132)!, value: phase)
    let screen = w.convertPoint(toScreen: p)
    e.location = CGPoint(x: screen.x, y: (NSScreen.screens.first?.frame.height ?? 0) - screen.y)
    return NSEvent(cgEvent: e)!
  }

  /// Whatever got the view there, at rest it shows no edge: after a trackpad's pinch out at the corner and back in,
  /// after a zoom the board missed (as one left the owner's board smaller than the view at 25 %, stuck and centred),
  /// with a gesture whose end AppKit never told, and as the window grows at the board's bottom right, at once.
  fileprivate static func boundedAnyway(_ d: Driver, name: String, corner: NSRect, bounded: @escaping (String) -> Void,
                                        then: @escaping () -> Void) {
    let sv = d.wc.scrollView, clip = sv.contentView, c = d.canvas, nc = NotificationCenter.default
    func pinch(_ deltas: [Double], at p: NSPoint, then next: @escaping () -> Void) {
      var events: [(Int64, Double)] = [(1, 0)] + deltas.map { (2, $0) } + [(4, 0)]
      // AppKit zooms a pinch about the cursor
      let screen = d.window.convertPoint(toScreen: p)
      CGWarpMouseCursorPosition(CGPoint(x: screen.x, y: (NSScreen.screens.first?.frame.height ?? 0) - screen.y))
      let held = c.convert(p, from: nil)
      // the scrollers' knobs change with the zoom only, as AppKit's over a document that stays: not as the board grows
      // for the pinch as it begins, nor as it lets that go at rest
      func knobs() -> [CGFloat] { [sv.horizontalScroller, sv.verticalScroller].map { $0.map { $0.knobProportion } ?? 0 } }
      func steady(_ was: [CGFloat], _ when: String) {
        if zip(was, knobs()).contains(where: { abs($0 - $1) > 0.002 }) { finish(name, "\(when), at a steady zoom, the scrollers' knobs went from \(was) to \(knobs())") }
      }
      var before = knobs()
      func step() {
        guard !events.isEmpty else {
          let (end, z) = (knobs(), sv.magnification)
          return d.later(0.8) {
            if sv.magnification == z { steady(end, "a pinch at rest") }
            next()
          }
        }
        let (phase, m) = events.removeFirst()
        sv.magnify(with: magnifyEvent(phase, m, at: p, in: d.window))
        if phase == 1 { steady(before, "a pinch begun") }
        before = knobs()
        d.later(0.016) {
          // the board under the view at every step, not only at rest: AppKit puts the view past the board's top left
          // while it proposes the clip view an origin of 0, 0
          let px = 1 / (d.window.backingScaleFactor * sv.magnification) + 0.01
          if !c.bounds.insetBy(dx: -px, dy: -px).contains(c.showing) {
            finish(name, "pinching \(m < 0 ? "out" : "in") at \(sv.magnification), the view shows \(c.showing) past the board \(c.bounds)")
          }
          // and the board point under the fingers stays there, as the board grows under it
          let under = c.convert(p, from: nil), slip = hypot(under.x - held.x, under.y - held.y) * sv.magnification
          if slip > 1 { finish(name, "pinching \(m < 0 ? "out" : "in") at \(sv.magnification), the board slipped \(slip) pt from under the fingers") }
          step()
        }
      }
      step()
    }
    // a zoom that left the board under the view, at 25 %
    func missed(_ when: String, wait: Double, then next: @escaping () -> Void) {
      d.wc.place(origin: NSPoint(x: corner.minX - 800, y: corner.minY - 300), zoom: 0.25)
      d.later(0.4) {
        let at = c.showing.origin
        c.reach.rest(Rect(x: 0, y: 0, w: 1, h: 1))
        c.fitBoard()
        d.later(wait) {
          bounded(when)
          if c.showing.origin != at { finish(name, "\(when), the view moved from \(at) to \(c.showing.origin)") }
          next()
        }
      }
    }
    func grow(_ zoom: CGFloat, then next: @escaping () -> Void) {
      let w = d.window, frame = w.frame
      d.wc.place(origin: .zero, zoom: zoom)
      let b = c.bounds, size = c.showing.size
      d.wc.place(origin: NSPoint(x: b.maxX - size.width, y: b.maxY - size.height), zoom: zoom)
      d.later(0.3) {
        let at = c.showing.origin
        w.setFrame(NSRect(x: frame.minX, y: frame.minY - 300, width: frame.width + 400, height: frame.height + 300), display: true)
        // at once: the board under all the view shows, no edge, and the view where it was; at rest, the board exactly
        let when = "the window grown at the bottom right at \(Int(zoom * 100)) %", grid = d.wc.grid
        // AppKit puts the view on whole pixels, 4 pt apart at 25 % on 1x, where the board's edge may fall between two
        let px = 1 / (w.backingScaleFactor * sv.magnification) + 0.01
        if !c.bounds.insetBy(dx: -px, dy: -px).contains(c.showing) { finish(name, "\(when): the view shows \(c.showing) past \(c.bounds)") }
        if !grid.paperFrame.insetBy(dx: -0.5, dy: -0.5).contains(grid.convert(clip.bounds, from: clip)) { finish(name, "\(when): the edge shows") }
        if abs(c.showing.minX - at.x) > px || abs(c.showing.minY - at.y) > px { finish(name, "\(when): the view moved from \(at) to \(c.showing.origin)") }
        d.later(0.3) {
          bounded(when)
          w.setFrame(frame, display: true)
          d.later(0.3, next)
        }
      }
    }
    // a two-finger double tap that zooms out to show the whole document, animated as AppKit animates its smart zoom
    d.wc.place(origin: corner.origin, zoom: 1)
    d.later(0.3) {
      NSAnimationContext.runAnimationGroup { _ in sv.animator().magnify(toFit: clip.convert(c.bounds, from: c)) }
      d.later(0.8) {
        shot(d, "whole-board")
        bounded("after an animated zoom to the whole board")
        pinches()
      }
    }
    func pinches() {
    d.wc.place(origin: corner.origin, zoom: 2)
    d.later(0.3) {
      let p = clip.convert(NSPoint(x: clip.bounds.minX + 20, y: clip.bounds.minY + 20), to: nil)
      pinch(Array(repeating: -0.3, count: 8), at: p) {
        bounded("after a pinch out at the top left")
        let out = sv.magnification
        pinch(Array(repeating: 0.06, count: 20), at: p) {
          if sv.magnification < out * 1.5 { finish(name, "a pinch in from \(out) zoomed to \(sv.magnification)") }
          bounded("after a pinch back in")
          missed("after a zoom the board missed", wait: 0.4) {
            // AppKit brackets some scrolls with no end
            nc.post(name: NSScrollView.willStartLiveScrollNotification, object: sv)
            missed("after a zoom the board missed, in a gesture that never ended", wait: 1.6) {
              nc.post(name: NSScrollView.didEndLiveScrollNotification, object: sv)
              grow(1) { grow(0.25, then: then) }
            }
          }
        }
      }
    }
    }
  }
}

extension SelfTest {
  /// With -BreezyShots <dir>, a capture of the window as `step`.png there.
  static func shot(_ d: Driver, _ step: String) {
    guard let shots = UserDefaults.standard.string(forKey: "BreezyShots") else { return }
    try? d.image().representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: shots).appendingPathComponent("\(step).png"))
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
    canvas.convert(p, to: nil)
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

extension SelfTest {
  /// The recording keeps frames while the view moves and one after it rests: for a zoom on the app's spring, for one
  /// AppKit animates, as a two-finger double tap's, and for a resize; in points, whatever the display's scale.
  @MainActor fileprivate static func frames(_ d: Driver) {
    let name = "frames"
    let sv = d.wc.scrollView
    let rows: @MainActor () -> [[Double?]] = { d.canvas.core.flight.recording().frames?.rows ?? [] }
    let field = { (f: String) in Flight.frameFields.firstIndex(of: f)! }
    @MainActor func zoomsChanged(since n: Int) -> Bool { Set(rows().dropFirst(n).compactMap { $0[field("zoom")] }).count > 2 }
    @MainActor func restedLast() -> Bool {
      let r = rows().suffix(2).map { $0[field("zoom")] }
      return r.count == 2 && r[0] == r[1]
    }
    sv.springMagnification(to: 0.5, centeredAt: sv.contentView.bounds.center)
    d.later(1.2) {
      if !zoomsChanged(since: 0) { finish(name, "a spring's zoom kept \(rows().count) frames") }
      if !restedLast() { finish(name, "no frame after the spring rested") }
      let ts = rows().map { $0[0]! }
      if ts != ts.sorted() { finish(name, "frames out of order") }
      let n = rows().count
      NSAnimationContext.runAnimationGroup { c in
        c.duration = 0.3
        sv.animator().magnification = 1
      }
      d.later(1.0) {
        if !zoomsChanged(since: n) { finish(name, "an animated zoom, as a two-finger double tap makes, kept no frames") }
        let m = rows().count
        d.window.setContentSize(NSSize(width: 1000, height: 700))
        d.later(0.5) {
          guard let last = rows().last, rows().count > m else { finish(name, "a resize kept no frame") }
          let w = sv.contentView.frame.width
          if last[field("knobHAt")] == nil || last[field("knobVAt")] == nil { finish(name, "no knob places in the frames") }
          if abs((last[field("viewW")] ?? 0) - w) > 0.5 { finish(name, "frames are in points at a backing scale of \(d.window.backingScaleFactor): viewW \(last[field("viewW")] ?? -1), the view \(w) pt") }
          finish(name, nil)
        }
      }
    }
  }
}

extension SelfTest {
  /// An event the app takes from its queue reaches the recording though nothing dispatches it, as NSScrollView takes a
  /// pinch's later events itself, past monitors and sendEvent: the owner's fast pinches on 2026-11-14 lost their ends so.
  @MainActor fileprivate static func takenEvents(_ d: Driver) {
    let name = "taken-events"
    // in front, as the window server routes a posted scroll to the window under the cursor
    NSApp.activate(ignoringOtherApps: true)
    d.window.orderFrontRegardless()
    d.later(0.5) {
      let p = d.window.convertPoint(toScreen: NSPoint(x: d.window.frame.width / 2, y: d.window.frame.height / 2))
      guard let ev = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: -40, wheel2: 0, wheel3: 0) else {
        finish(name, "no scroll event made")
      }
      ev.location = CGPoint(x: p.x, y: (NSScreen.screens.first?.frame.maxY ?? 0) - p.y)
      // through the window server, which gives it its window; taken here before the run loop can dispatch it. Posting
      // needs Accessibility for the app that runs the check.
      CGWarpMouseCursorPosition(ev.location)
      ev.post(tap: .cghidEventTap)
      guard let taken = NSApp.nextEvent(matching: .scrollWheel, until: Date(timeIntervalSinceNow: 2), inMode: .eventTracking, dequeue: true) else {
        finish(name, "the posted scroll never came off the queue: active \(NSApp.isActive), key \(d.window.isKeyWindow)")
      }
      if taken.window !== d.window { finish(name, "the scroll came off the queue for \(taken.window.map { "window \($0.windowNumber)" } ?? "no window"), not \(d.window.windowNumber)") }
      d.later(0.5) {
        let dy = Flight.frameFields.firstIndex(of: "wheelDY")!
        let rows = d.canvas.core.flight.recording().frames?.rows ?? []
        finish(name, rows.contains { ($0[dy] ?? 0) != 0 } ? nil : "a scroll taken from the queue never reached the recording: \(rows.count) frames")
      }
    }
  }
}

extension SelfTest {
  /// The owner's pinch in past 200 %, as the reference app recorded it, replayed: it zooms about where the fingers were,
  /// as AppKit zooms about the cursor, and the recording keeps where they were, as a replayed event's place is on screen.
  @MainActor fileprivate static func replay(_ d: Driver) {
    let name = "replay"
    let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../ReferenceTests/pinch-in-past-max.json")
    guard let data = try? Data(contentsOf: fixture), let s = try? JSONDecoder().decode(Replay.Stroke.self, from: data) else { finish(name, "can’t read \(fixture.path)") }
    d.window.setContentSize(Replay.stage)
    // off the screen's origin, where a place on screen and in the window differ
    d.window.setFrameOrigin(NSPoint(x: 120, y: 40))
    // where a replay left it, far from the pinch
    CGWarpMouseCursorPosition(CGPoint(x: 5, y: 5))
    d.later(0.5) {
      Replay.start(s, d.wc)
      Replay.play(s, d.wc) { n in
        if n != s.raw.count { finish(name, "handed \(n) of \(s.raw.count) events") }
        Replay.rested(d.canvas.core.flight, within: 10) { rested in
          if !rested { finish(name, "the view never rested") }
          let rows = d.canvas.core.flight.recording().frames?.rows ?? []
          let f = { (k: String) in Flight.frameFields.firstIndex(of: k)! }
          let pinch = rows.filter { ($0[f("magnify")] ?? 0) != 0 }
          guard let first = pinch.first, let last = rows.last else { finish(name, "no pinch in \(rows.count) frames") }
          if abs((last[f("zoom")] ?? 0) - 2) > 0.001 { finish(name, "rested at \(last[f("zoom")] ?? 0), not 2") }
          // the board point under the fingers, which a pinch about them keeps
          let under = { (r: [Double?]) in NSPoint(x: r[f("camX")]! + r[f("px")]! / r[f("zoom")]!, y: r[f("camY")]! + r[f("py")]! / r[f("zoom")]!) }
          let p0 = under(first)
          let drift = pinch.map { r in max(abs(under(r).x - p0.x), abs(under(r).y - p0.y)) }.max() ?? 0
          if drift > 3 { finish(name, "the board point under the fingers moved \(Int(drift)) pt as it pinched") }
          // a view that never rests, as the bounded board's that resized with its scrollers every 125 ms: once its ring
          // is full a recording keeps as many frames however many come
          let busy = Flight(frameSeconds: 0.5), values = [Double?](repeating: 0, count: Flight.frameFields.count - 1)
          let moving = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in busy.frame(values) }
          Replay.rested(busy, within: 2) { rested in
            moving.invalidate()
            finish(name, rested ? "a view still moving read as rested" : nil)
          }
        }
      }
    }
  }
}

extension SelfTest {
  /// The recording marks a pinch's begin though its next event comes in the same frame, and a two-finger double tap as a
  /// gesture of one event, as the reference app does: from the owner's strokes, a pinch's first four events and a double
  /// tap's. Without either, the rules over frames found no start to align a stroke with the reference's at.
  @MainActor fileprivate static func gestureMarks(_ d: Driver) {
    let name = "gesture-marks"
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../scripts/selftest/gesture-marks.json")
    struct Events: Decodable { let pinch: [String]; let doubleTap: String }
    guard let data = try? Data(contentsOf: url), let events = try? JSONDecoder().decode(Events.self, from: data), let frames = d.wc.scrollView.frames else {
      finish(name, "can’t read \(url.path)")
    }
    let event = { (s: String) in Data(base64Encoded: s).flatMap { CGEvent(withDataAllocator: nil, data: $0 as CFData) }.flatMap { NSEvent(cgEvent: $0) } }
    let gestures = { () -> [Double] in
      let g = Flight.frameFields.firstIndex(of: "gesture")!
      return (d.canvas.core.flight.recording().frames?.rows ?? []).compactMap { $0[g] ?? nil }
    }
    // all in one frame, as a fast pinch's come
    for s in events.pinch { event(s).map(frames.observe) }
    d.later(0.3) {
      if !gestures().contains(1) { finish(name, "no frame marks the pinch's begin: \(gestures())") }
      let n = gestures().count
      event(events.doubleTap).map(frames.observe)
      d.later(0.3) {
        if !gestures().dropFirst(n).contains(3) { finish(name, "no frame marks the double tap: \(gestures().dropFirst(n))") }
        // a scroll that may begin and never does, as the owner's pinch-in-past-max-5 ended: the view is still
        event(events.pinch[0]).map(frames.observe)
        d.later(1.0) {
          let m = gestures().count
          d.later(0.5) {
            finish(name, gestures().count == m ? nil : "a scroll that never began kept \(gestures().count - m) frames in half a second of a still view")
          }
        }
      }
    }
  }
}

extension SelfTest {
  /// Zoomed out until the board takes in all it shows, with scrollers that take room as this Mac's do, the view comes
  /// to rest: replayed pinches left it resizing with its scrollers every 125 ms for good, its board sized each time
  /// for the view's other size.
  @MainActor fileprivate static func boundedRests(_ d: Driver) {
    let name = "bounded-rests"
    let sv = d.wc.scrollView
    sv.scrollerStyle = .legacy
    d.wc.place(origin: d.canvas.bounds.origin, zoom: 0.28)
    let sizes = { () -> [[Double?]] in
      let f = Flight.frameFields, rows = d.canvas.core.flight.recording().frames?.rows ?? []
      return rows.map { r in ["viewW", "viewH", "boardW", "boardH"].map { r[f.firstIndex(of: $0)!] } }
    }
    d.later(1.5) {
      let n = sizes().count
      d.later(1.0) {
        let since = Array(sizes().dropFirst(n))
        finish(name, Set(since.map { "\($0)" }).count > 1 ? "the view and board kept resizing at rest: \(since.count) frames in a second, \(Set(since.map { "\($0)" }).sorted().joined(separator: " / "))" : nil)
      }
    }
  }
}

private extension NSRect {
  var center: NSPoint { NSPoint(x: midX, y: midY) }
}

extension SelfTest {
  /// Nothing on the board cross-fades as its cards change: a card added, turned and back, and deleted, none animates the
  /// cards' host layer, as AppKit's implicit actions did, fading the whole board in from its last frame (5c41379). The
  /// frames keep it, and -BreezyRecordingOut <json> keeps them, for the plant's fixture (scripts/test/mac-plants.test.ts).
  @MainActor fileprivate static func fades(_ d: Driver) {
    let name = "fades", c = d.canvas
    let steps: [(String, () -> Void)] = [
      ("adding a card", { d.model.perform("New") { $0.cards.append(Card(id: "new", x: 0, y: 240, w: 240, text: "New")) } }),
      ("turning a card", { c.turn("a") }),
      ("turning it back", { c.turn(nil) }),
      ("deleting a card", { d.model.perform("Delete") { $0.cards.removeAll { $0.id == "b" } } }),
    ]
    func run(_ i: Int) {
      guard i < steps.count else { return done() }
      steps[i].1()
      d.later(0.8) { run(i + 1) }
    }
    func done() {
      let r = c.core.flight.recording(), f = Flight.frameFields, k = f.firstIndex(of: "fading")!
      if let out = UserDefaults.standard.string(forKey: "BreezyRecordingOut") {
        try? JSONEncoder().encode(r).write(to: URL(fileURLWithPath: out))
      }
      let rows = r.frames?.rows ?? []
      if rows.count < steps.count { finish(name, "the frames kept \(rows.count) rows over \(steps.count) changes to the cards") }
      let fading = rows.filter { ($0[k] ?? 0) > 0 }
      if !fading.isEmpty { finish(name, "the cards' host layer animated in \(fading.count) of \(rows.count) frames: the board cross-faded") }
      finish(name, nil)
    }
    d.later(0.5) { run(0) }
  }
}
