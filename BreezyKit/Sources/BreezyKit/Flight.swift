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

  /// The last seconds of frames, as web/flight.ts's `FrameTrack`: `fields` once, then a row a frame.
  public struct FrameTrack: Encodable, Sendable, Equatable {
    public let fields: [String]
    public let rows: [[Double?]]
  }

  /// What a frame holds, in order, as scripts/frames/fields.json lists them: every platform's, then the Mac's.
  public static let frameFields = [
    "t", "zoom", "camX", "camY", "viewW", "viewH", "boardX", "boardY", "boardW", "boardH", "px", "py", "f1x", "f1y", "f2x", "f2y",
    "wheelDX", "wheelDY", "wheelPhase", "momentumPhase", "magnify", "gesture", "knobH", "knobV", "grey",
  ]

  public struct Recording: Encodable, Sendable {
    public let schema = 1
    public let origin: Double
    /// How many older entries the ring let go.
    public let dropped: Int
    /// Which device and build, kept apart from the ring, which a long session overwrites.
    public let context: [String: JSONValue]?
    public let entries: [Entry]
    public let frames: FrameTrack?

    private enum CodingKeys: String, CodingKey { case schema, origin, dropped, context, entries, frames }

    /// `context` as null when there is none, as the web app writes it, where Codable would leave the key out.
    public func encode(to encoder: Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(schema, forKey: .schema)
      try c.encode(origin, forKey: .origin)
      try c.encode(dropped, forKey: .dropped)
      try c.encode(context, forKey: .context)
      try c.encode(entries, forKey: .entries)
      try c.encodeIfPresent(frames, forKey: .frames)
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
  private let frameMs: Double
  private var frameRows: [[Double?]] = []
  private var frameHead = 0

  public init(now: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime * 1000 },
              wall: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }, size: Int = 4000, frameSeconds: Double = 30) {
    self.now = now
    self.size = size
    frameMs = frameSeconds * 1000
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

  /// Keeps a frame of every field after `t`, which it stamps on the entries' clock; frames older than `frameSeconds` go.
  /// A frame of another length is not kept.
  public func frame(_ values: [Double?]) {
    guard values.count == Self.frameFields.count - 1 else { return }
    let t = (now() * 10).rounded() / 10
    lock.lock()
    defer { lock.unlock() }
    frameRows.append([t] + values)
    while frameHead < frameRows.count, frameRows[frameHead][0]! < t - frameMs { frameHead += 1 }
    // compacts now and then, rather than shifting the array on every frame
    if frameHead > 4096 {
      frameRows.removeFirst(frameHead)
      frameHead = 0
    }
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
    let frames = frameHead < frameRows.count ? FrameTrack(fields: Self.frameFields, rows: Array(frameRows[frameHead...])) : nil
    return Recording(origin: origin, dropped: dropped, context: about, entries: entries, frames: frames)
  }
}

public extension Rect {
  /// As web/flight.ts's `box`: [x, y, w, h] to a tenth.
  var box: JSONValue { .array([x, y, w, h].map { .number(($0 * 10).rounded() / 10) }) }
}
