import AppKit
import BreezyKit

/// The Boards window: every board in the store, to open, rename, add and delete.
@MainActor final class BoardsWindowController: NSWindowController, NSTableViewDataSource, NSTableViewDelegate, NSTextFieldDelegate {
  static let shared = BoardsWindowController()
  private let table = NSTableView()
  let status = NSTextField(labelWithString: "")
  private var boards: [(id: String, title: String)] = []

  init() {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 360, height: 420), styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "Boards"
    window.minSize = NSSize(width: 280, height: 240)
    super.init(window: window)
    window.center()
    window.setFrameAutosaveName("Boards")
    table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("title")))
    table.headerView = nil
    table.style = .inset
    table.rowHeight = 28
    table.dataSource = self
    table.delegate = self
    table.target = self
    table.doubleAction = #selector(openClicked)
    let scroll = NSScrollView()
    scroll.documentView = table
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
    reload()
  }

  required init?(coder: NSCoder) { fatalError() }

  func reload() {
    boards = Library.shared.store.boards
    table.reloadData()
  }

  func numberOfRows(in tableView: NSTableView) -> Int { boards.count }

  func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
    let cell = NSTableCellView()
    let field = NSTextField(string: boards[row].title)
    field.isBordered = false
    field.drawsBackground = false
    field.isEditable = true
    field.delegate = self
    field.tag = row
    field.translatesAutoresizingMaskIntoConstraints = false
    cell.addSubview(field)
    cell.textField = field
    NSLayoutConstraint.activate([
      field.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 4),
      field.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -4),
      field.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
    ])
    return cell
  }

  func controlTextDidEndEditing(_ obj: Notification) {
    guard let field = obj.object as? NSTextField, boards.indices.contains(field.tag) else { return }
    let b = boards[field.tag]
    let title = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty, title != b.title else {
      field.stringValue = b.title
      return
    }
    Library.shared.store.renameBoard(b.id, title)
  }

  @objc private func openClicked() {
    guard boards.indices.contains(table.clickedRow) else { return }
    Library.shared.open(boards[table.clickedRow].id)
  }

  /// Edit → Delete, ⌫ in the list and the − button.
  @objc func delete(_ sender: Any?) {
    guard boards.indices.contains(table.selectedRow), let window else { return NSSound.beep() }
    let b = boards[table.selectedRow]
    let alert = NSAlert()
    alert.messageText = "Delete “\(b.title)”?"
    alert.informativeText = Library.shared.store.state.invite == nil ? "This can’t be undone." : "It is deleted on every device in the space. This can’t be undone."
    alert.addButton(withTitle: "Delete").hasDestructiveAction = true
    alert.addButton(withTitle: "Cancel")
    alert.beginSheetModal(for: window) { response in
      guard response == .alertFirstButtonReturn else { return }
      MainActor.assumeIsolated {
        Library.shared.documents.first { $0.boardID == b.id }?.close()
        Library.shared.store.deleteBoard(b.id)
      }
    }
  }

  override func keyDown(with event: NSEvent) {
    if event.keyCode == 51 || event.keyCode == 117 { delete(nil) } else { super.keyDown(with: event) }
  }
}
