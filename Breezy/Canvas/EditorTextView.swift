import AppKit

/// The card editor: Esc or ⌘↩ finishes, Tab turns the card over and goes on editing.
final class EditorTextView: NSTextView {
  var onFinish: (() -> Void)?
  var onTab: (() -> Void)?

  override func keyDown(with event: NSEvent) {
    let mods = event.modifierFlags.intersection([.command, .option, .control, .shift])
    if event.keyCode == 53 || (event.keyCode == 36 && mods == .command) {
      onFinish?()
    } else if event.keyCode == 48 && mods.isEmpty {
      onTab?()
    } else {
      super.keyDown(with: event)
    }
  }
}
