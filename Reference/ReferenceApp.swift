import AppKit

// AppKit's own scroll view, set up as the web board's empty board at 100 %: what Breezy's edge is measured against
// (docs/superpowers/specs/2026-11-10-breezy-native-reference-design.md).
//
//   BreezyReference --stage 1200x762 --start 0,813 --name push-hold
// Each stroke goes to build/reference/<name>-<n>.json, its path on stdout; r resets to the start, q quits.
//   BreezyReference --zoom --stage 1200x800 --name pinch-out [--replay <stroke.json>]
// A 40,032 pt board that zooms from 25 % to 200 %, as main's Mac board, each stroke a frame track and its events
// (FrameWriter); --replay hands a stroke's events to the window in the app (RawReplay), keeps what they did as
// <name>-replay-<n>.json and quits.

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
  var onMagnify: ((NSEvent) -> Void)?
  override func scrollWheel(with e: NSEvent) {
    onScroll?(e)
    super.scrollWheel(with: e)
  }
  override func magnify(with e: NSEvent) {
    onMagnify?(e)
    super.magnify(with: e)
  }
  override func smartMagnify(with e: NSEvent) {
    onMagnify?(e)
    super.smartMagnify(with: e)
  }
}

final class Reference: NSObject, NSApplicationDelegate {
  let stage: CGSize, start: CGPoint, name: String, out: URL
  var window: NSWindow!
  /// `--stock` measures NSScrollView as it comes, responsive scrolling on: it sees a gesture's first event alone, so
  /// each stroke runs 4 s.
  let stock: Bool
  lazy var scroll: NSScrollView = stock ? NSScrollView() : RecordingScrollView()
  var recorder: StrokeRecorder
  var link: CADisplayLink?
  var count = 0
  var saved = 0
  /// --zoom: a board to pinch, as main's Mac board, recorded as frames.
  let zoom: Bool
  let replay: String?
  var writer: FrameWriter

  init(arguments: [String]) {
    func value(_ key: String) -> String? { arguments.firstIndex(of: key).map { arguments[$0 + 1] } }
    let s = (value("--stage") ?? "1200x762").split(separator: "x").compactMap { Double($0) }
    let p = (value("--start") ?? "0,813").split(separator: ",").compactMap { Double($0) }
    stage = CGSize(width: s[0], height: s[1])
    start = CGPoint(x: p[0], y: p[1])
    name = value("--name") ?? "stroke"
    stock = arguments.contains("--stock")
    zoom = arguments.contains("--zoom")
    replay = value("--replay")
    writer = FrameWriter(name: name)
    // built into the repo's build/, as `open` starts it in /
    let repo = Bundle.main.bundlePath.components(separatedBy: "/build/").first ?? FileManager.default.currentDirectoryPath
    out = URL(fileURLWithPath: value("--out") ?? repo + "/build/reference")
    recorder = StrokeRecorder(name: name, stage: stage, start: start, endAfter: stock ? 4000 : nil)
  }

  func applicationDidFinishLaunching(_ note: Notification) {
    if zoom { return zoomMode() }
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
    if stock {
      NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [unowned self] e in
        if let s = recorder.event(t: e.timestamp, dx: e.scrollingDeltaX, dy: e.scrollingDeltaY, phase: e.phase.rawValue, momentum: e.momentumPhase.rawValue) { save(s) }
        return e
      }
    }
    (scroll as? RecordingScrollView)?.onScroll = { [unowned self] e in
      if let s = recorder.event(t: e.timestamp, dx: e.scrollingDeltaX, dy: e.scrollingDeltaY, phase: e.phase.rawValue, momentum: e.momentumPhase.rawValue) { save(s) }
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
    recorder = StrokeRecorder(name: name, stage: stage, start: start, endAfter: stock ? 4000 : nil)
  }

  @objc func tick(_ l: CADisplayLink) {
    guard let s = recorder.frame(t: l.timestamp, origin: scroll.contentView.bounds.origin) else { return }
    recorder = StrokeRecorder(name: name, stage: stage, start: start, endAfter: stock ? 4000 : nil)
    save(s)
  }

  func save(_ s: Stroke) {
    try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    var url: URL
    repeat {
      count += 1
      url = out.appendingPathComponent("\(name)-\(count).json")
    } while FileManager.default.fileExists(atPath: url.path)
    do {
      try JSONEncoder().encode(s).write(to: url)
      saved += 1
      window.title = "Breezy Reference — \(name): \(saved) saved"
      print(url.path)
      fflush(stdout)
    } catch {
      FileHandle.standardError.write(Data("can’t write \(url.path): \(error)\n".utf8))
    }
  }

  // MARK: --zoom

  let zoomSide: CGFloat = 40032

  func zoomMode() {
    window = NSWindow(contentRect: NSRect(origin: .zero, size: stage), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "Breezy Reference — \(name)"
    scroll.hasHorizontalScroller = true
    scroll.hasVerticalScroller = true
    scroll.allowsMagnification = true
    scroll.minMagnification = 0.25
    scroll.maxMagnification = 2
    scroll.backgroundColor = NSColor(red: 0x1c / 255, green: 0x1c / 255, blue: 0x1e / 255, alpha: 1)
    scroll.documentView = Board(frame: NSRect(x: 0, y: 0, width: zoomSide, height: zoomSide))
    window.contentView = scroll
    window.center()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate()
    zoomReset()
    let rs = scroll as! RecordingScrollView
    rs.onMagnify = { [unowned self] e in
      let phase: FrameWriter.Phase = e.phase.contains(.began) ? .began : e.phase.contains(.ended) || e.phase.contains(.cancelled) ? .ended : .changed
      writer.magnify(t: CACurrentMediaTime(), by: e.type == .magnify ? e.magnification : 0, phase: e.type == .magnify ? phase : .ended, at: viewPoint(e), raw: e.cgEvent?.data as Data?)
    }
    rs.onScroll = { [unowned self] e in
      writer.scroll(t: CACurrentMediaTime(), dx: e.scrollingDeltaX, dy: e.scrollingDeltaY, phase: e.phase.rawValue, momentum: e.momentumPhase.rawValue,
                    at: viewPoint(e), raw: e.cgEvent?.data as Data?)
    }
    NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [unowned self] e in
      switch e.charactersIgnoringModifiers {
      case "r": zoomReset(); return nil
      case "q": NSApp.terminate(nil); return nil
      default: return e
      }
    }
    let l = scroll.displayLink(target: self, selector: #selector(zoomTick(_:)))
    l.add(to: .main, forMode: .common)
    link = l
    print("ready")
    fflush(stdout)
    guard let replay else { return }
    // a replay that never ends its stroke still ends
    Timer.scheduledTimer(withTimeInterval: 120, repeats: false) { _ in exit(2) }
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [self] in
      guard let data = FileManager.default.contents(atPath: replay), let s = try? JSONDecoder().decode(FrameWriter.Stroke.self, from: data) else {
        FileHandle.standardError.write(Data("can’t read \(replay)\n".utf8))
        exit(1)
      }
      zoomReset()
      RawReplay.play(s.raw, recorded: s.window, into: window) { n in print("handed \(n) of \(s.raw.count)"); fflush(stdout) }
    }
  }

  /// Where `e` was, in the view's points from its top left.
  func viewPoint(_ e: NSEvent) -> CGPoint {
    let clip = scroll.contentView, q = clip.convert(e.locationInWindow, from: nil), z = scroll.magnification
    return CGPoint(x: (q.x - clip.bounds.minX) * z, y: (q.y - clip.bounds.minY) * z)
  }

  func zoomReset() {
    scroll.magnification = 1
    scroll.contentView.scroll(to: NSPoint(x: zoomSide / 2 - stage.width / 2, y: zoomSide / 2 - stage.height / 2))
    scroll.reflectScrolledClipView(scroll.contentView)
    writer = FrameWriter(name: name)
    writer.window = MainActor.assumeIsolated { RawReplay.cgFrame(window) }
  }

  @objc func zoomTick(_ l: CADisplayLink) {
    let clip = scroll.contentView
    let shown = FrameWriter.Shown(zoom: scroll.magnification, cam: clip.bounds.origin, view: clip.frame.size,
                                  board: scroll.documentView!.bounds, knobH: scroll.horizontalScroller.map { Double($0.knobProportion) },
                                  knobV: scroll.verticalScroller.map { Double($0.knobProportion) })
    guard let s = writer.frame(t: l.timestamp, shown: shown) else { return }
    writer = FrameWriter(name: name)
    writer.window = MainActor.assumeIsolated { RawReplay.cgFrame(window) }
    saveZoom(s)
  }

  func saveZoom(_ s: FrameWriter.Stroke) {
    try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    let base = replay == nil ? name : "\(name)-replay"
    var url: URL
    repeat {
      count += 1
      url = out.appendingPathComponent("\(base)-\(count).json")
    } while FileManager.default.fileExists(atPath: url.path)
    do {
      try JSONEncoder().encode(s).write(to: url)
      saved += 1
      window.title = "Breezy Reference — \(name): \(saved) saved"
      print(url.path)
      fflush(stdout)
      if replay != nil { NSApp.terminate(nil) }
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
