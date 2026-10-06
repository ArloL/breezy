import AppKit
import BreezyKit

extension NSToolbarItem.Identifier {
  static let newLane = Self("newLane")
  static let zoom = Self("zoom")
}

/// One board window: the toolbar, the scroll view with the canvas and, from Task 7, the dot grid
/// behind it.
final class BoardWindowController: NSWindowController, NSWindowDelegate, NSToolbarDelegate {
  let canvas: CanvasView
  let scrollView = BoardScrollView()
  let zoomItem = NSToolbarItem(itemIdentifier: .zoom)

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
    toolbar.displayMode = .labelOnly
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
    window.contentView = scrollView
    scrollView.contentView.postsBoundsChangedNotifications = true
    NotificationCenter.default.addObserver(
      self, selector: #selector(viewMoved), name: NSView.boundsDidChangeNotification, object: scrollView.contentView)
    DispatchQueue.main.async { [weak self] in self?.fit() }
  }

  required init?(coder: NSCoder) { fatalError() }

  func place(origin: NSPoint, zoom: CGFloat) {
    scrollView.magnification = zoom
    scrollView.contentView.scroll(to: origin)
    scrollView.reflectScrolledClipView(scrollView.contentView)
    viewMoved()
  }

  @objc func viewMoved() {
    let label = "\(Int((scrollView.magnification * 100).rounded())) %"
    if zoomItem.label != label { zoomItem.label = label }
    canvas.layoutCards()
  }

  var centre: NSPoint {
    let r = scrollView.contentView.bounds
    return NSPoint(x: r.midX, y: r.midY)
  }

  @objc func zoomIn(_ sender: Any?) { scrollView.animator().setMagnification(scrollView.magnification * 1.25, centeredAt: centre) }
  @objc func zoomOut(_ sender: Any?) { scrollView.animator().setMagnification(scrollView.magnification / 1.25, centeredAt: centre) }
  @objc func actualSize(_ sender: Any?) { scrollView.animator().setMagnification(1, centeredAt: centre) }
  @objc func newLane(_ sender: Any?) {}

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
      item.toolTip = "New lane (L)"
      item.isBordered = true
      item.target = self
      item.action = #selector(newLane(_:))
      return item
    case .zoom:
      zoomItem.toolTip = "Actual size (⌘0 or ⇧0)"
      zoomItem.isBordered = true
      zoomItem.target = self
      zoomItem.action = #selector(actualSize(_:))
      return zoomItem
    default:
      return nil
    }
  }
}
