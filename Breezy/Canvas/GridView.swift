import AppKit
import BreezyKit

/// The dot grid in screen space: one dot, repeated across and down by replicator layers, so a
/// scroll or zoom step only sets a spacing and nothing is drawn.
final class GridView: NSView {
  private let rows = CAReplicatorLayer()
  private let columns = CAReplicatorLayer()
  private let dot = CALayer()
  private let diameter: CGFloat = 1.8

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    dot.cornerRadius = diameter / 2
    columns.addSublayer(dot)
    rows.addSublayer(columns)
    layer!.addSublayer(rows)
  }

  required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }
  override var wantsUpdateLayer: Bool { true }

  override func updateLayer() {
    layer?.backgroundColor = Theme.paper.cgColor
    dot.backgroundColor = Theme.dot.cgColor
  }

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    needsDisplay = true
  }

  /// origin: the canvas point at the top left of the view.
  func update(origin: NSPoint, zoom: CGFloat) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    rows.isHidden = zoom < 0.4
    let t = CGFloat(Metrics.grid) * zoom
    let fx = (-origin.x * zoom).truncatingRemainder(dividingBy: t)
    let fy = (-origin.y * zoom).truncatingRemainder(dividingBy: t)
    let frame = NSRect(x: fx - 2 * t, y: fy - 2 * t, width: bounds.width + 4 * t, height: bounds.height + 4 * t)
    rows.frame = frame
    rows.instanceCount = Int((frame.height / t).rounded(.up))
    rows.instanceTransform = CATransform3DMakeTranslation(0, t, 0)
    columns.frame = NSRect(x: 0, y: 0, width: frame.width, height: t)
    columns.instanceCount = Int((frame.width / t).rounded(.up))
    columns.instanceTransform = CATransform3DMakeTranslation(t, 0, 0)
    dot.frame = NSRect(x: t / 2 - diameter / 2, y: t / 2 - diameter / 2, width: diameter, height: diameter)
    CATransaction.commit()
  }
}
