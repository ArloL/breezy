import AppKit

/// The menu bar, built in code. NSDocumentController fills the Open Recent menu, which it finds
/// by its Clear Menu item.
enum MainMenu {
  static func make() -> NSMenu {
    let main = NSMenu()
    main.addItem(submenu("Breezy", [
      item("About Breezy", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
      .separator(),
      item("Hide Breezy", #selector(NSApplication.hide(_:)), "h"),
      item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
      .separator(),
      item("Quit Breezy", #selector(NSApplication.terminate(_:)), "q"),
    ]))
    main.addItem(submenu("File", [
      item("New", #selector(NSDocumentController.newDocument(_:)), "n"),
      item("Open…", #selector(NSDocumentController.openDocument(_:)), "o"),
      submenu("Open Recent", [item("Clear Menu", #selector(NSDocumentController.clearRecentDocuments(_:)))]),
      .separator(),
      item("Close", #selector(NSWindow.performClose(_:)), "w"),
      item("Save…", #selector(NSDocument.save(_:)), "s"),
      item("Duplicate", #selector(NSDocument.duplicate(_:)), "s", [.command, .shift]),
      item("Rename…", #selector(NSDocument.rename(_:))),
      item("Move To…", #selector(NSDocument.move(_:))),
      item("Revert To Saved", #selector(NSDocument.revertToSaved(_:))),
      item("Browse All Versions…", #selector(NSDocument.browseVersions(_:))),
    ]))
    main.addItem(submenu("Edit", [
      item("Undo", Selector(("undo:")), "z"),
      item("Redo", Selector(("redo:")), "z", [.command, .shift]),
      .separator(),
      item("Cut", #selector(NSText.cut(_:)), "x"),
      item("Copy", #selector(NSText.copy(_:)), "c"),
      item("Paste", #selector(NSText.paste(_:)), "v"),
      item("Delete", #selector(NSText.delete(_:))),
      item("Select All", #selector(NSResponder.selectAll(_:)), "a"),
      .separator(),
      submenu("Find", [
        finder("Find…", .showFindInterface, "f"),
        finder("Find Next", .nextMatch, "g"),
        finder("Find Previous", .previousMatch, "g", [.command, .shift]),
        finder("Use Selection for Find", .setSearchString, "e"),
      ]),
    ]))
    main.addItem(submenu("View", [
      item("Zoom In", #selector(BoardWindowController.zoomIn(_:)), "+"),
      item("Zoom Out", #selector(BoardWindowController.zoomOut(_:)), "-"),
      item("Actual Size", #selector(BoardWindowController.actualSize(_:)), "0"),
      .separator(),
      item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
    ]))
    main.addItem(submenu("Board", [item("New Lane", #selector(BoardWindowController.newLane(_:)))]))
    let window = submenu("Window", [
      item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("Zoom", #selector(NSWindow.performZoom(_:))),
      .separator(),
      item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))),
    ])
    main.addItem(window)
    NSApp.windowsMenu = window.submenu
    return main
  }

  private static func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
    let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
    i.keyEquivalentModifierMask = mods
    return i
  }

  private static func finder(_ title: String, _ action: NSTextFinder.Action, _ key: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
    let i = item(title, #selector(NSResponder.performTextFinderAction(_:)), key, mods)
    i.tag = action.rawValue
    return i
  }

  private static func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
    let top = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    let m = NSMenu(title: title)
    items.forEach(m.addItem)
    top.submenu = m
    return top
  }
}
