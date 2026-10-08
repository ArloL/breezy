import AppKit
import BreezyKit

/// Launch arguments for scripted checks. With -BreezyBoard <file> the app loads that board's JSON
/// into a store in a fresh temporary folder, or in -BreezyStore <dir>, and opens it;
/// -BreezyCapture <png> writes a window capture after 1.5 s and quits; -BreezyBench <json> runs the
/// benchmark and quits; -BreezyAppearance light|dark|switch fixes the appearance, or starts light
/// and switches to dark before the capture; -BreezyTurn any turns over the first card with notes;
/// -BreezyEdit any starts editing the first card; -BreezySelfTest <check> runs a SelfTest check.
enum DebugLaunch {
  private static let defaults = UserDefaults.standard
  static var board: String? { defaults.string(forKey: "BreezyBoard") }
  static var active: Bool { board != nil }

  /// Where the store lives: -BreezyStore <dir>, a fresh temporary folder for scripted checks, else
  /// Application Support.
  static let storeDirectory: URL = {
    if let dir = defaults.string(forKey: "BreezyStore") { return URL(fileURLWithPath: dir) }
    if active { return FileManager.default.temporaryDirectory.appendingPathComponent("breezy-\(UUID().uuidString)") }
    return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Breezy")
  }()

  static func start() {
    guard let board else { return }
    let appearance = defaults.string(forKey: "BreezyAppearance")
    if appearance == "dark" { NSApp.appearance = NSAppearance(named: .darkAqua) }
    if appearance == "light" || appearance == "switch" { NSApp.appearance = NSAppearance(named: .aqua) }
    let url = URL(fileURLWithPath: board)
    let loaded: Board
    do {
      loaded = try BoardFormat.decode(Data(contentsOf: url)).recentred(within: Double(CanvasView.origin) - 2_000)
    } catch {
      print("cannot open \(board): \(error.localizedDescription)")
      exit(1)
    }
    let id = MainActor.assumeIsolated { Library.shared.store.createBoard(title: url.deletingPathExtension().lastPathComponent, contents: loaded) }
    guard let wc = MainActor.assumeIsolated({ Library.shared.open(id) }), let window = wc.window else { exit(1) }
    if appearance == "switch" {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { NSApp.appearance = NSAppearance(named: .darkAqua) }
    }
    if defaults.string(forKey: "BreezyTurn") != nil {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { wc.canvas.turn(wc.canvas.board.cards.first { $0.notes != nil }?.id) }
    }
    if defaults.string(forKey: "BreezyEdit") != nil {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { (wc.canvas.turned ?? wc.canvas.board.cards.first?.id).map { wc.canvas.beginEdit($0) } }
    }
    if let out = defaults.string(forKey: "BreezyBench") {
      let bench = Bench(wc, out: out)
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) { bench.run() }
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

  static func capture(_ window: NSWindow, to path: String) {
    guard let image = image(of: window) else { return print("capture failed") }
    try? NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
  }

  /// The window as the window server composites it, frame included; an app may capture its own windows.
  static func image(of window: NSWindow) -> CGImage? {
    typealias Capture = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
    guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage") else { return nil }
    let create = unsafeBitCast(sym, to: Capture.self)
    // optionIncludingWindow; boundsIgnoreFraming | bestResolution
    return create(.null, 1 << 3, UInt32(window.windowNumber), 1 << 0 | 1 << 3)?.takeRetainedValue()
  }
}
