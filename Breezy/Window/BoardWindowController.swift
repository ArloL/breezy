import AppKit
import BreezyKit

extension NSToolbarItem.Identifier {
  static let newLane = Self("newLane")
}

/// One board window: the toolbar, the scroll view with the canvas, the dot grid behind it and the
/// zoom capsule above.
final class BoardWindowController: NSWindowController, NSWindowDelegate, NSToolbarDelegate, NSMenuItemValidation {
  let boardID: String
  let canvas: CanvasView
  let scrollView = BoardScrollView()
  let zoomCapsule = ZoomCapsule()
  private var shownZoom: Int?
  private let grid = GridView()
  private var restored = false
  private let finder = NSTextFinder()
  private lazy var finderClient = BoardFinderClient(canvas: canvas)

  init(model: BoardModel, boardID: String) {
    self.boardID = boardID
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
    // a new window fills the screen, short of the menu bar and the Dock; a restored one gets its
    // frame back afterwards, and scripted checks keep 1200 × 800 so their numbers stay comparable
    if !DebugLaunch.active, let screen = NSScreen.main {
      shouldCascadeWindows = false
      window.setFrame(screen.visibleFrame, display: false)
    }

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
    zoomCapsule.autoresizingMask = [.minXMargin, .maxXMargin, .minYMargin]
    root.addSubview(zoomCapsule)
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
      guard let self else { return }
      if !restored { fit() }
      // from here on, a new zoom shows
      shownZoom = Self.percent(scrollView.magnification)
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

  static func percent(_ zoom: CGFloat) -> Int { Int((zoom * 100).rounded()) }

  @objc func viewMoved() {
    let z = Self.percent(scrollView.magnification)
    if let shown = shownZoom, shown != z {
      shownZoom = z
      showZoom(z)
    }
    grid.update(origin: scrollView.contentView.bounds.origin, zoom: scrollView.magnification)
    // a zoom step moves the bounds more than once; the cards follow once, when the frame is laid out
    canvas.needsLayout = true
    window?.invalidateRestorableState()
  }

  /// The capsule sits at the top of the board, below the toolbar and any find bar.
  private func showZoom(_ z: Int) {
    guard let root = window?.contentView else { return }
    let clip = root.convert(scrollView.contentView.frame, from: scrollView)
    let s = ZoomCapsule.size
    zoomCapsule.frame = NSRect(x: (clip.midX - s.width / 2).rounded(), y: (clip.maxY - 12 - s.height).rounded(), width: s.width, height: s.height)
    zoomCapsule.show("\(z) %")
  }

  var centre: NSPoint {
    let r = scrollView.contentView.bounds
    return NSPoint(x: r.midX, y: r.midY)
  }

  @objc func zoomIn(_ sender: Any?) { scrollView.springMagnification(to: scrollView.magnification * 1.25, centeredAt: centre) }
  @objc func zoomOut(_ sender: Any?) { scrollView.springMagnification(to: scrollView.magnification / 1.25, centeredAt: centre) }
  @objc func actualSize(_ sender: Any?) { scrollView.springMagnification(to: 1, centeredAt: centre) }
  @objc func newLane(_ sender: Any?) { canvas.addLaneAtCentre() }

  func window(_ window: NSWindow, willEncodeRestorableState state: NSCoder) {
    let o = scrollView.contentView.bounds.origin
    state.encode(Double(o.x), forKey: "originX")
    state.encode(Double(o.y), forKey: "originY")
    state.encode(Double(scrollView.magnification), forKey: "zoom")
    state.encode(boardID as NSString, forKey: "board")
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

  func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { [.flexibleSpace, .newLane] }
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
    default:
      return nil
    }
  }
}
