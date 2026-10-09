import AppKit
import BreezyKit

extension Person {
  var nsColour: NSColor { NSColor(hex: colour) }
}

/// What others do on one board, as the canvas draws it.
struct CanvasPresence: Equatable {
  struct Seen: Equatable {
    var key: String
    var person: Person
    var x: Double
    var y: Double
  }

  struct Typing: Equatable {
    var key: String
    var person: Person
    var caret: Caret
  }

  var taken: [String: Person] = [:]
  var seen: [String: Person] = [:]
  var overlay: [String: LiveFields] = [:]
  var cursors: [Seen] = []
  var carets: [Typing] = []
  var people: [Person] = []

  init() {}

  @MainActor init(_ live: Live?, board: String) {
    guard let live else { return }
    for id in live.taken { taken[id] = live.holder(of: id) }
    seen = live.selections(on: board)
    overlay = live.overlay(on: board)
    cursors = live.cursors(on: board).map { Seen(key: $0.key, person: $0.person, x: $0.cursor.x, y: $0.cursor.y) }
    carets = live.carets(on: board).map { Typing(key: $0.key, person: $0.person, caret: $0.caret) }
    people = live.people(on: board)
  }
}

/// Others over the board: their cursors with names, the names over what they hold, and their carets. In the canvas's
/// coordinates; cursors and names are scaled by 1 / zoom so that they keep their size.
final class PresenceView: NSView {
  struct Mark {
    enum Kind { case cursor, label, caret }
    var key: String
    var kind: Kind
    var person: Person
    /// A cursor's tip or a label's bottom left as the origin, or a caret's rect.
    var rect: NSRect
  }

  /// Each mark's layer, with the person it was made for: a new name or colour makes it again.
  private var marks: [String: (person: Person, layer: CALayer)] = [:]

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
  }

  required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  func show(_ shown: [Mark], zoom: CGFloat) {
    var live = Set<String>()
    for m in shown {
      live.insert(m.key)
      var isNew = marks[m.key] == nil
      if let old = marks[m.key], old.person != m.person {
        old.layer.removeFromSuperlayer()
        marks[m.key] = nil
        isNew = true
      }
      let l = marks[m.key]?.layer ?? make(m)
      marks[m.key] = (m.person, l)
      CATransaction.begin()
      // a cursor glides between updates; everything else jumps
      CATransaction.setDisableActions(isNew || m.kind != .cursor)
      CATransaction.setAnimationDuration(0.06)
      CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .linear))
      switch m.kind {
      case .caret:
        l.frame = m.rect
      case .cursor, .label:
        l.transform = CATransform3DMakeScale(1 / zoom, 1 / zoom, 1)
        l.position = m.rect.origin
      }
      CATransaction.commit()
    }
    for (k, v) in marks where !live.contains(k) {
      v.layer.removeFromSuperlayer()
      marks[k] = nil
    }
  }

  private func make(_ m: Mark) -> CALayer {
    let colour = m.person.nsColour.cgColor
    let l: CALayer
    switch m.kind {
    case .caret:
      l = CALayer()
      l.backgroundColor = colour
    case .cursor:
      l = CALayer()
      l.anchorPoint = .zero
      l.bounds = CGRect(x: 0, y: 0, width: 18, height: 18)
      let arrow = CAShapeLayer()
      let p = CGMutablePath()
      p.addLines(between: [CGPoint(x: 2, y: 1.5), CGPoint(x: 13.5, y: 8), CGPoint(x: 8.2, y: 9.2), CGPoint(x: 5.6, y: 14.5)])
      p.closeSubpath()
      arrow.path = p
      arrow.fillColor = colour
      arrow.strokeColor = .white
      arrow.lineWidth = 1.2
      arrow.lineJoin = .round
      l.addSublayer(arrow)
      let tag = Self.tag(m.person.name, colour)
      tag.frame.origin = CGPoint(x: 14, y: 16)
      l.addSublayer(tag)
    case .label:
      l = Self.tag(m.person.name, colour)
      l.anchorPoint = CGPoint(x: 0, y: 1)
    }
    layer!.addSublayer(l)
    return l
  }

  private static func tag(_ name: String, _ colour: CGColor) -> CATextLayer {
    let s = NSAttributedString(string: name, attributes: [.font: NSFont.systemFont(ofSize: 12, weight: .semibold), .foregroundColor: NSColor.white])
    let t = CATextLayer()
    t.string = s
    t.backgroundColor = colour
    t.cornerRadius = 6
    t.alignmentMode = .center
    t.contentsScale = NSScreen.main?.backingScaleFactor ?? 2
    t.frame = CGRect(x: 0, y: 0, width: ceil(s.size().width) + 12, height: 18)
    return t
  }
}
