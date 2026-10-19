// Real input for the platform scenarios: keys posted as a keyboard posts them, input sources, the emoji picker.
// Needs Accessibility permission for the terminal that runs it. Input commands refuse to run unless OSKEYS_PID, when
// set, is the frontmost process, so that keys never land in another app.
import AppKit
import Carbon

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("oskeys: \(message)\n".utf8))
  exit(1)
}

func need<T>(_ value: T?, _ message: String) -> T {
  guard let value else { fail(message) }
  return value
}

let codes: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
  "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
  "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
  "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50, " ": 49,
  "return": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53, "forwarddelete": 117,
  "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119,
]
let modifiers: [String: (CGEventFlags, CGKeyCode)] = [
  "cmd": (.maskCommand, 55), "shift": (.maskShift, 56), "opt": (.maskAlternate, 58), "ctrl": (.maskControl, 59),
  "fn": (.maskSecondaryFn, 63),
]

nonisolated(unsafe) let source = CGEventSource(stateID: .hidSystemState)

func post(_ code: CGKeyCode, _ flags: CGEventFlags, down: Bool) {
  let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)!
  e.flags = flags
  e.post(tap: .cghidEventTap)
}

/// Presses `code` with `mods` held, each modifier going down and up as on a keyboard.
func press(_ code: CGKeyCode, _ mods: [String] = []) {
  var flags: CGEventFlags = []
  for m in mods {
    guard let (flag, key) = modifiers[m] else { fail("no modifier \(m)") }
    flags.insert(flag)
    post(key, flags, down: true)
  }
  post(code, flags, down: true)
  usleep(8_000)
  post(code, flags, down: false)
  for m in mods.reversed() {
    let (flag, key) = modifiers[m]!
    flags.remove(flag)
    post(key, flags, down: false)
  }
  usleep(30_000)
}

/// The Globe key alone: fn down and up, as the keyboard sends it.
func globe() {
  for flags in [CGEventFlags.maskSecondaryFn, []] {
    let e = CGEvent(keyboardEventSource: source, virtualKey: 63, keyDown: !flags.isEmpty)!
    e.type = .flagsChanged
    e.flags = flags
    e.post(tap: .cghidEventTap)
    usleep(60_000)
  }
}

func typeKeys(_ s: String) {
  for c in s {
    guard let code = codes[String(c).lowercased()] else { fail("no US key for \(c)") }
    press(code, c.isUppercase ? ["shift"] : [])
  }
}

func text(_ s: String) {
  for c in s {
    let u = Array(String(c).utf16)
    for down in [true, false] {
      let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)!
      e.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u)
      e.post(tap: .cghidEventTap)
    }
    usleep(30_000)
  }
}

/// NSWorkspace learns of a switch only as its run loop runs.
func frontmost() -> pid_t {
  RunLoop.current.run(until: Date() + 0.05)
  return NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
}

func isFront(_ pid: pid_t) -> Bool {
  var value: CFTypeRef?
  AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXFrontmostAttribute as CFString, &value)
  return (value as? Bool) == true
}

func activate(_ pid: pid_t) {
  let app = AXUIElementCreateApplication(pid)
  // asked again until it holds: just after ⌘Tab the switch back can be dropped
  for _ in 0..<50 where !isFront(pid) {
    AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    usleep(100_000)
  }
  if !isFront(pid) { fail("\(pid) did not come to the front") }
}

func inputSourceID(_ s: TISInputSource) -> String {
  Unmanaged<CFString>.fromOpaque(TISGetInputSourceProperty(s, kTISPropertyInputSourceID)).takeUnretainedValue() as String
}

func currentSource() -> String { inputSourceID(TISCopyCurrentKeyboardInputSource().takeRetainedValue()) }

/// Selects input source `id`, enabling it and the input method it is a mode of, as adding it in System Settings does.
func selectSource(_ id: String) {
  let all = TISCreateInputSourceList(nil, true).takeRetainedValue() as! [TISInputSource]
  guard let s = all.first(where: { inputSourceID($0) == id }) else { fail("no input source \(id)") }
  for method in all where id.hasPrefix(inputSourceID(method) + ".") { TISEnableInputSource(method) }
  TISEnableInputSource(s)
  guard TISSelectInputSource(s) == noErr else { fail("cannot select \(id)") }
  for _ in 0..<50 where currentSource() != id { usleep(100_000) }
  if currentSource() != id { fail("\(id) did not become current") }
  // an input method's process takes a moment to start taking keys
  if id.contains(".inputmethod.") { usleep(1_500_000) }
}

/// Input commands only reach the process the run is about.
func guardFront() {
  guard let want = ProcessInfo.processInfo.environment["OSKEYS_PID"].flatMap(pid_t.init) else { return }
  if !isFront(want) { fail("\(frontmost()) is frontmost, not \(want): refusing to type") }
}

let args = Array(CommandLine.arguments.dropFirst())
switch (args.first, args.count) {
case ("trusted", 1):
  exit(AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary) ? 0 : 1)
case ("frontmost", 1):
  print(frontmost())
case ("activate", 2):
  activate(need(pid_t(args[1]), "not a pid: \(args[1])"))
case ("key", 2) where args[1] == "globe":
  guardFront()
  globe()
case ("key", 2), ("key", 3):
  guardFront()
  press(need(codes[args[1]], "no key \(args[1])"), args.count == 3 ? args[2].split(separator: "+").map(String.init) : [])
case ("type", 2):
  guardFront()
  typeKeys(args[1])
case ("text", 2):
  guardFront()
  text(args[1])
case ("source", 1):
  print(currentSource())
case ("source", 2):
  print(currentSource())
  selectSource(args[1])
case ("emoji", 2):
  guardFront()
  press(codes["space"]!, ["ctrl", "cmd"])
  usleep(900_000)
  // the picker has the keyboard now, not the process OSKEYS_PID names
  text(args[1])
  usleep(600_000)
  // into the results, onto the first
  press(codes["down"]!)
  usleep(300_000)
  press(codes["return"]!)
case ("click", 3):
  let p = CGPoint(x: need(Double(args[1]), "not a number: \(args[1])"), y: need(Double(args[2]), "not a number: \(args[2])"))
  for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
    CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: .left)!.post(tap: .cghidEventTap)
    usleep(40_000)
  }
case ("away", 2):
  let pid = need(pid_t(args[1]), "not a pid: \(args[1])")
  press(codes["tab"]!, ["cmd"])
  for _ in 0..<50 where isFront(pid) { usleep(100_000) }
  if isFront(pid) { fail("⌘Tab left \(pid) frontmost") }
  usleep(700_000)
  activate(pid)
default:
  fail("""
    usage: oskeys trusted | frontmost | activate PID | key NAME [cmd+ctrl+opt+shift] | type ASCII | text STRING
           | source [ID] | emoji NAME | click X Y | away PID
    """)
}
