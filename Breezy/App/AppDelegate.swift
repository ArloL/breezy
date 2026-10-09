import AppKit
import BreezyKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
  func applicationWillFinishLaunching(_ notification: Notification) {
    NSApp.mainMenu = MainMenu.make()
    // the boards open at quit come back on relaunch, whatever "Close windows when quitting an
    // application" says in System Settings; this app's own setting overrides that global one
    UserDefaults.standard.set(true, forKey: "NSQuitAlwaysKeepsWindows")
    let dir = DebugLaunch.storeDirectory
    do {
      Library.shared = try Library(directory: dir)
    } catch {
      let alert = NSAlert()
      alert.messageText = "Breezy can’t read its boards"
      alert.informativeText = "\(error.localizedDescription)\n\nThe files are left as they are: \(dir.appendingPathComponent("Spaces").path)"
      alert.runModal()
      exit(1)
    }
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    DebugLaunch.start()
    if !DebugLaunch.active && Library.shared.documents.isEmpty { BoardsWindowController.shared.showWindow(nil) }
    Library.shared.syncNow()
  }

  func applicationShouldOpenUntitledFile(_ sender: NSApplication) -> Bool { false }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if !flag { BoardsWindowController.shared.showWindow(nil) }
    return false
  }

  func applicationWillTerminate(_ notification: Notification) { Library.shared.saveNow() }

  @objc func newBoard(_ sender: Any?) {
    MainActor.assumeIsolated { _ = Library.shared.open(Library.shared.currentGroup.store.createBoard(title: "New Board")) }
  }

  @objc func showBoards(_ sender: Any?) { MainActor.assumeIsolated { BoardsWindowController.shared.showWindow(nil) } }

  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    switch item.action {
    case #selector(shareInvite(_:)), #selector(renameSpace(_:)), #selector(leaveSpace(_:)):
      return MainActor.assumeIsolated { group(item).space != nil }
    default: return true
    }
  }

  @MainActor private func field(_ placeholder: String) -> NSTextField {
    let f = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
    f.placeholderString = placeholder
    return f
  }

  @MainActor private func tell(_ message: String, _ info: String) {
    let alert = NSAlert()
    alert.messageText = message
    alert.informativeText = info
    alert.runModal()
  }

  @MainActor private func confirm(_ message: String, _ info: String, _ button: String, destructive: Bool = false) -> Bool {
    let alert = NSAlert()
    alert.messageText = message
    alert.informativeText = info
    alert.addButton(withTitle: button).hasDestructiveAction = destructive
    alert.addButton(withTitle: "Cancel")
    return alert.runModal() == .alertFirstButtonReturn
  }

  /// The group a space menu item was made for, else the current one.
  @MainActor private func group(_ sender: Any?) -> Spaces.Group {
    (sender as? NSMenuItem)?.representedObject as? Spaces.Group ?? Library.shared.currentGroup
  }

  @MainActor private func show(_ group: Spaces.Group) {
    BoardsWindowController.shared.showWindow(nil)
    BoardsWindowController.shared.reload()
    BoardsWindowController.shared.select(group)
  }

  @MainActor @objc func newSpace(_ sender: Any?) {
    let name = field("Name"), server = field("https://example.com/breezy/sync.php")
    server.stringValue = UserDefaults.standard.string(forKey: "BreezyLastServer") ?? ""
    for f in [name, server] { f.widthAnchor.constraint(equalToConstant: 320).isActive = true }
    let stack = NSStackView(views: [name, server])
    stack.orientation = .vertical
    stack.spacing = 8
    stack.frame = NSRect(x: 0, y: 0, width: 320, height: 56)
    let alert = NSAlert()
    alert.messageText = "New Space"
    alert.informativeText = "A name for the space and the address of your Breezy server. Boards are encrypted on this Mac; the server can’t read them."
    alert.accessoryView = stack
    alert.addButton(withTitle: "Create")
    alert.addButton(withTitle: "Cancel")
    alert.window.initialFirstResponder = name
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    let title = name.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    let url = server.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty else { return }
    guard Invite.validServer(url) else { return tell("That isn’t a server address", "Use an https:// address ending in sync.php.") }
    UserDefaults.standard.set(url, forKey: "BreezyLastServer")
    let g = Library.shared.spaces.newSpace(server: url, name: title)
    Library.shared.syncNow()
    show(g)
  }

  @MainActor @objc func joinSpace(_ sender: Any?) {
    let input = field("Invite link")
    let alert = NSAlert()
    alert.messageText = "Join Space"
    alert.informativeText = "Paste the invite link from another device."
    alert.accessoryView = input
    alert.addButton(withTitle: "Join")
    alert.addButton(withTitle: "Cancel")
    alert.window.initialFirstResponder = input
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    guard let invite = Invite(link: input.stringValue) else {
      return tell("That isn’t an invite link", "Copy the whole link from Share Invite on the other device.")
    }
    let g = Library.shared.spaces.join(invite)
    Library.shared.syncNow()
    show(g)
  }

  @MainActor @objc func renameSpace(_ sender: Any?) {
    let g = group(sender)
    guard g.space != nil else { return }
    let input = field("Name")
    input.stringValue = g.name
    let alert = NSAlert()
    alert.messageText = "Rename Space"
    alert.informativeText = "The new name shows on every device in the space."
    alert.accessoryView = input
    alert.addButton(withTitle: "Rename")
    alert.addButton(withTitle: "Cancel")
    alert.window.initialFirstResponder = input
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    let name = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    if !name.isEmpty && name != g.name { g.store.rename(name) }
  }

  @MainActor @objc func shareInvite(_ sender: Any?) {
    guard let link = group(sender).store.invite?.link else { return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(link, forType: .string)
    // clipboard managers leave out what is marked concealed
    NSPasteboard.general.setString("", forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))
    tell("Invite link copied", "Paste it into Join Space on the other device. Anyone with the link can read and change every board in this space.")
  }

  @MainActor @objc func leaveSpace(_ sender: Any?) {
    let g = group(sender)
    let n = g.store.pending.count
    let lost = n == 0 ? "" : ", but \(n == 1 ? "1 change that hasn’t" : "\(n) changes that haven’t") reached the server yet \(n == 1 ? "is" : "are") lost"
    guard g.space != nil,
          confirm("Leave “\(g.name)”?", "Its boards are removed from this device. Others in the space keep them\(lost).", "Leave", destructive: true)
    else { return }
    Library.shared.leave(g)
  }

  @MainActor @objc func moveBoard(_ sender: NSMenuItem) {
    guard let m = sender.representedObject as? Move, let source = Library.shared.spaces.group(of: m.board),
          let title = source.store.title(of: m.board) else { return }
    if source.space != nil {
      guard confirm("Move “\(title)” to “\(m.group.name)”?", "It is removed from “\(source.name)” on every device.", "Move") else { return }
    }
    Library.shared.move(m.board, to: m.group)
  }
}

/// A board and the group a menu item moves it to.
final class Move: NSObject {
  let board: String
  let group: Spaces.Group

  init(board: String, group: Spaces.Group) {
    self.board = board
    self.group = group
  }
}
