import AppKit
import BreezyKit

final class AppDelegate: NSObject, NSApplicationDelegate {
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
}
