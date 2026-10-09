import AppKit
import BreezyKit

/// Fill and border are layer properties; only the header and the grip have backing stores.
final class LaneView: NSView {
  var lane: Lane { didSet { if lane.title != oldValue.title { header.title = renaming ? "" : lane.title } } }
  var selected = false { didSet { if selected != oldValue { needsDisplay = true } } }
  var ringColour: NSColor? { didSet { if ringColour != oldValue { needsDisplay = true } } }
  var renaming = false { didSet { header.title = renaming ? "" : lane.title } }
  private let header = LaneHeaderView()
  private let grip = GripView()

  init(lane: Lane) {
    self.lane = lane
    super.init(frame: .zero)
    wantsLayer = true
    layer?.cornerRadius = 6
    header.title = lane.title
    addSubview(header)
    addSubview(grip)
  }

  required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }
  override var wantsUpdateLayer: Bool { true }

  /// Clicks go to the canvas, except into the rename field.
  override func hitTest(_ point: NSPoint) -> NSView? {
    guard let hit = super.hitTest(point) else { return nil }
    return hit is NSText || hit is NSTextField ? hit : nil
  }

  override func updateLayer() {
    layer?.backgroundColor = Theme.laneFill.cgColor
    layer?.borderColor = (selected ? Theme.accent : ringColour ?? Theme.hairline).cgColor
    layer?.borderWidth = selected || ringColour != nil ? 2 : 1
  }

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    needsDisplay = true
    header.needsDisplay = true
    grip.needsDisplay = true
  }

  override func setFrameSize(_ newSize: NSSize) {
    super.setFrameSize(newSize)
    header.frame = NSRect(x: 0, y: 0, width: newSize.width, height: CGFloat(Metrics.laneHeader))
    grip.frame = NSRect(x: newSize.width - 20, y: newSize.height - 20, width: 20, height: 20)
  }

  static func headerTextRect(width: CGFloat) -> NSRect {
    NSRect(x: 16, y: (CGFloat(Metrics.laneHeader) - Typo.line) / 2, width: width - 32, height: Typo.line)
  }
}

final class LaneHeaderView: NSView {
  var title = "" { didSet { if title != oldValue { needsDisplay = true } } }

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layerContentsRedrawPolicy = .onSetNeedsDisplay
  }

  required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }

  override func draw(_ dirtyRect: NSRect) {
    Typo.laneTitle(title).draw(with: LaneView.headerTextRect(width: bounds.width), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    Theme.hairline.setFill()
    NSRect(x: 16, y: bounds.height - 1, width: bounds.width - 32, height: 1).fill()
  }
}

final class GripView: NSView {
  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layerContentsRedrawPolicy = .onSetNeedsDisplay
  }

  required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }

  override func draw(_ dirtyRect: NSRect) {
    let grip = NSBezierPath()
    for i in 1...3 {
      let d = CGFloat(i) * 4
      grip.move(to: NSPoint(x: bounds.maxX - 4 - d, y: bounds.maxY - 4))
      grip.line(to: NSPoint(x: bounds.maxX - 4, y: bounds.maxY - 4 - d))
    }
    Theme.ink3.setStroke()
    grip.lineWidth = 1
    grip.stroke()
  }
}
