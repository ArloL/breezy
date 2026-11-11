import AppKit
import BreezyKit

/// The dot grid in screen space: one dot, repeated across and down by replicator layers, so a
/// scroll or zoom step only sets a spacing and nothing is drawn. The dots lie on the board's paper; past its edge,
/// seen only while the view is pulled there, is plain outside, as the web app's.
final class GridView: NSView {
  /// The board, in this view's points.
  private let paper = CALayer()
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
    paper.masksToBounds = true
    paper.addSublayer(rows)
    layer!.addSublayer(paper)
  }

  required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }
  override var wantsUpdateLayer: Bool { true }

  override func updateLayer() {
    layer?.backgroundColor = Theme.outside.cgColor
    paper.backgroundColor = Theme.paper.cgColor
    dot.backgroundColor = Theme.dot.cgColor
  }

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    needsDisplay = true
  }

  /// What of the view the paper covers.
  var paperFrame: NSRect { paper.isHidden ? .zero : paper.frame }

  /// origin: where the world's origin is in this view; board: the board, in this view's points.
  func update(origin: NSPoint, zoom: CGFloat, board: NSRect) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let shown = board.intersection(bounds.insetBy(dx: -1, dy: -1))
    paper.isHidden = shown.isEmpty
    paper.frame = shown.isEmpty ? .zero : shown
    rows.isHidden = zoom < 0.4
    let t = CGFloat(Metrics.grid) * zoom
    let fx = origin.x.truncatingRemainder(dividingBy: t)
    let fy = origin.y.truncatingRemainder(dividingBy: t)
    let frame = NSRect(x: fx - 2 * t, y: fy - 2 * t, width: bounds.width + 4 * t, height: bounds.height + 4 * t)
    rows.frame = frame.offsetBy(dx: -paper.frame.minX, dy: -paper.frame.minY)
    rows.instanceCount = Int((frame.height / t).rounded(.up))
    rows.instanceTransform = CATransform3DMakeTranslation(0, t, 0)
    columns.frame = NSRect(x: 0, y: 0, width: frame.width, height: t)
    columns.instanceCount = Int((frame.width / t).rounded(.up))
    columns.instanceTransform = CATransform3DMakeTranslation(t, 0, 0)
    dot.frame = NSRect(x: t / 2 - diameter / 2, y: t / 2 - diameter / 2, width: diameter, height: diameter)
    CATransaction.commit()
  }
}
