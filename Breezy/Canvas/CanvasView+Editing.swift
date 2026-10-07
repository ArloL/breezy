import AppKit
import BreezyKit

struct CardEditing {
  var id: String
  var back: Bool
  var view: EditorTextView
  var name: String
  let undo = UndoManager()
}

extension CanvasView {
  func doubleClick(at p: NSPoint) {
    if let c = card(at: p) { return beginEdit(c.id) }
    if let l = lane(at: p) {
      if p.y < l.y + Metrics.laneHeader { return beginRename(l.id) }
      if p.x > l.x + l.w - 20 && p.y > l.y + l.h - 20 { return }
    }
    model.begin()
    var id = ""
    model.update { id = $0.addCard(x: Double(p.x), y: Double(p.y)) }
    model.update { $0.gravity(height) }
    selection = [id]
    beginEdit(id, name: "New Card")
  }

  func editorFrame(_ c: Card, back: Bool) -> NSRect {
    // a text view sets its lines 1 pt lower than the card's string drawing; text must not jump
    let r = doc(drawnRect(c)).offsetBy(dx: 0, dy: -1)
    guard back else { return r.insetBy(dx: Typo.padX, dy: Typo.padY) }
    let pad = Typo.backPad
    return NSRect(x: r.minX + pad, y: r.minY + pad + Typo.line, width: r.width - 2 * pad, height: r.height - 2 * pad - Typo.line)
  }

  /// Edits the side of card `id` facing up; the session is one undo step named `name`.
  func beginEdit(_ id: String, name: String = "Edit Card") {
    guard let c = board.card(id) else { return }
    model.begin()
    let back = turned == id
    // TextKit 1: lighter per keystroke than TextKit 2, and it breaks lines as TextMetrics measures
    let tv = EditorTextView(usingTextLayoutManager: false)
    tv.frame = editorFrame(c, back: back)
    tv.isRichText = false
    tv.drawsBackground = false
    tv.textContainerInset = .zero
    tv.textContainer?.lineFragmentPadding = 0
    tv.isVerticallyResizable = false
    tv.allowsUndo = true
    tv.insertionPointColor = Theme.accent
    tv.string = back ? (c.notes ?? "") : c.text
    if back {
      tv.textStorage?.setAttributes(Typo.notesAttrs, range: NSRange(location: 0, length: (tv.string as NSString).length))
      tv.typingAttributes = Typo.notesAttrs
    } else {
      Typo.styleFront(tv.textStorage!)
      tv.typingAttributes = c.text.contains("\n") ? Typo.bodyAttrs : Typo.titleAttrs
    }
    tv.delegate = self
    tv.onFinish = { [weak self] in
      guard let self else { return }
      endEditing()
      window?.makeFirstResponder(self)
    }
    tv.onTab = { [weak self] in self?.switchSide() }
    addSubview(tv, positioned: .below, relativeTo: marquee)
    editing = CardEditing(id: id, back: back, view: tv, name: name)
    layoutCards()
    window?.makeFirstResponder(tv)
    tv.setSelectedRange(NSRange(location: (tv.string as NSString).length, length: 0))
  }

  /// Typing undoes within the session; the session itself is one step on the board's history.
  func undoManager(for view: NSTextView) -> UndoManager? { editing?.undo }

  func textDidChange(_ notification: Notification) {
    guard let e = editing else { return }
    let text = e.view.string
    if e.back {
      model.update { $0.setNotes(e.id, text) }
    } else {
      // restyling invalidates the editor's layout, so only after a line break moved
      if !e.view.hasMarkedText(), !Typo.isStyledFront(e.view.textStorage!) {
        let sel = e.view.selectedRanges
        Typo.styleFront(e.view.textStorage!)
        e.view.selectedRanges = sel
        let titleEnd = (text as NSString).range(of: "\n").location
        e.view.typingAttributes = e.view.selectedRange().location <= titleEnd ? Typo.titleAttrs : Typo.bodyAttrs
      }
      if let c = board.card(e.id) { heights[e.id] = Double(TextMetrics.frontHeight(text, width: CGFloat(c.w))) }
      model.update {
        $0.setText(e.id, text)
        $0.gravity(height)
      }
    }
    if let c = board.card(e.id) { e.view.frame = editorFrame(c, back: e.back) }
  }

  func textDidEndEditing(_ notification: Notification) {
    if (notification.object as AnyObject?) === editing?.view { endEditing() }
  }

  /// Ends the card edit or lane rename in progress, if any.
  func endEditing() {
    if let r = renaming {
      renaming = nil
      r.field.removeFromSuperview()
      laneViews[r.id]?.renaming = false
      let t = r.field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
      model.update { $0.setLaneTitle(r.id, t.isEmpty ? "Lane" : t) }
      model.end("Rename Lane")
    }
    guard let e = editing else { return }
    editing = nil
    e.view.removeFromSuperview()
    model.update { $0.finishEdit(e.id) }
    model.update { $0.gravity(height) }
    model.end(e.name)
    layoutCards()
  }

  /// Tab: turns the card over and goes on editing the other side, in the same undo step.
  func switchSide() {
    guard let e = editing else { return }
    editing = nil
    e.view.removeFromSuperview()
    turn(e.back ? nil : e.id)
    beginEdit(e.id, name: e.name)
  }

  func beginRename(_ id: String) {
    guard let v = laneViews[id], let l = board.lane(id) else { return }
    model.begin()
    let f = NSTextField(frame: LaneView.headerTextRect(width: v.bounds.width))
    f.stringValue = l.title
    f.font = Typo.laneFont
    f.textColor = Theme.ink
    f.isBordered = false
    f.drawsBackground = false
    f.focusRingType = .none
    f.delegate = self
    v.renaming = true
    v.addSubview(f)
    renaming = (id, f)
    window?.makeFirstResponder(f)
  }

  func controlTextDidEndEditing(_ obj: Notification) {
    guard renaming != nil else { return }
    endEditing()
    window?.makeFirstResponder(self)
  }
}
