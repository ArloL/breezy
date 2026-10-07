import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationWillFinishLaunching(_ notification: Notification) {
    NSApp.mainMenu = MainMenu.make()
    // the boards open at quit come back on relaunch, whatever "Close windows when quitting an
    // application" says in System Settings; this app's own setting overrides that global one
    UserDefaults.standard.set(true, forKey: "NSQuitAlwaysKeepsWindows")
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    DebugLaunch.start()
  }

  func applicationShouldOpenUntitledFile(_ sender: NSApplication) -> Bool { !DebugLaunch.active }
}
