// Posts recorded trackpad strokes as scroll events, for scripts/replay.ts. Run it from Terminal.app, which holds
// Accessibility (posted events are dropped silently without it):
//
//   swift scripts/replay-helper.swift
//
// It listens on 127.0.0.1:58569 alone, hears only requests with the header X-Breezy-Replay: 1 and no Origin, which no
// web page can make, posts nothing but scroll events, and exits after an hour without a request.
//   GET /ping                                  200
//   POST /replay {app, events: [[t, dx, dy, cgPhase, cgMomentum]]}   {"posted": n}, once the last is posted
import AppKit
import ApplicationServices
import Foundation
import Network

let port: NWEndpoint.Port = 58569
let idleLimit: TimeInterval = 3600
var lastRequest = Date()

struct Replay: Decodable { let app: String; let events: [[Double]] }

func respond(_ c: NWConnection, _ status: Int, _ body: String) {
  let text = "HTTP/1.1 \(status) \(status == 200 ? "OK" : "Error")\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
  c.send(content: Data(text.utf8), completion: .contentProcessed { _ in c.cancel() })
}

/// The centre of the app's frontmost window on screen, in global display points, after bringing it forward.
func front(_ bundle: String) -> CGPoint? {
  guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first else { return nil }
  app.activate()
  Thread.sleep(forTimeInterval: 0.3)
  let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  for w in windows where (w[kCGWindowOwnerPID as String] as? pid_t) == app.processIdentifier && (w[kCGWindowLayer as String] as? Int) == 0 {
    guard let b = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b) else { continue }
    return CGPoint(x: r.midX, y: r.midY)
  }
  return nil
}

func post(_ events: [[Double]], at p: CGPoint) -> Int {
  CGWarpMouseCursorPosition(p)
  var info = mach_timebase_info()
  mach_timebase_info(&info)
  let start = mach_absolute_time()
  for e in events {
    let (t, dx, dy, phase, momentum) = (e[0], e[1], e[2], Int64(e[3]), Int64(e[4]))
    mach_wait_until(start + UInt64(t * 1e6 * Double(info.denom) / Double(info.numer)))
    guard let ev = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(dy.rounded()), wheel2: Int32(dx.rounded()), wheel3: 0) else { continue }
    ev.location = p
    ev.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
    ev.setIntegerValueField(.scrollWheelEventPointDeltaAxis1, value: Int64(dy.rounded()))
    ev.setIntegerValueField(.scrollWheelEventPointDeltaAxis2, value: Int64(dx.rounded()))
    ev.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1, value: dy)
    ev.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2, value: dx)
    ev.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase)
    ev.setIntegerValueField(.scrollWheelEventMomentumPhase, value: momentum)
    ev.post(tap: .cghidEventTap)
  }
  return events.count
}

let replays = DispatchQueue(label: "replays", qos: .userInteractive)
let scrollPhases: Set<Int64> = [0, 1, 2, 4, 8, 128], momentumPhases: Set<Int64> = [0, 1, 2, 3]

/// Events posted as given: five finite numbers each, times from 0 in order within 2 minutes, deltas a scroll's size.
func valid(_ events: [[Double]]) -> Bool {
  var last = 0.0
  for e in events {
    guard e.count == 5, e.allSatisfy(\.isFinite), e[0] >= last, e[0] <= 120_000, abs(e[1]) < 10_000, abs(e[2]) < 10_000,
      scrollPhases.contains(Int64(e[3])), momentumPhases.contains(Int64(e[4])) else { return false }
    last = e[0]
  }
  return true
}

func handle(_ c: NWConnection, _ request: Data) {
  let text = String(decoding: request, as: UTF8.self)
  let head = text.components(separatedBy: "\r\n\r\n")[0].lowercased().components(separatedBy: "\r\n")
  let line = head[0]
  // a request no web page can make: the replay header, which a browser asks leave for first, and no Origin
  guard head.contains("x-breezy-replay: 1"), !head.contains(where: { $0.hasPrefix("origin:") }) else { return respond(c, 403, "{}") }
  lastRequest = Date()
  if line.hasPrefix("get /ping ") { return respond(c, 200, "{}") }
  guard line.hasPrefix("post /replay "), let split = request.range(of: Data("\r\n\r\n".utf8)) else { return respond(c, 404, "{}") }
  guard let r = try? JSONDecoder().decode(Replay.self, from: request[split.upperBound...]), valid(r.events) else { return respond(c, 400, #"{"error":"bad replay"}"#) }
  // one at a time, so that two replays never interleave
  replays.async {
    guard let p = DispatchQueue.main.sync(execute: { front(r.app) }) else { return respond(c, 404, #"{"error":"no window of \#(r.app)"}"#) }
    respond(c, 200, #"{"posted":\#(post(r.events, at: p))}"#)
  }
}

/// Reads until the headers and the body their Content-Length names have come.
func receive(_ c: NWConnection, _ got: Data = Data()) {
  c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { data, _, done, error in
    var all = got
    if let data { all.append(data) }
    if all.count > 8 << 20 { return respond(c, 413, "{}") }
    if let split = all.range(of: Data("\r\n\r\n".utf8)) {
      let head = String(decoding: all[..<split.lowerBound], as: UTF8.self).lowercased()
      let length = head.split(separator: "\r\n").first { $0.hasPrefix("content-length:") }.flatMap { Int($0.dropFirst(15).trimmingCharacters(in: .whitespaces)) } ?? 0
      if all.count - split.upperBound >= length { return handle(c, all) }
    }
    if done || error != nil { return c.cancel() }
    receive(c, all)
  }
}

// asks macOS to prompt for the permission and list the terminal under it, whatever Settings calls the pane
if !AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary) {
  FileHandle.standardError.write(Data("This process lacks Accessibility, so posted events would be dropped: allow your terminal in the prompt or the Settings pane it opens, then start it again.\n".utf8))
  exit(1)
}
let params = NWParameters.tcp
params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: port)
let listener = try NWListener(using: params)
listener.newConnectionHandler = { c in
  c.start(queue: .main)
  receive(c)
}
listener.start(queue: .main)
Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in
  if Date().timeIntervalSince(lastRequest) > idleLimit { print("idle an hour, exiting"); exit(0) }
}
print("replay helper on 127.0.0.1:\(port)")
RunLoop.main.run()
