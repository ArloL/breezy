import AppKit

// AppKit's own scroll view, set up as the web board's empty board at 100 %: what Breezy's edge is measured against
// (docs/superpowers/specs/2026-11-10-breezy-native-reference-design.md).
//
//   BreezyReference --stage 1200x762 --start 0,813 --name push-hold
// Each stroke goes to build/reference/<name>-<n>.json, its path on stdout; r resets to the start, q quits.

let boardSide: CGFloat = 2388

final class Board: NSView {
  override var isFlipped: Bool { true }

  override func draw(_ dirty: NSRect) {
    NSColor.black.setFill()
    dirty.fill()
    NSColor(white: 0.35, alpha: 1).setFill()
    let step: CGFloat = 25
    var y = (dirty.minY / step).rounded(.down) * step
    while y <= dirty.maxY {
      var x = (dirty.minX / step).rounded(.down) * step
      while x <= dirty.maxX {
        NSRect(x: x - 1, y: y - 1, width: 2, height: 2).fill()
        x += step
      }
      y += step
    }
    // a bar at the board's left edge, for tracking on screen
    NSColor.red.setFill()
    NSRect(x: 0, y: 0, width: 4, height: boardSide).fill()
  }
}

/// Sees each scroll event. Overriding scrollWheel also turns off responsive scrolling, which took a gesture's events
/// after the first on a background thread, past local monitors and NSApplication alike: they saw 1 of a replayed
/// push's 41. Breezy's BoardScrollView overrides it too.
final class RecordingScrollView: NSScrollView {
  var onScroll: ((NSEvent) -> Void)?
  override func scrollWheel(with e: NSEvent) {
    onScroll?(e)
    super.scrollWheel(with: e)
  }
}

final class Reference: NSObject, NSApplicationDelegate {
  let stage: CGSize, start: CGPoint, name: String, out: URL
  var window: NSWindow!
  let scroll = RecordingScrollView()
  var recorder: StrokeRecorder
  var link: CADisplayLink?
  var count = 0

  init(arguments: [String]) {
    func value(_ key: String) -> String? { arguments.firstIndex(of: key).map { arguments[$0 + 1] } }
    let s = (value("--stage") ?? "1200x762").split(separator: "x").compactMap { Double($0) }
    let p = (value("--start") ?? "0,813").split(separator: ",").compactMap { Double($0) }
    stage = CGSize(width: s[0], height: s[1])
    start = CGPoint(x: p[0], y: p[1])
    name = value("--name") ?? "stroke"
    // built into the repo's build/, as `open` starts it in /
    let repo = Bundle.main.bundlePath.components(separatedBy: "/build/").first ?? FileManager.default.currentDirectoryPath
    out = URL(fileURLWithPath: value("--out") ?? repo + "/build/reference")
    recorder = StrokeRecorder(name: name, stage: stage, start: start)
  }

  func applicationDidFinishLaunching(_ note: Notification) {
    window = NSWindow(contentRect: NSRect(origin: .zero, size: stage), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "Breezy Reference — \(name)"
    scroll.hasHorizontalScroller = false
    scroll.hasVerticalScroller = false
    scroll.horizontalScrollElasticity = .allowed
    scroll.verticalScrollElasticity = .allowed
    scroll.backgroundColor = NSColor(red: 0x1c / 255, green: 0x1c / 255, blue: 0x1e / 255, alpha: 1)
    scroll.documentView = Board(frame: NSRect(x: 0, y: 0, width: boardSide, height: boardSide))
    window.contentView = scroll
    window.center()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate()
    reset()
    scroll.onScroll = { [unowned self] e in
      recorder.event(t: e.timestamp, dx: e.scrollingDeltaX, dy: e.scrollingDeltaY, phase: e.phase.rawValue, momentum: e.momentumPhase.rawValue)
    }
    NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [unowned self] e in
      switch e.charactersIgnoringModifiers {
      case "r": reset(); return nil
      case "q": NSApp.terminate(nil); return nil
      default: return e
      }
    }
    let l = scroll.displayLink(target: self, selector: #selector(tick(_:)))
    l.add(to: .main, forMode: .common)
    link = l
    print("ready")
    fflush(stdout)
  }

  func reset() {
    scroll.contentView.scroll(to: start)
    scroll.reflectScrolledClipView(scroll.contentView)
    recorder = StrokeRecorder(name: name, stage: stage, start: start)
  }

  @objc func tick(_ l: CADisplayLink) {
    guard let s = recorder.frame(t: l.timestamp, origin: scroll.contentView.bounds.origin) else { return }
    recorder = StrokeRecorder(name: name, stage: stage, start: start)
    try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    var url: URL
    repeat {
      count += 1
      url = out.appendingPathComponent("\(name)-\(count).json")
    } while FileManager.default.fileExists(atPath: url.path)
    do {
      try JSONEncoder().encode(s).write(to: url)
      print(url.path)
      fflush(stdout)
    } catch {
      FileHandle.standardError.write(Data("can’t write \(url.path): \(error)\n".utf8))
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
}

@main
enum ReferenceMain {
  static func main() {
    let app = NSApplication.shared
    // the test host runs no window of its own
    guard ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else { return app.run() }
    let delegate = Reference(arguments: CommandLine.arguments)
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run()
  }
}
