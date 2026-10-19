// A window with a text view that writes each text input call it gets, and its text after, as a JSON line on stdout:
// what oskeys's input reached, for scenarios/platform/oskeys.e2e.ts. Ends with its stdin.
import AppKit

func plain(_ s: Any) -> String { (s as? NSAttributedString)?.string ?? s as? String ?? "" }

final class EchoTextView: NSTextView {
  func emit(_ o: [String: Any]) {
    var o = o
    o["string"] = string
    o["marked"] = hasMarkedText()
    FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: o) + Data("\n".utf8))
  }

  override func insertText(_ s: Any, replacementRange r: NSRange) {
    super.insertText(s, replacementRange: r)
    emit(["call": "insertText", "text": plain(s)])
  }

  override func setMarkedText(_ s: Any, selectedRange sel: NSRange, replacementRange r: NSRange) {
    super.setMarkedText(s, selectedRange: sel, replacementRange: r)
    emit(["call": "setMarkedText", "text": plain(s)])
  }

  override func unmarkText() {
    super.unmarkText()
    emit(["call": "unmarkText"])
  }

  override func doCommand(by selector: Selector) {
    super.doCommand(by: selector)
    emit(["call": "doCommand", "selector": NSStringFromSelector(selector)])
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
// ⌃⌘Space opens the emoji picker through the Edit menu's item, as in any app
let edit = NSMenu(title: "Edit")
edit.addItem(withTitle: "Emoji & Symbols", action: #selector(NSApplication.orderFrontCharacterPalette(_:)), keyEquivalent: " ").keyEquivalentModifierMask = [.control, .command]
let bar = NSMenu()
bar.addItem(withTitle: "", action: nil, keyEquivalent: "").submenu = NSMenu()
bar.addItem(withTitle: "Edit", action: nil, keyEquivalent: "").submenu = edit
app.mainMenu = bar
let window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 480, height: 240), styleMask: [.titled], backing: .buffered, defer: false)
let view = EchoTextView(frame: window.contentView!.bounds)
window.contentView = view
window.makeKeyAndOrderFront(nil)
window.makeFirstResponder(view)
FileHandle.standardInput.readabilityHandler = { h in
  if h.availableData.isEmpty { exit(0) }
}
DispatchQueue.main.async { view.emit(["ready": Int(ProcessInfo.processInfo.processIdentifier)]) }
app.run()
