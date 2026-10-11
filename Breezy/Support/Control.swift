#if DEBUG
import AppKit
import BreezyKit
import Network

/// -BreezyControl <port>, in Debug builds only: scenarios drive this app as a device, one JSON command a line on 127.0.0.1:<port>, each
/// answered with one line, `reply` or `error`. Input goes to the board window as events, as the self-tests send it;
/// points are the board's screen points, from the top left of what the window shows. See scenarios/mac.ts.
@MainActor final class Control {
  private static var listener: NWListener?
  private static var pressed = false

  static func start(port: UInt16) {
    let params = NWParameters.tcp
    params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
    guard let l = try? NWListener(using: params) else { return print("control: cannot listen on \(port)") }
    l.newConnectionHandler = { c in
      c.start(queue: .main)
      receive(c, Data())
    }
    l.start(queue: .main)
    listener = l
  }

  private nonisolated static func receive(_ c: NWConnection, _ buffer: Data) {
    c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { data, _, done, error in
      var buffer = buffer + (data ?? Data())
      while let nl = buffer.firstIndex(of: 10) {
        let line = buffer[buffer.startIndex..<nl]
        buffer = Data(buffer[buffer.index(after: nl)...])
        let answer = MainActor.assumeIsolated { handle(Data(line)) }
        c.send(content: answer + Data([10]), completion: .idempotent)
      }
      if done || error != nil { return c.cancel() }
      receive(c, buffer)
    }
  }

  private static func handle(_ line: Data) -> Data {
    var answer: [String: JSONValue]
    do {
      answer = ["reply": try run(try JSONDecoder().decode(Command.self, from: line))]
    } catch {
      answer = ["error": .string("\(error)")]
    }
    // keys sorted, so that the same scene is the same line
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    return (try? encoder.encode(JSONValue.object(answer))) ?? Data("{}".utf8)
  }

  struct Failure: Error, CustomStringConvertible {
    let description: String
  }

  /// What a command line may hold.
  struct Command: Decodable {
    var cmd: String
    var link, board, title, phase, kind, chars, text: String?
    var x, y: Double?
    var code, clicks: Int?
    var shift, option, atEnd, command: Bool?

    func need<T>(_ v: T?, _ name: String) throws -> T {
      guard let v else { throw Failure(description: "\(cmd) needs \(name)") }
      return v
    }
  }

  private static var window: BoardWindowController? {
    Library.shared.documents.compactMap(\.windowController).first
  }

  private static func run(_ c: Command) throws -> JSONValue {
    let lib = Library.shared!
    switch c.cmd {
    case "join":
      guard let invite = Invite(link: try c.need(c.link, "link")) else { throw Failure(description: "not an invite link") }
      _ = lib.spaces.join(invite)
      lib.syncNow()
    case "boards":
      return .array(lib.spaces.spaces.flatMap { $0.store.boards.map { JSONValue.string($0.id) } })
    case "createBoard":
      // in the space joined, else on this device
      return .string((lib.spaces.spaces.first ?? lib.spaces.local).store.createBoard(title: try c.need(c.title, "title")))
    case "open":
      guard let wc = lib.open(try c.need(c.board, "board")) else { throw Failure(description: "no such board") }
      wc.window?.setContentSize(NSSize(width: 1200, height: 800))
    case "pointer": try pointer(c)
    case "key":
      guard let wc = window, let w = wc.window else { throw Failure(description: "no board open") }
      let chars = try c.need(c.chars, "chars")
      var mods: NSEvent.ModifierFlags = []
      if c.shift == true { mods.insert(.shift) }
      if c.command == true {
        // the menu's action along the window's responder chain, as AppKit does for the key window, which nobody makes key
        mods.insert(.command)
        guard let item = menuItem(chars, mods, in: NSApp.mainMenu!), let action = item.action else { throw Failure(description: "no menu item for ⌘\(chars)") }
        _ = w.firstResponder?.tryToPerform(action, with: item)
        return .null
      }
      let e = NSEvent.keyEvent(
        with: .keyDown, location: w.mouseLocationOutsideOfEventStream, modifierFlags: mods, timestamp: ProcessInfo.processInfo.systemUptime,
        windowNumber: w.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false,
        keyCode: UInt16(try c.need(c.code, "code")))!
      w.sendEvent(e)
    case "status":
      return .array(lib.statusLines.map(JSONValue.string) + lib.spaces.spaces.map { .string("live: \($0.live?.connected == true ? "connected" : "not connected"), pending \($0.store.pending.count)") })
    case "newLane":
      // the toolbar's New Lane: in the open spot nearest the middle of the view
      guard let wc = window else { throw Failure(description: "no board open") }
      wc.newLane(nil)
    case "type":
      guard let tv = window?.window?.firstResponder as? NSTextView else { throw Failure(description: "nothing is being edited") }
      if c.atEnd == true { tv.moveToEndOfDocument(nil) }
      tv.insertText(try c.need(c.text, "text"), replacementRange: NSRange(location: NSNotFound, length: 0))
    case "scene":
      guard let wc = window else { return .null }
      return try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(wc.canvas.core.scene))
    default: throw Failure(description: "unknown command \(c.cmd)")
    }
    return .null
  }

  private static func menuItem(_ key: String, _ mods: NSEvent.ModifierFlags, in menu: NSMenu) -> NSMenuItem? {
    for item in menu.items {
      if let sub = item.submenu, let found = menuItem(key, mods, in: sub) { return found }
      if item.keyEquivalent == key && item.keyEquivalentModifierMask == mods { return item }
    }
    return nil
  }

  /// A mouse event at a screen point of the board: down, move, up or cancel.
  private static func pointer(_ c: Command) throws {
    guard let wc = window, let w = wc.window else { throw Failure(description: "no board open") }
    if c.kind == "touch" { throw Failure(description: "the Mac has no touch") }
    let clip = wc.scrollView.contentView
    let zoom = wc.scrollView.magnification
    let s = NSPoint(x: try c.need(c.x, "x"), y: try c.need(c.y, "y"))
    let doc = NSPoint(x: clip.bounds.minX + s.x / zoom, y: clip.bounds.minY + s.y / zoom)
    let at = wc.canvas.convert(doc, to: nil)
    var mods: NSEvent.ModifierFlags = []
    if c.shift == true { mods.insert(.shift) }
    if c.option == true { mods.insert(.option) }
    let type: NSEvent.EventType
    switch try c.need(c.phase, "phase") {
    case "down":
      type = .leftMouseDown
      pressed = true
    case "move": type = pressed ? .leftMouseDragged : .mouseMoved
    case "up", "cancel":
      type = .leftMouseUp
      pressed = false
    case let phase: throw Failure(description: "unknown phase \(phase)")
    }
    let e = NSEvent.mouseEvent(
      with: type, location: at, modifierFlags: mods, timestamp: ProcessInfo.processInfo.systemUptime,
      windowNumber: w.windowNumber, context: nil, eventNumber: 0, clickCount: c.clicks ?? 1, pressure: type == .mouseMoved ? 0 : 1)!
    w.sendEvent(e)
  }
}
#endif
