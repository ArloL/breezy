import AppKit
import BreezyKit

enum Typo {
  static let size: CGFloat = 16
  static let line = CGFloat(Metrics.grid)
  static let padX: CGFloat = 16
  static let padY = line / 2
  static let backPad = line
  static let body = NSFont.systemFont(ofSize: size)
  static let title = NSFont.systemFont(ofSize: size, weight: .semibold)
  static let laneFont = NSFont.systemFont(ofSize: size, weight: .semibold)

  static func attrs(_ font: NSFont, _ color: NSColor, truncate: Bool = false) -> [NSAttributedString.Key: Any] {
    let p = NSMutableParagraphStyle()
    p.minimumLineHeight = line
    p.maximumLineHeight = line
    if truncate { p.lineBreakMode = .byTruncatingTail }
    // TextKit puts the extra leading above the glyphs; this centres them in the line
    let offset = (line - (font.ascender - font.descender)) / 2 - 1
    return [.font: font, .foregroundColor: color, .paragraphStyle: p, .baselineOffset: offset]
  }

  static let bodyAttrs = attrs(body, Theme.ink2)
  static let notesAttrs = attrs(body, Theme.ink)
  static let titleAttrs = attrs(title, Theme.ink)

  /// First line is the title, the rest is the body.
  static func styleFront(_ s: NSMutableAttributedString) {
    let ns = s.string as NSString
    s.setAttributes(bodyAttrs, range: NSRange(location: 0, length: ns.length))
    let end = ns.range(of: "\n").location
    s.setAttributes(titleAttrs, range: NSRange(location: 0, length: end == NSNotFound ? ns.length : end))
  }

  /// Whether `s` is styled as `styleFront` would style it; typing usually keeps it so.
  static func isStyledFront(_ s: NSAttributedString) -> Bool {
    let ns = s.string as NSString
    let end = ns.range(of: "\n").location
    let t = end == NSNotFound ? ns.length : end
    return uses(title, s, NSRange(location: 0, length: t)) && uses(body, s, NSRange(location: t, length: ns.length - t))
  }

  private static func uses(_ font: NSFont, _ s: NSAttributedString, _ range: NSRange) -> Bool {
    var ok = true
    s.enumerateAttribute(.font, in: range) { v, _, stop in
      if v as? NSFont != font {
        ok = false
        stop.pointee = true
      }
    }
    return ok
  }

  static func front(_ text: String) -> NSAttributedString {
    let s = NSMutableAttributedString(string: text)
    styleFront(s)
    return s
  }

  /// The back: the card's title as a heading line, then the notes.
  static func back(text: String, notes: String, placeholder: Bool) -> NSAttributedString {
    let heading = String(text.prefix { $0 != "\n" })
    let s = NSMutableAttributedString(string: heading + "\n", attributes: titleAttrs)
    if notes.isEmpty && placeholder {
      s.append(NSAttributedString(string: "Double-click to write on the back", attributes: attrs(body, Theme.ink3)))
    } else {
      s.append(NSAttributedString(string: notes, attributes: notesAttrs))
    }
    return s
  }

  static func laneTitle(_ title: String) -> NSAttributedString {
    var a = attrs(laneFont, Theme.ink2, truncate: true)
    a[.kern] = size * 0.08
    return NSAttributedString(string: title.uppercased(), attributes: a)
  }
}

/// Card heights, measured with TextKit and cached by text and width.
enum TextMetrics {
  private static var cache: [String: CGFloat] = [:]

  /// A trailing newline counts as a line, as the editor shows it.
  static func frontHeight(_ text: String, width: CGFloat) -> CGFloat {
    cached("f|\(width)|\(text)") { lines(Typo.front(text), width: width - 2 * Typo.padX) * Typo.line + 2 * Typo.padY }
  }

  static func backHeight(_ card: Card) -> CGFloat {
    let notes = card.notes ?? ""
    return cached("b|\(card.text.prefix { $0 != "\n" })|\(notes)") {
      let s = Typo.back(text: card.text, notes: notes, placeholder: true)
      let h = lines(s, width: CGFloat(Metrics.backWidth) - 2 * Typo.backPad) * Typo.line + 2 * Typo.backPad
      return max(CGFloat(Metrics.backMinHeight), h)
    }
  }

  /// A laid-out copy of `s`; the caller keeps all three alive while using them.
  static func layout(_ s: NSAttributedString, width: CGFloat) -> (NSTextStorage, NSLayoutManager, NSTextContainer) {
    let storage = NSTextStorage(attributedString: s)
    let manager = NSLayoutManager()
    let container = NSTextContainer(size: NSSize(width: width, height: .greatestFiniteMagnitude))
    container.lineFragmentPadding = 0
    manager.addTextContainer(container)
    storage.addLayoutManager(manager)
    manager.ensureLayout(for: container)
    return (storage, manager, container)
  }

  /// One text system for all measuring, rather than a new one per card.
  private static let measurer: (NSTextStorage, NSLayoutManager, NSTextContainer) = {
    let container = NSTextContainer()
    container.lineFragmentPadding = 0
    let manager = NSLayoutManager()
    manager.addTextContainer(container)
    let storage = NSTextStorage()
    storage.addLayoutManager(manager)
    return (storage, manager, container)
  }()

  private static func lines(_ s: NSAttributedString, width: CGFloat) -> CGFloat {
    let (storage, manager, container) = measurer
    container.size = NSSize(width: width, height: .greatestFiniteMagnitude)
    storage.setAttributedString(s)
    manager.ensureLayout(for: container)
    return max(1, (manager.usedRect(for: container).height / Typo.line).rounded(.up))
  }

  private static func cached(_ key: String, _ measure: () -> CGFloat) -> CGFloat {
    if let h = cache[key] { return h }
    if cache.count > 10_000 { cache.removeAll() }
    let h = measure()
    cache[key] = h
    return h
  }
}
