import AppKit

/// Launch arguments for scripted checks. With -BreezyBoard <file> the app opens that board and
/// no untitled one; -BreezyCapture <png> writes a window capture after 1.5 s and quits;
/// -BreezyBench <json> runs the benchmark and quits; -BreezyAppearance light|dark|switch fixes
/// the appearance, or starts light and switches to dark before the capture; -BreezyTurn any turns
/// over the first card with notes; -BreezySelfTest <check> runs a SelfTest check.
enum DebugLaunch {
  private static let defaults = UserDefaults.standard
  static var board: String? { defaults.string(forKey: "BreezyBoard") }
  static var active: Bool { board != nil }

  static func start() {
    guard let board else { return }
    let appearance = defaults.string(forKey: "BreezyAppearance")
    if appearance == "dark" { NSApp.appearance = NSAppearance(named: .darkAqua) }
    if appearance == "light" || appearance == "switch" { NSApp.appearance = NSAppearance(named: .aqua) }
    NSDocumentController.shared.openDocument(withContentsOf: URL(fileURLWithPath: board), display: true) { doc, _, error in
      if let error {
        print("cannot open \(board): \(error.localizedDescription)")
        exit(1)
      }
      guard let wc = doc?.windowControllers.first as? BoardWindowController, let window = wc.window else { exit(1) }
      if appearance == "switch" {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { NSApp.appearance = NSAppearance(named: .darkAqua) }
      }
      if defaults.string(forKey: "BreezyTurn") != nil {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { wc.canvas.turn(wc.canvas.board.cards.first { $0.notes != nil }?.id) }
      }
      if let check = defaults.string(forKey: "BreezySelfTest") {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { SelfTest.run(check, wc) }
      }
      if let out = defaults.string(forKey: "BreezyCapture") {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
          capture(window, to: out)
          exit(0)
        }
      }
    }
  }

  /// The window as the window server composites it; an app may capture its own windows.
  static func capture(_ window: NSWindow, to path: String) {
    typealias Capture = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
    guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage") else { return print("no capture") }
    let create = unsafeBitCast(sym, to: Capture.self)
    // optionIncludingWindow; boundsIgnoreFraming | bestResolution
    guard let image = create(.null, 1 << 3, UInt32(window.windowNumber), 1 << 0 | 1 << 3)?.takeRetainedValue() else {
      return print("capture failed")
    }
    try? NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
  }
}
