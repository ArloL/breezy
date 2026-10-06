import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationWillFinishLaunching(_ notification: Notification) {
    NSApp.mainMenu = MainMenu.make()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    DebugLaunch.start()
  }

  func applicationShouldOpenUntitledFile(_ sender: NSApplication) -> Bool { !DebugLaunch.active }
}
