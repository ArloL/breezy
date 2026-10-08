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
      alert.informativeText = "\(error.localizedDescription)\n\nThe file is left as it is: \(dir.appendingPathComponent("space.json").path)"
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
    MainActor.assumeIsolated { _ = Library.shared.open(Library.shared.store.createBoard(title: "New Board")) }
  }

  @objc func showBoards(_ sender: Any?) { MainActor.assumeIsolated { BoardsWindowController.shared.showWindow(nil) } }

  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    let syncing = Library.shared.store.state.invite != nil
    switch item.action {
    case #selector(startSyncing(_:)): return !syncing
    case #selector(shareInvite(_:)): return syncing
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

  @MainActor @objc func startSyncing(_ sender: Any?) {
    let input = field("https://example.com/breezy/sync.php")
    let alert = NSAlert()
    alert.messageText = "Start Syncing"
    alert.informativeText = "The address of your Breezy server. Boards are encrypted on this Mac; the server can’t read them."
    alert.accessoryView = input
    alert.addButton(withTitle: "Start Syncing")
    alert.addButton(withTitle: "Cancel")
    alert.window.initialFirstResponder = input
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    let server = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard Invite.validServer(server) else { return tell("That isn’t a server address", "Use an https:// address ending in sync.php.") }
    Library.shared.store.startSyncing(server: server)
    Library.shared.engine.reset()
    Library.shared.syncNow()
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
    let lib = Library.shared!
    let n = lib.store.boards.count
    if n > 0 {
      let sure = NSAlert()
      sure.messageText = "Replace the boards on this Mac?"
      sure.informativeText = "Joining shows the space’s boards instead of the \(n == 1 ? "board" : "\(n) boards") here, which are deleted from this Mac."
      sure.addButton(withTitle: "Join").hasDestructiveAction = true
      sure.addButton(withTitle: "Cancel")
      guard sure.runModal() == .alertFirstButtonReturn else { return }
    }
    lib.documents.forEach { $0.close() }
    lib.store.join(invite)
    lib.engine.reset()
    lib.syncNow()
    BoardsWindowController.shared.showWindow(nil)
  }

  @MainActor @objc func shareInvite(_ sender: Any?) {
    guard let link = Library.shared.store.state.invite?.link else { return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(link, forType: .string)
    tell("Invite link copied", "Paste it into Join Space on the other device. Anyone with the link can read and change every board in this space.")
  }
}
