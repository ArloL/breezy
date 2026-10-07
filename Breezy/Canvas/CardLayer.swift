import AppKit
import BreezyKit

/// A card on the canvas. The sheet, its folded corner and the text are drawn at `contentsScale`,
/// which the canvas sets from the zoom; shadow and selection ring are layer properties.
final class CardLayer: CALayer {
  struct Look: Equatable {
    var card: Card
    var back: Bool
    var editing: Bool
    var dark: Bool

    init(card: Card, back: Bool, editing: Bool, dark: Bool) {
      // where the card sits does not change how it looks
      var c = card
      c.x = 0
      c.y = 0
      self.card = c
      self.back = back
      self.editing = editing
      self.dark = dark
    }
  }

  static var drawCount = 0

  private(set) var look: Look?
  private var appearance: NSAppearance?
  private let ring = CALayer()

  override init() {
    super.init()
    masksToBounds = false
    needsDisplayOnBoundsChange = true
    shadowColor = NSColor.black.cgColor
    ring.borderWidth = 2
    ring.cornerRadius = 4
    ring.isHidden = true
    addSublayer(ring)
  }

  override init(layer: Any) { super.init(layer: layer) }
  required init?(coder: NSCoder) { fatalError() }

  /// Only moves animate: a cross-faded redraw would hold two bitmaps per card.
  override func action(forKey event: String) -> CAAction? {
    event == "position" || event == "bounds" ? super.action(forKey: event) : NSNull()
  }

  func configure(_ look: Look, selected: Bool, scale: CGFloat, appearance: NSAppearance) {
    ring.isHidden = !selected
    guard look != self.look || scale != contentsScale else { return }
    if look.dark != self.look?.dark { ring.borderColor = Theme.cg(Theme.accent, in: appearance) }
    if look.back != self.look?.back {
      shadowOpacity = look.back ? 0.24 : 0.16
      shadowRadius = look.back ? 9 : 2
      shadowOffset = CGSize(width: 0, height: look.back ? 5 : 1)
    }
    self.look = look
    self.appearance = appearance
    // let the old bitmap go before the new one is drawn, rather than holding both
    if scale != contentsScale { contents = nil }
    contentsScale = scale
    setNeedsLayout()
    setNeedsDisplay()
  }

  func recycle() {
    look = nil
    contents = nil
    removeFromSuperlayer()
  }

  private var ear: CGFloat {
    guard let look else { return 0 }
    if look.back { return 24 }
    return (look.card.notes ?? "").isEmpty ? 0 : 16
  }

  /// The sheet with its bottom-right corner folded away, in y-down coordinates when `yDown`.
  private func outline(yDown: Bool) -> CGPath {
    let w = bounds.width, h = bounds.height, e = ear
    let pts: [CGPoint] = [CGPoint(x: 0, y: 0), CGPoint(x: w, y: 0), CGPoint(x: w, y: h - e), CGPoint(x: w - e, y: h), CGPoint(x: 0, y: h)]
    let path = CGMutablePath()
    path.addLines(between: pts.map { yDown ? $0 : CGPoint(x: $0.x, y: h - $0.y) })
    path.closeSubpath()
    return path
  }

  override func layoutSublayers() {
    super.layoutSublayers()
    ring.frame = bounds.insetBy(dx: -4, dy: -4)
    shadowPath = outline(yDown: contentsAreFlipped())
  }

  override func draw(in ctx: CGContext) {
    guard let look, let appearance else { return }
    Self.drawCount += 1
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
    if !contentsAreFlipped() {
      ctx.translateBy(x: 0, y: bounds.height)
      ctx.scaleBy(x: 1, y: -1)
    }
    appearance.performAsCurrentDrawingAppearance {
      let tint = Theme.tint(look.card.color)
      ctx.addPath(outline(yDown: true))
      ctx.setFillColor(tint.cgColor)
      ctx.fillPath()
      if ear > 0 {
        let flap = NSBezierPath()
        flap.move(to: NSPoint(x: bounds.maxX - ear, y: bounds.maxY))
        flap.line(to: NSPoint(x: bounds.maxX, y: bounds.maxY - ear))
        flap.line(to: NSPoint(x: bounds.maxX - ear, y: bounds.maxY - ear))
        flap.close()
        (tint.blended(withFraction: 0.12, of: .black) ?? tint).setFill()
        flap.fill()
      }
      if look.back {
        Theme.hairline.setFill()
        var y = Typo.backPad + Typo.line - 1
        while y < bounds.height - Typo.backPad {
          NSRect(x: Typo.backPad, y: y, width: bounds.width - 2 * Typo.backPad, height: 1).fill()
          y += Typo.line
        }
        let s = Typo.back(text: look.card.text, notes: look.editing ? "" : (look.card.notes ?? ""), placeholder: !look.editing)
        s.draw(with: bounds.insetBy(dx: Typo.backPad, dy: Typo.backPad), options: [.usesLineFragmentOrigin])
      } else if !look.editing {
        Typo.front(look.card.text).draw(with: bounds.insetBy(dx: Typo.padX, dy: Typo.padY), options: [.usesLineFragmentOrigin])
      }
    }
    NSGraphicsContext.restoreGraphicsState()
  }
}
