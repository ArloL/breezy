import AppKit
import BreezyKit

/// The Boards window: each group's boards, to open, rename, add, move and delete.
@MainActor final class BoardsWindowController: NSWindowController, NSOutlineViewDataSource, NSOutlineViewDelegate, NSTextFieldDelegate, NSMenuDelegate {
  static let shared = BoardsWindowController()

  /// A group, or a board in one.
  final class Row {
    let group: Spaces.Group
    let board: (id: String, title: String)?
    var children: [Row] = []

    init(group: Spaces.Group, board: (id: String, title: String)? = nil) {
      self.group = group
      self.board = board
    }
  }

  private let outline = NSOutlineView()
  let status = NSTextField(labelWithString: "")
  private var rows: [Row] = []

  init() {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 360, height: 420), styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "Boards"
    window.minSize = NSSize(width: 280, height: 240)
    super.init(window: window)
    window.center()
    window.setFrameAutosaveName("Boards")
    let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("title"))
    outline.addTableColumn(column)
    outline.outlineTableColumn = column
    outline.headerView = nil
    outline.style = .sourceList
    outline.rowHeight = 28
    outline.floatsGroupRows = false
    outline.dataSource = self
    outline.delegate = self
    outline.target = self
    outline.doubleAction = #selector(openClicked)
    let menu = NSMenu()
    menu.delegate = self
    outline.menu = menu
    let scroll = NSScrollView()
    scroll.documentView = outline
    scroll.hasVerticalScroller = true
    let add = NSButton(image: NSImage(systemSymbolName: "plus", accessibilityDescription: "New Board")!, target: nil, action: #selector(AppDelegate.newBoard(_:)))
    let remove = NSButton(image: NSImage(systemSymbolName: "minus", accessibilityDescription: "Delete Board")!, target: self, action: #selector(delete(_:)))
    for b in [add, remove] { b.bezelStyle = .accessoryBarAction }
    status.textColor = .secondaryLabelColor
    status.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
    status.lineBreakMode = .byTruncatingTail
    let bar = NSStackView(views: [add, remove, status])
    bar.spacing = 4
    bar.edgeInsets = NSEdgeInsets(top: 6, left: 8, bottom: 8, right: 12)
    let stack = NSStackView(views: [scroll, bar])
    stack.orientation = .vertical
    stack.spacing = 0
    stack.alignment = .leading
    scroll.setContentHuggingPriority(.defaultLow, for: .vertical)
    NSLayoutConstraint.activate([scroll.widthAnchor.constraint(equalTo: stack.widthAnchor), bar.widthAnchor.constraint(equalTo: stack.widthAnchor)])
    window.contentView = stack
    NotificationCenter.default.addObserver(forName: .boardsChanged, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.reload() }
    }
    NotificationCenter.default.addObserver(forName: .syncStatusChanged, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.updateStatus() }
    }
    NotificationCenter.default.addObserver(forName: .peopleChanged, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.reload() }
    }
    reload()
  }

  required init?(coder: NSCoder) { fatalError() }

  private var selectedRow: Row? { outline.item(atRow: outline.selectedRow) as? Row }
  var selectedGroup: Spaces.Group? { selectedRow?.group }

  /// On this device shows only when it has boards or the Mac is in no space.
  func reload() {
    let spaces = Library.shared.spaces
    let kept = selectedRow.map { ($0.group, $0.board?.id) }
    rows = spaces.groups.filter { $0.space != nil || spaces.spaces.isEmpty || !$0.store.boards.isEmpty }.map { g in
      let r = Row(group: g)
      r.children = g.store.boards.map { Row(group: g, board: $0) }
      return r
    }
    outline.reloadData()
    outline.expandItem(nil, expandChildren: true)
    var i = -1
    if let (group, board) = kept, let groupRow = rows.first(where: { $0.group === group }) {
      var row: Row? = groupRow
      if let board { row = groupRow.children.first { $0.board?.id == board } }
      i = row.map { outline.row(forItem: $0) } ?? -1
    }
    if i >= 0 { outline.selectRowIndexes([i], byExtendingSelection: false) } else { outline.deselectAll(nil) }
    updateStatus()
  }

  func select(_ group: Spaces.Group) {
    guard let r = rows.first(where: { $0.group === group }) else { return }
    let i = outline.row(forItem: r)
    guard i >= 0 else { return }
    outline.selectRowIndexes([i], byExtendingSelection: false)
    outline.scrollRowToVisible(i)
  }

  func updateStatus() {
    guard let g = selectedGroup, g.space != nil else { return status.stringValue = "" }
    status.stringValue = g.engine.status.lines().joined(separator: " · ")
  }

  func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int { (item as? Row)?.children.count ?? rows.count }
  func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any { (item as? Row)?.children[index] ?? rows[index] }
  func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool { (item as? Row)?.board == nil }
  func outlineView(_ outlineView: NSOutlineView, isGroupItem item: Any) -> Bool { (item as? Row)?.board == nil }
  func outlineViewSelectionDidChange(_ notification: Notification) { updateStatus() }

  func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
    guard let row = item as? Row else { return nil }
    let cell = NSTableCellView()
    let field = NSTextField(string: row.board?.title ?? row.group.name)
    field.isBordered = false
    field.drawsBackground = false
    field.isEditable = row.board != nil
    field.delegate = self
    field.identifier = row.board.map { NSUserInterfaceItemIdentifier($0.id) }
    field.translatesAutoresizingMaskIntoConstraints = false
    cell.addSubview(field)
    cell.textField = field
    let people = NSTextField(labelWithString: "")
    if let b = row.board {
      let s = NSMutableAttributedString()
      for p in row.group.live?.people(on: b.id) ?? [] {
        s.append(NSAttributedString(string: p.initials + " ", attributes: [.foregroundColor: p.nsColour, .font: NSFont.systemFont(ofSize: 11, weight: .semibold)]))
      }
      people.attributedStringValue = s
    }
    people.translatesAutoresizingMaskIntoConstraints = false
    people.setContentCompressionResistancePriority(.required, for: .horizontal)
    cell.addSubview(people)
    NSLayoutConstraint.activate([
      field.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 4),
      field.trailingAnchor.constraint(equalTo: people.leadingAnchor, constant: -4),
      people.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -4),
      field.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
      people.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
    ])
    return cell
  }

  func controlTextDidEndEditing(_ obj: Notification) {
    guard let field = obj.object as? NSTextField, let id = field.identifier?.rawValue,
          let row = rows.flatMap(\.children).first(where: { $0.board?.id == id }), let b = row.board else { return }
    let title = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty, title != b.title else {
      field.stringValue = b.title
      return
    }
    row.group.store.renameBoard(b.id, title)
  }

  @objc private func openClicked() {
    guard let id = (outline.item(atRow: outline.clickedRow) as? Row)?.board?.id else { return }
    Library.shared.open(id)
  }

  /// Edit → Delete, ⌫ in the list, the − button and the context menu.
  @objc func delete(_ sender: Any?) {
    guard let row = selectedRow, let b = row.board, let window else { return NSSound.beep() }
    let alert = NSAlert()
    alert.messageText = "Delete “\(b.title)”?"
    alert.informativeText = row.group.space == nil
      ? "This can’t be undone." : "It is deleted on every device in “\(row.group.name)”. This can’t be undone."
    alert.addButton(withTitle: "Delete").hasDestructiveAction = true
    alert.addButton(withTitle: "Cancel")
    alert.beginSheetModal(for: window) { response in
      guard response == .alertFirstButtonReturn else { return }
      MainActor.assumeIsolated {
        Library.shared.documents.first { $0.boardID == b.id }?.close()
        row.group.store.deleteBoard(b.id)
      }
    }
  }

  /// A board's Move to and Delete, or a space's Rename, Share and Leave; the clicked row is selected so they act on it.
  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    guard let row = outline.item(atRow: outline.clickedRow) as? Row else { return }
    outline.selectRowIndexes([outline.clickedRow], byExtendingSelection: false)
    if let b = row.board {
      let targets = NSMenu()
      for g in Library.shared.spaces.groups where g !== row.group {
        let i = NSMenuItem(title: g.name, action: #selector(AppDelegate.moveBoard(_:)), keyEquivalent: "")
        i.representedObject = Move(board: b.id, group: g)
        targets.addItem(i)
      }
      let move = NSMenuItem(title: "Move to", action: nil, keyEquivalent: "")
      move.submenu = targets
      move.isEnabled = !targets.items.isEmpty
      menu.addItem(move)
      let delete = NSMenuItem(title: "Delete", action: #selector(delete(_:)), keyEquivalent: "")
      delete.target = self
      menu.addItem(delete)
    } else if row.group.space != nil {
      let renameSpace = NSMenuItem(title: "Rename Space…", action: #selector(AppDelegate.renameSpace(_:)), keyEquivalent: "")
      renameSpace.representedObject = row.group
      menu.addItem(renameSpace)
      let shareInvite = NSMenuItem(title: "Share Invite", action: #selector(AppDelegate.shareInvite(_:)), keyEquivalent: "")
      shareInvite.representedObject = row.group
      menu.addItem(shareInvite)
      let leaveSpace = NSMenuItem(title: "Leave Space…", action: #selector(AppDelegate.leaveSpace(_:)), keyEquivalent: "")
      leaveSpace.representedObject = row.group
      menu.addItem(leaveSpace)
    }
  }

  override func keyDown(with event: NSEvent) {
    if event.keyCode == 51 || event.keyCode == 117 { delete(nil) } else { super.keyDown(with: event) }
  }
}
