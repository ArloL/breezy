import AppKit
import BreezyKit

extension NSToolbarItem.Identifier {
  static let newLane = Self("newLane")
  static let zoom = Self("zoom")
}

/// One board window: the toolbar, the scroll view with the canvas and, from Task 7, the dot grid
/// behind it.
final class BoardWindowController: NSWindowController, NSWindowDelegate, NSToolbarDelegate, NSMenuItemValidation {
  let canvas: CanvasView
  let scrollView = BoardScrollView()
  let zoomItem = NSToolbarItem(itemIdentifier: .zoom)
  private let zoomButton = ReadoutButton(title: "", target: nil, action: nil)
  private let grid = GridView()
  private var restored = false
  private let finder = NSTextFinder()
  private lazy var finderClient = BoardFinderClient(canvas: canvas)

  init(model: BoardModel) {
    canvas = CanvasView(model: model)
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.minSize = NSSize(width: 480, height: 320)
    super.init(window: window)
    window.delegate = self
    let toolbar = NSToolbar(identifier: "board")
    toolbar.delegate = self
    toolbar.displayMode = .iconAndLabel
    window.toolbar = toolbar
    window.toolbarStyle = .unified

    scrollView.hasHorizontalScroller = true
    scrollView.hasVerticalScroller = true
    scrollView.autohidesScrollers = true
    scrollView.allowsMagnification = true
    scrollView.minMagnification = 0.25
    scrollView.maxMagnification = 2
    scrollView.drawsBackground = false
    scrollView.contentView.drawsBackground = false
    scrollView.documentView = canvas
    let root = NSView()
    grid.autoresizingMask = [.width, .height]
    scrollView.autoresizingMask = [.width, .height]
    root.addSubview(grid)
    root.addSubview(scrollView)
    window.contentView = root
    grid.frame = root.bounds
    scrollView.frame = root.bounds
    scrollView.contentView.postsBoundsChangedNotifications = true
    NotificationCenter.default.addObserver(
      self, selector: #selector(viewMoved), name: NSView.boundsDidChangeNotification, object: scrollView.contentView)
    NotificationCenter.default.addObserver(
      self, selector: #selector(occlusionChanged), name: NSWindow.didChangeOcclusionStateNotification, object: window)
    scrollView.findBarPosition = .aboveContent
    finder.client = finderClient
    finder.findBarContainer = scrollView
    finder.isIncrementalSearchingEnabled = true
    finder.incrementalSearchingShouldDimContentView = true
    canvas.onBoardChange = { [weak self] in
      self?.finder.noteClientStringWillChange()
      self?.finderClient.invalidate()
    }
    DispatchQueue.main.async { [weak self] in
      if self?.restored == false { self?.fit() }
    }
  }

  required init?(coder: NSCoder) { fatalError() }

  func place(origin: NSPoint, zoom: CGFloat) {
    scrollView.magnification = zoom
    scrollView.contentView.scroll(to: origin)
    scrollView.reflectScrolledClipView(scrollView.contentView)
    viewMoved()
  }

  /// Out of sight, the board keeps no card bitmaps: the app is meant to stay open in the
  /// background. They are drawn again when the window shows.
  @objc func occlusionChanged() {
    guard let window else { return }
    if window.occlusionState.contains(.visible) {
      canvas.needsLayout = true
    } else {
      canvas.releaseCards()
      malloc_zone_pressure_relief(nil, 0)
    }
  }

  @objc func viewMoved() {
    let label = "\(Int((scrollView.magnification * 100).rounded())) %"
    zoomButton.readout = label
    grid.update(origin: scrollView.contentView.bounds.origin, zoom: scrollView.magnification)
    // a zoom step moves the bounds more than once; the cards follow once, when the frame is laid out
    canvas.needsLayout = true
    window?.invalidateRestorableState()
  }

  var centre: NSPoint {
    let r = scrollView.contentView.bounds
    return NSPoint(x: r.midX, y: r.midY)
  }

  @objc func zoomIn(_ sender: Any?) { scrollView.animator().setMagnification(scrollView.magnification * 1.25, centeredAt: centre) }
  @objc func zoomOut(_ sender: Any?) { scrollView.animator().setMagnification(scrollView.magnification / 1.25, centeredAt: centre) }
  @objc func actualSize(_ sender: Any?) { scrollView.animator().setMagnification(1, centeredAt: centre) }
  @objc func newLane(_ sender: Any?) { canvas.addLaneAtCentre() }

  func window(_ window: NSWindow, willEncodeRestorableState state: NSCoder) {
    let o = scrollView.contentView.bounds.origin
    state.encode(Double(o.x), forKey: "originX")
    state.encode(Double(o.y), forKey: "originY")
    state.encode(Double(scrollView.magnification), forKey: "zoom")
  }

  func window(_ window: NSWindow, didDecodeRestorableState state: NSCoder) {
    guard state.containsValue(forKey: "zoom") else { return }
    restored = true
    place(origin: NSPoint(x: state.decodeDouble(forKey: "originX"), y: state.decodeDouble(forKey: "originY")),
          zoom: state.decodeDouble(forKey: "zoom"))
  }

  override func performTextFinderAction(_ sender: Any?) {
    guard let tag = (sender as? NSValidatedUserInterfaceItem)?.tag, let action = NSTextFinder.Action(rawValue: tag) else { return }
    canvas.endEditing()
    finder.performAction(action)
  }

  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    if item.action == #selector(performTextFinderAction(_:)), let action = NSTextFinder.Action(rawValue: item.tag) {
      return finder.validateAction(action)
    }
    return true
  }

  /// Shows the whole board at no more than 100 %, or the origin when the board is empty.
  func fit() {
    var r = NSRect.null
    for c in canvas.board.cards { r = r.union(canvas.doc(canvas.frontRect(c))) }
    for l in canvas.board.lanes { r = r.union(canvas.doc(l.rect)) }
    let size = scrollView.contentView.bounds.size
    guard !r.isNull else {
      return place(origin: NSPoint(x: CanvasView.origin - size.width / 2, y: CanvasView.origin - size.height / 2), zoom: 1)
    }
    scrollView.magnify(toFit: r.insetBy(dx: -48, dy: -48))
    if scrollView.magnification > 1 { scrollView.setMagnification(1, centeredAt: NSPoint(x: r.midX, y: r.midY)) }
    viewMoved()
  }

  func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { [.flexibleSpace, .newLane, .zoom] }
  func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { toolbarDefaultItemIdentifiers(toolbar) }

  func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
    switch id {
    case .newLane:
      let item = NSToolbarItem(itemIdentifier: id)
      item.label = "New Lane"
      item.image = NSImage(systemSymbolName: "rectangle.split.3x1", accessibilityDescription: "New Lane")
      item.toolTip = "New lane (L)"
      item.isBordered = true
      item.target = self
      item.action = #selector(newLane(_:))
      return item
    case .zoom:
      zoomButton.bezelStyle = .toolbar
      zoomButton.font = .monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
      zoomButton.target = self
      zoomButton.action = #selector(actualSize(_:))
      zoomItem.view = zoomButton
      zoomItem.label = "Zoom"
      zoomItem.toolTip = "Actual size (⌘0 or ⇧0)"
      return zoomItem
    default:
      return nil
    }
  }
}

/// The zoom readout. Its text is a subview of its own: a new title would lay out the toolbar on
/// every zoom step, and redrawing the button would redraw its bezel.
final class ReadoutButton: NSButton {
  private let label = ReadoutLabel()
  var readout: String {
    get { label.text }
    set { label.text = newValue }
  }

  override init(frame: NSRect) {
    super.init(frame: frame)
    label.autoresizingMask = [.width, .height]
    addSubview(label)
  }

  required init?(coder: NSCoder) { fatalError() }

  override var intrinsicContentSize: NSSize { NSSize(width: 64, height: super.intrinsicContentSize.height) }

  override func layout() {
    super.layout()
    label.frame = bounds
    label.font = font
  }

  override func accessibilityLabel() -> String? { readout }
}

private final class ReadoutLabel: NSView {
  var text = "100 %" { didSet { if text != oldValue { needsDisplay = true } } }
  var font: NSFont?
  private var observers: [NSObjectProtocol] = []

  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  /// A toolbar button's title colours, measured: no system colour matches them.
  private static let active = NSColor(name: nil) { $0.isDark ? .white : .black }
  private static let inactive = NSColor(name: nil) { $0.isDark ? .disabledControlTextColor : NSColor(white: 0, alpha: 0.31) }

  /// Greyed out while the window is inactive, as toolbar controls are.
  override func viewDidMoveToWindow() {
    observers.forEach(NotificationCenter.default.removeObserver)
    observers = [NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification].map {
      NotificationCenter.default.addObserver(forName: $0, object: window, queue: .main) { [weak self] _ in self?.needsDisplay = true }
    }
  }

  override func draw(_ dirtyRect: NSRect) {
    let color = window?.isKeyWindow == true ? Self.active : Self.inactive
    let s = NSAttributedString(string: text, attributes: [.font: font ?? .systemFont(ofSize: NSFont.systemFontSize), .foregroundColor: color])
    let size = s.size()
    s.draw(at: NSPoint(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2))
  }
}
