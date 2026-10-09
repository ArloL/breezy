import AppKit
import BreezyKit
import CoreVideo
import IOSurface

/// A card on the canvas. The sheet, its folded corner and the text are drawn at `contentsScale`,
/// which the canvas sets from the zoom; shadow and ring (selection, others' holds and selections) are layer properties. The canvas
/// puts the layer on whole pixels, with bounds of whole pixels: the bitmap then shows unscaled,
/// as sharp as the card's editor.
final class CardLayer: CALayer {
  struct Look: Equatable {
    var card: Card
    var back: Bool
    var editing: Bool
    var dark: Bool

    init(card: Card, back: Bool, editing: Bool, dark: Bool) {
      // where the card sits does not change how it looks, nor the text its editor shows
      var c = card
      c.x = 0
      c.y = 0
      if editing && back { c.notes = nil }
      if editing && !back { c.text = "" }
      self.card = c
      self.back = back
      self.editing = editing
      self.dark = dark
    }
  }

  /// Everything a card's bitmap depends on, so it can be drawn on any thread.
  struct Input: Equatable {
    var look: Look
    var size: CGSize
    var scale: CGFloat
    var appearance: NSAppearance

    var ear: CGFloat { look.back ? 24 : (look.card.notes ?? "").isEmpty ? 0 : 16 }
  }

  /// The outline around a card: the accent for this Mac's selection, a person's colour for what they hold or select.
  struct Ring: Equatable {
    var colour: CGColor
    var width: CGFloat
  }

  static var drawCount = 0

  private(set) var look: Look?
  /// The card's size; the bounds round it up to whole pixels.
  private var size = CGSize.zero
  /// Where the canvas last put the card, before moving it to whole pixels.
  var rect: CGRect?
  private var appearance: NSAppearance?
  /// A bitmap drawn ahead, on another thread, for `display` to take if it still fits.
  var prepared: (Input, IOSurface?)?
  /// Being drawn off the main thread: `display` leaves it for then.
  var deferred = false
  /// Needs drawing only at a new scale, so its current bitmap can stand in meanwhile.
  private(set) var refining = false
  /// Raised by a drag: a little larger, with a deeper shadow.
  private(set) var lifted = false
  /// The ring, only while selected, held or selected by someone else: most cards never are, and a layer each is a layer
  /// more to commit and keep.
  private var ring: CALayer?

  override init() {
    super.init()
    masksToBounds = false
    needsDisplayOnBoundsChange = true
    shadowColor = NSColor.black.cgColor
  }

  override init(layer: Any) { super.init(layer: layer) }
  required init?(coder: NSCoder) { fatalError() }

  /// The canvas animates moves itself, with springs; a cross-faded redraw would hold two bitmaps per card.
  override func action(forKey event: String) -> CAAction? { NSNull() }

  func configure(_ look: Look, size: CGSize, ring: Ring?, scale: CGFloat, appearance: NSAppearance) {
    setRing(ring)
    guard look != self.look || size != self.size || scale != contentsScale else { return }
    let turning = look.back != self.look?.back
    // only the scale changed: the old bitmap, stretched, can show until the sharp one is drawn
    refining = look == self.look && size == self.size && appearance == self.appearance && contents != nil
    self.look = look
    self.size = size
    self.appearance = appearance
    if turning { setShadow(animated: false) }
    // otherwise let the old bitmap go before the new one is drawn, rather than holding both
    if scale != contentsScale && !refining { contents = nil }
    contentsScale = scale
    setNeedsLayout()
    setNeedsDisplay()
  }

  /// Lifts the card with a little pop, or puts it down.
  func setLifted(_ on: Bool, animated: Bool) {
    guard on != lifted else { return }
    lifted = on
    let from = presentation()?.transform ?? transform
    transform = on ? CATransform3DMakeScale(1.05, 1.05, 1) : CATransform3DIdentity
    setShadow(animated: animated)
    guard animated else { return }
    let a = Spring.lift.animation("transform")
    a.fromValue = NSValue(caTransform3D: from)
    a.toValue = NSValue(caTransform3D: transform)
    add(a, forKey: "lift")
  }

  private func setShadow(animated: Bool) {
    let back = look?.back == true
    let opacity: Float = lifted ? 0.26 : back ? 0.24 : 0.16
    let radius: CGFloat = lifted ? 18 : back ? 9 : 2
    let offset = CGSize(width: 0, height: lifted ? 10 : back ? 5 : 1)
    if animated {
      let p = presentation() ?? self
      for (key, from, to) in [("shadowOpacity", p.shadowOpacity as Any, opacity as Any), ("shadowRadius", p.shadowRadius, radius),
                              ("shadowOffset", NSValue(size: p.shadowOffset), NSValue(size: offset))] {
        let a = CABasicAnimation(keyPath: key)
        a.fromValue = from
        a.toValue = to
        a.duration = 0.2
        a.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
        add(a, forKey: key)
      }
    }
    shadowOpacity = opacity
    shadowRadius = radius
    shadowOffset = offset
  }

  private func setRing(_ r: Ring?) {
    guard let r else {
      ring?.removeFromSuperlayer()
      ring = nil
      return
    }
    let l = ring ?? CALayer()
    if ring == nil {
      l.cornerRadius = 4
      l.frame = CGRect(origin: .zero, size: size).insetBy(dx: -4, dy: -4)
      addSublayer(l)
      ring = l
    }
    l.borderWidth = r.width
    l.borderColor = r.colour
  }

  func recycle() {
    removeAllAnimations()
    transform = CATransform3DIdentity
    lifted = false
    deferred = false
    refining = false
    ring?.removeFromSuperlayer()
    ring = nil
    look = nil
    size = .zero
    rect = nil
    prepared = nil
    contents = nil
    removeFromSuperlayer()
  }

  /// What the bitmap would be drawn from now; nil for a recycled layer.
  var input: Input? {
    guard let look, let appearance else { return nil }
    return Input(look: look, size: size, scale: contentsScale, appearance: appearance)
  }

  /// The sheet with its bottom-right corner folded away, in y-down coordinates when `yDown`.
  private static func outline(_ size: CGSize, ear e: CGFloat, yDown: Bool) -> CGPath {
    let w = size.width, h = size.height
    let pts: [CGPoint] = [CGPoint(x: 0, y: 0), CGPoint(x: w, y: 0), CGPoint(x: w, y: h - e), CGPoint(x: w - e, y: h), CGPoint(x: 0, y: h)]
    let path = CGMutablePath()
    path.addLines(between: pts.map { yDown ? $0 : CGPoint(x: $0.x, y: h - $0.y) })
    path.closeSubpath()
    return path
  }

  override func layoutSublayers() {
    super.layoutSublayers()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    defer { CATransaction.commit() }
    ring?.frame = CGRect(origin: .zero, size: size).insetBy(dx: -4, dy: -4)
    shadowPath = Self.outline(size, ear: input?.ear ?? 0, yDown: contentsAreFlipped())
  }

  /// Shows a surface of its own, which Core Animation shows without a copy, instead of a backing
  /// store that holds more than one buffer per layer.
  override func display() {
    if deferred { return }
    let i = input
    if let p = prepared, p.0 == i {
      contents = p.1
    } else {
      contents = i.flatMap(Self.render)
      if i != nil { Self.drawCount += 1 }
    }
    prepared = nil
  }

  private static let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

  /// The card's bitmap; safe on any thread.
  static func render(_ i: Input) -> IOSurface? {
    let w = Int((i.size.width * i.scale).rounded(.up)), h = Int((i.size.height * i.scale).rounded(.up))
    guard w > 0, h > 0,
      let surface = IOSurface(properties: [.width: w, .height: h, .bytesPerElement: 4, .pixelFormat: kCVPixelFormatType_32BGRA])
    else { return nil }
    // by name: Core Animation reads it back for every new surface, and a name is short
    IOSurfaceSetValue(surface, kIOSurfaceColorSpace, CGColorSpace.sRGB)
    surface.lock(options: [], seed: nil)
    defer { surface.unlock(options: [], seed: nil) }
    guard let ctx = CGContext(data: surface.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: surface.bytesPerRow, space: colorSpace,
                              bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
    else { return nil }
    ctx.clear(CGRect(x: 0, y: 0, width: w, height: h))
    // y-down from the top pixel row, as the drawing below expects
    ctx.translateBy(x: 0, y: CGFloat(h))
    ctx.scaleBy(x: i.scale, y: -i.scale)
    paint(i, in: ctx)
    return surface
  }

  private static func paint(_ i: Input, in ctx: CGContext) {
    let look = i.look, bounds = CGRect(origin: .zero, size: i.size), ear = i.ear
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
    i.appearance.performAsCurrentDrawingAppearance {
      let tint = Theme.tint(look.card.color)
      ctx.addPath(outline(i.size, ear: ear, yDown: true))
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
