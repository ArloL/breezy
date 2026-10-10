import BreezyKit
import Foundation
import Testing
@testable import BreezySim

/// Plays the hub for a script: a canned server that takes every push and has nothing to pull, a relay that welcomes
/// with one other connection, and channels whose offers succeed. Returns every answer line.
private func play(_ send: (String) async -> String) async -> [String] {
  var lines: [String] = []
  var version = 0
  var id = 0
  func command(_ c: [String: Any]) async -> [JSONValue] {
    id += 1
    let c = c.merging(["id": id]) { a, _ in a }
    let line = await send(String(decoding: try! JSONSerialization.data(withJSONObject: c, options: [.sortedKeys]), as: UTF8.self))
    lines.append(line)
    return (try? JSONDecoder().decode(JSONValue.self, from: Data(line.utf8)))?["out"]?.array ?? []
  }
  func respond(_ events: [JSONValue]) async {
    var queue = events
    while !queue.isEmpty {
      let e = queue.removeFirst()
      let dev = e["dev"]!.int!
      switch e["ev"]?.string {
      case "http":
        var body: [String: Any] = ["epoch": "e1", "relay": "ws://127.0.0.1:8787/"]
        if e["method"]?.string == "POST" {
          var data = Base64URL.decode(e["body"]!.string!)!
          if e["headers"]?["Content-Encoding"]?.string == "deflate" { data = try! (data as NSData).decompressed(using: .zlib) as Data }
          let writes = (try! JSONDecoder().decode(JSONValue.self, from: data))["writes"]!.array!
          body["accepted"] = writes.map { w -> [String: Any] in
            version += 1
            return ["id": w["id"]!.string!, "version": version]
          }
          body["refused"] = []
        } else {
          body["records"] = []
          body["cursor"] = version
        }
        let b = Base64URL.encode(try! JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]))
        queue += await command(["cmd": "http", "dev": dev, "req": e["req"]!.int!, "status": 200, "body": b])
      case "ws-connect": queue += await command(["cmd": "ws-open", "dev": dev, "sock": e["sock"]!.int!])
      case "ws-send" where e["text"]?.string?.contains(#""t":"auth""#) == true:
        let welcome = #"{"t":"welcome","id":"c1","peers":["c2"],"holds":{}}"#
        queue += await command(["cmd": "ws-msg", "dev": dev, "sock": e["sock"]!.int!, "text": welcome])
      case "peer-offer": queue += await command(["cmd": "peer-done", "dev": dev, "call": e["call"]!.int!, "value": "offer-sdp"])
      default: break
      }
    }
  }
  func run(_ c: [String: Any]) async -> JSONValue? {
    let out = await command(c)
    let reply = (try? JSONDecoder().decode(JSONValue.self, from: Data(lines.last!.utf8)))?["reply"]
    await respond(out)
    return reply
  }

  _ = await run(["cmd": "new", "dev": 0, "me": ["device": Base64URL.encode(Data(repeating: 1, count: 16)), "name": "A"], "seed": 42])
  _ = await run(["cmd": "op", "dev": 0, "op": ["op": "newSpace", "server": "http://127.0.0.1:8080/sync.php", "name": "Team"]])
  let board = await run(["cmd": "op", "dev": 0, "op": ["op": "createBoard", "title": "Plan"]])?["board"]?.string ?? ""
  _ = await run(["cmd": "op", "dev": 0, "op": ["op": "open", "board": board]])
  for op: [String: Any] in [
    ["op": "addCard", "x": 0, "y": 0], ["op": "addCard", "x": 300, "y": 0], ["op": "type", "n": 1, "text": "Hello\nthere"],
    ["op": "press", "n": 0, "count": 2, "lane": false], ["op": "drag", "dx": 50, "dy": 20], ["op": "release"],
    ["op": "color", "n": 0, "count": 1, "color": 3], ["op": "undo"], ["op": "addLane", "x": 0, "y": 400],
    ["op": "cursor", "x": 10, "y": 20], ["op": "press", "n": 0, "count": 1, "lane": true], ["op": "drag", "dx": 24, "dy": 0],
    ["op": "cancel"], ["op": "delete", "n": 0, "count": 1],
  ] {
    _ = await run(["cmd": "op", "dev": 0, "op": op])
  }
  for t in stride(from: 500, through: 12_000, by: 500) {
    _ = await run(["cmd": "time", "t": t])
    _ = await run(["cmd": "fire", "dev": 0])
  }
  _ = await run(["cmd": "state", "dev": 0])
  return lines
}

@MainActor private func inProcess(_ root: String) async -> [String] {
  let host = SimHost(root: FileManager.default.temporaryDirectory.appendingPathComponent("sim-test-\(root)-\(UUID().uuidString)"))
  defer { host.close() }
  return await play { await host.handle($0) }
}

/// The built binary, beside the test bundle or in the package's .build/debug.
private var binary: URL? {
  let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
  let dirs = Bundle.allBundles.map { $0.bundleURL.deletingLastPathComponent() } + [package.appendingPathComponent(".build/debug")]
  return dirs.map { $0.appendingPathComponent("breezy-sim") }.first { FileManager.default.isExecutableFile(atPath: $0.path) }
}

private func subprocess(_ url: URL) async throws -> [String] {
  let p = Process()
  p.executableURL = url
  let input = Pipe(), output = Pipe()
  p.standardInput = input
  p.standardOutput = output
  try p.run()
  defer { try? input.fileHandleForWriting.close() }
  var buffer = Data()
  return await play { line in
    input.fileHandleForWriting.write(Data((line + "\n").utf8))
    while true {
      if let nl = buffer.firstIndex(of: 10) {
        let answer = String(decoding: buffer[..<nl], as: UTF8.self)
        buffer.removeSubrange(...nl)
        return answer
      }
      let more = output.fileHandleForReading.availableData
      if more.isEmpty { return "" }
      buffer += more
    }
  }
}

@Suite(.serialized) struct SimHostTests {
  @MainActor @Test func theSameScriptGivesTheSameAnswers() async {
    let a = await inProcess("a"), b = await inProcess("b")
    #expect(a == b)
    let last = try! JSONDecoder().decode(JSONValue.self, from: Data(a.last!.utf8))
    #expect(last["reply"]?["status"]?.string == "synced")
    #expect(last["reply"]?["pending"]?.int == 0)
    let cards = last["reply"]?["boards"]?.object?.values.first?["cards"]?.array ?? []
    #expect(cards.contains { $0["text"]?.string == "Hello\nthere" })
    #expect(a.contains { $0.contains(#""ev":"peer-offer""#) })
    #expect(!a.contains { $0.contains(#""error""#) })
  }

  @Test func theBinaryGivesTheSameAnswersInEveryProcess() async throws {
    let url = try #require(binary)
    let a = try await subprocess(url), b = try await subprocess(url)
    #expect(a.count > 40)
    #expect(a == b)
  }

  @MainActor @Test func aRequestCancelledWhileWithTheHubAnswersCancelledAndTheHubIsTold() async {
    let host = SimHost(root: FileManager.default.temporaryDirectory.appendingPathComponent("sim-test-\(UUID().uuidString)"))
    defer { host.close() }
    _ = await host.handle(#"{"cmd":"new","dev":0,"me":{"device":"AQEBAQEBAQEBAQEBAQEBAQ","name":"A"},"seed":1}"#)
    let made = await host.handle(#"{"cmd":"op","dev":0,"op":{"op":"newSpace","server":"http://127.0.0.1:8080/sync.php","name":"S"}}"#)
    #expect(made.contains(#""ev":"http""#) && made.contains(#""req":1"#))
    _ = await host.handle(#"{"cmd":"time","t":1500}"#)
    let retried = await host.handle(#"{"cmd":"op","dev":0,"op":{"op":"retry","changed":true}}"#)
    #expect(retried.contains(#"{"dev":0,"ev":"http-cancel","req":1}"#))
    #expect(retried.contains(#""req":2"#))
    // the answer to the cancelled request goes nowhere
    let late = await host.handle(#"{"cmd":"http","dev":0,"req":1,"status":200,"body":""}"#)
    #expect(late.contains(#""out":[]"#))
  }

  @MainActor @Test func aRequestTheHubNeverAnswersTimesOutAfter20s() async {
    let host = SimHost(root: FileManager.default.temporaryDirectory.appendingPathComponent("sim-test-\(UUID().uuidString)"))
    defer { host.close() }
    _ = await host.handle(#"{"cmd":"new","dev":0,"me":{"device":"AQEBAQEBAQEBAQEBAQEBAQ","name":"A"},"seed":1}"#)
    _ = await host.handle(#"{"cmd":"op","dev":0,"op":{"op":"newSpace","server":"http://127.0.0.1:8080/sync.php","name":"S"}}"#)
    _ = await host.handle(#"{"cmd":"time","t":19999}"#)
    #expect(!(await host.handle(#"{"cmd":"fire","dev":0}"#)).contains("http-cancel"))
    _ = await host.handle(#"{"cmd":"time","t":20000}"#)
    #expect(await host.handle(#"{"cmd":"fire","dev":0}"#).contains(#""ev":"http-cancel","req":1"#))
    #expect(await host.handle(#"{"cmd":"state","dev":0}"#).contains(#""status":"unreachable""#))
  }

  @MainActor @Test func settlingWaitsOutAChainOfTasksAndGivesUpOnOneThatNeverStops() async {
    Serial.install()
    defer { Serial.uninstall() }
    var done = false
    Task {
      for _ in 0..<20 { await Task.yield() }
      done = true
    }
    #expect(await Serial.settle(cap: 1_000_000))
    #expect(done)
    let spinner = Task { while !Task.isCancelled { await Task.yield() } }
    #expect(!(await Serial.settle(cap: 1000)))
    spinner.cancel()
  }
}
