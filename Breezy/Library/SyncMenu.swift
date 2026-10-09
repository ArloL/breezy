import AppKit

/// Puts the sync status above the Breezy menu's sync items each time the menu opens.
final class SyncMenu: NSObject, NSMenuDelegate {
  static let shared = SyncMenu()
  static let tag = 7_001

  func menuNeedsUpdate(_ menu: NSMenu) {
    for i in menu.items where i.tag == Self.tag { menu.removeItem(i) }
    guard let at = menu.items.firstIndex(where: { $0.action == #selector(AppDelegate.leaveSpace(_:)) }) else { return }
    for (n, line) in MainActor.assumeIsolated({ Library.shared.statusLines }).enumerated() {
      let i = NSMenuItem(title: line, action: nil, keyEquivalent: "")
      i.tag = Self.tag
      menu.insertItem(i, at: at + 1 + n)
    }
  }
}
