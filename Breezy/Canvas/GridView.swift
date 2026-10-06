import AppKit
import BreezyKit

/// The dot grid in screen space: one pattern layer, moved and re-tiled as the board scrolls and
/// zooms, so no part of the canvas needs a backing store.
final class GridView: NSView {
  private let dots = CALayer()
  private var tile: CGFloat = 0
  private var origin = NSPoint.zero
  private var zoom: CGFloat = 1

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer!.addSublayer(dots)
  }

  required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }
  override var wantsUpdateLayer: Bool { true }

  override func updateLayer() {
    layer?.backgroundColor = Theme.paper.cgColor
    tile = 0
    update(origin: origin, zoom: zoom)
  }

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    needsDisplay = true
  }

  /// origin: the canvas point at the top left of the view.
  func update(origin: NSPoint, zoom: CGFloat) {
    self.origin = origin
    self.zoom = zoom
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    dots.isHidden = zoom < 0.4
    let t = CGFloat(Metrics.grid) * zoom
    if t != tile {
      tile = t
      dots.backgroundColor = pattern(tile: t)
    }
    let fx = (-origin.x * zoom).truncatingRemainder(dividingBy: t)
    let fy = (-origin.y * zoom).truncatingRemainder(dividingBy: t)
    dots.frame = NSRect(x: fx - 2 * t, y: fy - 2 * t, width: bounds.width + 4 * t, height: bounds.height + 4 * t)
    CATransaction.commit()
  }

  private func pattern(tile: CGFloat) -> CGColor {
    let appearance = effectiveAppearance
    let image = NSImage(size: NSSize(width: tile, height: tile), flipped: false) { r in
      appearance.performAsCurrentDrawingAppearance {
        Theme.dot.setFill()
        let d: CGFloat = 1.8
        NSBezierPath(ovalIn: NSRect(x: r.midX - d / 2, y: r.midY - d / 2, width: d, height: d)).fill()
      }
      return true
    }
    return NSColor(patternImage: image).cgColor
  }
}
