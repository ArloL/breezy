import AppKit

/// The menu bar, built in code.
enum MainMenu {
  static func make() -> NSMenu {
    let main = NSMenu()
    let app = submenu("Breezy", [
      item("About Breezy", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
      .separator(),
      item("Your Name…", #selector(AppDelegate.yourName(_:))),
      item("New Space…", #selector(AppDelegate.newSpace(_:))),
      item("Join Space…", #selector(AppDelegate.joinSpace(_:))),
      item("Share Invite", #selector(AppDelegate.shareInvite(_:))),
      item("Rename Space…", #selector(AppDelegate.renameSpace(_:))),
      item("Leave Space…", #selector(AppDelegate.leaveSpace(_:))),
      .separator(),
      item("Hide Breezy", #selector(NSApplication.hide(_:)), "h"),
      item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
      .separator(),
      item("Quit Breezy", #selector(NSApplication.terminate(_:)), "q"),
    ])
    app.submenu?.delegate = SyncMenu.shared
    main.addItem(app)
    main.addItem(submenu("File", [
      item("New Board", #selector(AppDelegate.newBoard(_:)), "n"),
      .separator(),
      item("Close", #selector(NSWindow.performClose(_:)), "w"),
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
      item("Boards", #selector(AppDelegate.showBoards(_:)), "b", [.command, .shift]),
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
