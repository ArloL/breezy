import Foundation

/// What the Mac app saw, decided and drew, as web/flight.ts keeps it in the web app, in the same format, so that a Mac
/// recording reads as a web one does: ids, numbers and names of what the app does, never a card's words. See
/// docs/superpowers/specs/2026-10-28-breezy-facts-first-design.md.
public final class Flight: @unchecked Sendable {
  public enum Kind: String, Codable, Sendable {
    case context, geometry, decision, transition, input, sync, life, timing, error
  }

  /// `t` ms after the recording's origin on the wall clock.
  public struct Entry: Encodable, Sendable {
    public let t: Double
    public let kind: Kind
    public let what: String
    public let data: [String: JSONValue]?

    public func encode(to encoder: Encoder) throws {
      var c = encoder.unkeyedContainer()
      try c.encode(t)
      try c.encode(kind)
      try c.encode(what)
      if let data { try c.encode(data) }
    }
  }

  public struct Recording: Encodable, Sendable {
    public let schema = 1
    public let origin: Double
    /// How many older entries the ring let go.
    public let dropped: Int
    /// Which device and build, kept apart from the ring, which a long session overwrites.
    public let context: [String: JSONValue]?
    public let entries: [Entry]

    private enum CodingKeys: String, CodingKey { case schema, origin, dropped, context, entries }

    /// `context` as null when there is none, as the web app writes it, where Codable would leave the key out.
    public func encode(to encoder: Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(schema, forKey: .schema)
      try c.encode(origin, forKey: .origin)
      try c.encode(dropped, forKey: .dropped)
      try c.encode(context, forKey: .context)
      try c.encode(entries, forKey: .entries)
    }
  }

  private let now: () -> Double
  private let size: Int
  private let origin: Double
  private var ring: [Entry] = []
  private var next = 0
  private var dropped = 0
  private var about: [String: JSONValue]?
  private let lock = NSLock()

  public init(now: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime * 1000 },
              wall: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }, size: Int = 4000) {
    self.now = now
    self.size = size
    origin = wall() - now()
  }

  public func note(_ kind: Kind, _ what: String, _ data: [String: JSONValue]? = nil) {
    let e = Entry(t: (now() * 10).rounded() / 10, kind: kind, what: what, data: data)
    lock.lock()
    defer { lock.unlock() }
    if ring.count < size { ring.append(e) } else {
      ring[next] = e
      dropped += 1
    }
    next = (next + 1) % size
  }

  public func context(_ data: [String: JSONValue]) {
    lock.lock()
    defer { lock.unlock() }
    about = data
  }

  public func recording() -> Recording {
    lock.lock()
    defer { lock.unlock() }
    let entries = ring.count < size ? ring : Array(ring[next...] + ring[..<next])
    return Recording(origin: origin, dropped: dropped, context: about, entries: entries)
  }
}

public extension Rect {
  /// As web/flight.ts's `box`: [x, y, w, h] to a tenth.
  var box: JSONValue { .array([x, y, w, h].map { .number(($0 * 10).rounded() / 10) }) }
}
