import AppKit
import BreezyKit

/// Cards and lanes as accessibility elements: for VoiceOver, and for the UI tests, which find
/// them by identifier (`card`, `lane`), label (the title line) and value (`front` or `back`).
extension CanvasView {
  override func isAccessibilityElement() -> Bool { false }
  override func accessibilityRole() -> NSAccessibility.Role? { .group }
  override func accessibilityLabel() -> String? { "Board" }

  override func accessibilityChildren() -> [Any]? {
    board.lanes.map { element("lane", label: $0.title, value: nil, frame: doc($0.rect)) }
      + board.cards.map { c in
        element("card", label: String(c.text.prefix { $0 != "\n" }), value: c.id == turned ? "back" : "front", frame: doc(drawnRect(c)))
      }
  }

  private func element(_ id: String, label: String, value: String?, frame: NSRect) -> NSAccessibilityElement {
    let e = NSAccessibilityElement()
    e.setAccessibilityParent(self)
    e.setAccessibilityRole(.group)
    e.setAccessibilityIdentifier(id)
    e.setAccessibilityLabel(label)
    e.setAccessibilityValue(value)
    e.setAccessibilityFrameInParentSpace(frame)
    return e
  }
}
