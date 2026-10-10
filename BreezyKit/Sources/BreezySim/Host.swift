import BreezyKit
import Foundation

/// The fuzzer hub's Swift devices on virtual time; see the wire protocol in the convergence fuzzing plan. Each command
/// is one JSON line, answered with one: `re` (its `id`, else its index), `out` (what devices emitted meanwhile), `next`
/// (each device's earliest timer, ms, or null), and `reply` or `error`.
///
/// Idle detection: `Serial` runs every Swift job of the process on the main queue, the global executor's included, so
/// work runs in the order it was enqueued and nothing runs beside the host; otherwise nonisolated code such as
/// `HTTPTransport`'s would run on the thread pool, unseen by the host and in no fixed order. After a command, and after
/// each timer a `fire` runs, the host yields until a round in which no task but its own was enqueued: every task then
/// waits on the hub (a request, a call or a timer). Past `cap` rounds, or `cap` timers in one `fire`, it answers
/// `"error": "did not settle"`.
@MainActor public final class SimHost {
  public nonisolated static let cap = 10_000
  private let cap: Int
  private let root: URL
  private var devices: [Int: SimDevice] = [:]
  private(set) var t: Double = 0
  private(set) var skew: [Int: Double] = [:]
  private var out: [JSONValue] = []
  private var count = 0

  /// Device directories go under `root`, which starts empty and which `close` removes. Its name is new each time: a
  /// process id comes round again, and a sim killed before `close` leaves its directory behind.
  public init(
    cap: Int = SimHost.cap,
    root: URL = FileManager.default.temporaryDirectory.appendingPathComponent("breezy-sim-\(getpid())-\(UUID().uuidString)")
  ) {
    self.cap = cap
    self.root = root
    try? FileManager.default.removeItem(at: root)
    Serial.install()
  }

  public func close() {
    devices = [:]
    try? FileManager.default.removeItem(at: root)
    Serial.uninstall()
  }

  func emit(_ event: Fields) { out.append(.object(event)) }

  /// One command line → its answer line.
  public func handle(_ line: String) async -> String {
    count += 1
    out = []
    var answer: Fields = ["re": .int(count - 1)]
    do {
      let c = try JSONDecoder().decode(JSONValue.self, from: Data(line.utf8))
      if let id = c["id"] { answer["re"] = id }
      if let reply = try await run(c) { answer["reply"] = reply }
    } catch let e as SimError {
      answer["error"] = .string(e.message)
    } catch {
      answer["error"] = .string("\(error)")
    }
    answer["out"] = .array(out)
    answer["next"] = .object(Dictionary(uniqueKeysWithValues: devices.map { i, d in (String(i), d.next.map(JSONValue.number) ?? .null) }))
    return Wire.line(.object(answer))
  }

  private func device(_ c: JSONValue) throws -> SimDevice {
    let i = try c.int("dev")
    guard let d = devices[i] else { throw SimError("no device \(i)") }
    return d
  }

  private func run(_ c: JSONValue) async throws -> JSONValue? {
    let cmd = try c.string("cmd")
    switch cmd {
    case "new":
      let i = try c.int("dev"), me = try c.required("me")
      guard devices[i] == nil else { throw SimError("device \(i) exists") }
      let seed = try c.number("seed")
      devices[i] = try SimDevice(
        i, me: Person(device: try me.string("device"), name: me["name"]?.string ?? ""),
        seed: seed < 0 ? UInt64(bitPattern: Int64(seed)) : UInt64(seed), directory: root.appendingPathComponent("\(i)"), host: self)
    case "time":
      t = try c.number("t")
      // a device the skew leaves out reads `t`
      if let s = c["skew"]?.object {
        skew = Dictionary(uniqueKeysWithValues: s.compactMap { k, v in Int(k).flatMap { i in v.number.map { (i, $0) } } })
      }
      return nil
    case "fire":
      let d = try device(c)
      var fired = 0
      while let work = d.due(by: t) {
        fired += 1
        guard fired <= cap else { throw SimError("did not settle") }
        d.run(work)
        try await settle()
      }
      return nil
    case "op":
      let d = try device(c)
      let reply = try d.run { try d.op(try c.required("op")) }
      try await settle()
      return reply
    case "http": try device(c).run { try device(c).answer(c) }
    case "ws-open", "ws-msg", "ws-close": try device(c).run { try device(c).socket(cmd, c) }
    case "peer-done": try device(c).run { try device(c).peerDone(c) }
    case "peer-state", "peer-msg", "peer-candidate": try device(c).run { try device(c).peer(cmd, c) }
    case "state":
      let d = try device(c)
      return d.run { d.snapshot() }
    default: throw SimError("unknown command \(cmd)")
    }
    try await settle()
    return nil
  }

  private func settle() async throws {
    guard await Serial.settle(cap: cap) else { throw SimError("did not settle") }
  }
}
