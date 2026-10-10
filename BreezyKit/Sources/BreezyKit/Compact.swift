import Foundation

/// Compact cursor and live bodies for v2 links: MessagePack arrays with deltas, splices and groups; see the lean sync
/// design. Order on the wire: items and group ids by their id's bytes, fields by key ascending.
public enum Compact {
  public static let keyframe: TimeInterval = 1
  public static let fields = ["pos", "size", "w", "text", "notes", "color", "title", "kind", "gone"]
  static let kinds = ["card", "lane"]
  static let texts: Set<String> = ["text", "notes", "title"]
  /// Group members' offsets count as equal this close.
  static let epsilon = 1e-6

  public enum Failure: Error { case input(String) }

  public static func isCompact(_ d: Data) -> Bool {
    guard let b = d.first else { return false }
    return b & 0xf0 == 0x90 || b == 0xdc
  }

  /// FNV-1a 32 over UTF-16 code units.
  public static func fnv1a(_ s: String) -> UInt32 {
    s.utf16.reduce(0x811c_9dc5) { ($0 ^ UInt32($1)) &* 0x0100_0193 }
  }

  /// The splice turning `a` into `b`, in UTF-16 units, never splitting a surrogate pair.
  public static func splice(_ a: String, _ b: String) -> (at: Int, del: Int, ins: String) {
    let x = Array(a.utf16), y = Array(b.utf16), n = min(x.count, y.count)
    var p = 0
    while p < n && x[p] == y[p] { p += 1 }
    if p > 0 && UTF16.isLeadSurrogate(x[p - 1]) { p -= 1 }
    var s = 0
    while s < n - p && x[x.count - 1 - s] == y[y.count - 1 - s] { s += 1 }
    if s > 0 && UTF16.isTrailSurrogate(x[x.count - s]) { s -= 1 }
    return (p, x.count - p - s, String(decoding: y[p..<y.count - s], as: UTF16.self))
  }

  static func id(_ s: String) throws -> Data {
    guard let b = Base64URL.decode(s), b.count == 16 else { throw Failure.input("not an id: \(s)") }
    return b
  }

  static func tenths(_ at: Double) throws -> Pack {
    guard let t = Int64(exactly: (at * 10).rounded()) else { throw Failure.input("at \(at)") }
    return .int(t)
  }

  static func f32(_ v: [Double]) -> Pack { .array(v.map { .float32(Float($0)) }) }

  static func numbers(_ v: JSONValue?, _ n: Int) -> [Double]? {
    guard let a = v?.array, a.count == n else { return nil }
    let d = a.compactMap(\.number)
    return d.count == n ? d : nil
  }

  /// A JSON value as the web packs it: integral numbers as integers.
  static func pack(_ v: JSONValue) throws -> Pack {
    switch v {
    case .null: return .null
    case .bool(let b): return .bool(b)
    case .number(let n):
      guard n.isFinite, n == n.rounded() else { return .float64(n) }
      guard let i = Int64(exactly: n) else { throw Pack.Failure.range }
      return .int(i)
    case .string(let s): return .string(s)
    case .array(let a): return .array(try a.map(pack))
    case .object(let o): return .map(try o.keys.sorted().map { (.string($0), try pack(o[$0]!)) })
    }
  }
}

/// Keyframes at the first body, after `reset()`, and `Compact.keyframe` after the last.
struct Keyframes {
  var at: Date?
  var forced = false

  mutating func take(_ now: Date) -> Bool {
    let key = forced || at.map { now.timeIntervalSince($0) >= Compact.keyframe } ?? true
    if key { (forced, at) = (false, now) }
    return key
  }
}

/// One pipe's cursor encoder.
public final class CursorEncoder {
  private var keyframes = Keyframes()
  private var board: String?

  public init() {}

  /// Forces the next body to be a keyframe.
  public func reset() { keyframes.forced = true }

  /// `x` or `y` nil hides.
  public func encode(seq: Int, at: Double, x: Double?, y: Double?, board: String, now: Date) throws -> Data {
    let b = try Compact.id(board)
    var k = keyframes
    let key = k.take(now)
    let xy: [Pack] = if let x, let y { [.float32(Float(x)), .float32(Float(y))] } else { [.null, .null] }
    var out: [Pack] = [.int(1), .int(Int64(seq)), try Compact.tenths(at)] + xy
    if key || board != self.board { out.append(.bin(b)) }
    let d = try Pack.array(out).packed()
    (keyframes, self.board) = (k, board)
    return d
  }
}

/// What a live body says: each item's fields changed since the gesture began, and its start for a group.
public struct LiveBody: Equatable, Sendable {
  public var board: String
  public var items: [String: LiveFields]
  public var starts: [String: [Double]]
  public var caret: Caret?
  public var cursor: [Double]?

  public init(board: String, items: [String: LiveFields], starts: [String: [Double]] = [:], caret: Caret? = nil, cursor: [Double]? = nil) {
    self.board = board
    self.items = items
    self.starts = starts
    self.caret = caret
    self.cursor = cursor
  }
}

/// One pipe's live encoder: remembers what it last sent, and changes nothing when it throws.
public final class LiveEncoder {
  private struct GroupSet: Equatable {
    var ids: [String]
    var starts: [[Double]]
  }

  /// Items whose `pos` moved from their start by one offset, the first member's.
  private struct Group {
    var set: GroupSet
    var bins: [Data]
    var offset: [Float]
  }

  private var keyframes = Keyframes()
  private var board: String?
  private var caretID: String?
  /// Id → its fields as last sent.
  private var sent: [String: LiveFields] = [:]
  /// The group's ids and starts as last sent.
  private var groupSet: GroupSet?
  /// The group's offset as last sent, nil when the last body had no group.
  private var offset: [Float]?

  public init() {}

  /// Forces the next body to be a keyframe.
  public func reset() { keyframes.forced = true }

  public func encode(_ body: LiveBody, seq: Int, at: Double, now: Date) throws -> Data {
    let boardBin = try Compact.id(body.board), caretBin = try body.caret.map { try Compact.id($0.id) }
    let ids = try body.items.keys.map { ($0, try Compact.id($0)) }.sorted { $0.1.lexicographicallyPrecedes($1.1) }
    try Self.check(body)
    var k = keyframes
    let key = k.take(now)
    var sent = key ? [:] : self.sent, groupSet = key ? nil : self.groupSet
    let group = Self.group(ids, body)
    let grouped = Set(group?.set.ids ?? [])
    var out: [(Pack, Pack)] = []
    for (id, b) in ids {
      var last = sent[id] ?? [:], f: [(Pack, Pack)] = []
      for (i, name) in Compact.fields.enumerated() {
        guard let v = body.items[id]![name] else { continue }
        let was = last[name]
        last[name] = v
        if (name == "pos" && grouped.contains(id)) || was == v { continue }
        f.append((.int(Int64(i)), try Self.field(name, v, was)))
      }
      sent[id] = last
      if !f.isEmpty { out.append((.bin(b), .map(f))) }
    }
    var g = Pack.null
    if let group {
      let offset = Pack.array(group.offset.map { .float32($0) })
      let fresh = group.set != groupSet
      if fresh { g = .array([offset, .array(group.bins.map { .bin($0) }), .array(group.set.starts.map(Compact.f32))]) }
      else if group.offset != self.offset { g = .array([offset]) }
      groupSet = group.set
    }
    let b: Pack = key || body.board != board ? .bin(boardBin) : .null
    let caret: Pack = body.caret.map { c in
      .array([key || c.id != caretID ? .bin(caretBin!) : .null, .bool(c.back), .int(Int64(c.at))])
    } ?? .null
    let d = try Pack.array([.int(2), .int(Int64(seq)), try Compact.tenths(at), b, caret, .map(out), g, body.cursor.map(Compact.f32) ?? .null]).packed()
    (keyframes, self.sent, self.groupSet, offset) = (k, sent, groupSet, group?.offset)
    (board, caretID) = (body.board, body.caret?.id)
    return d
  }

  private static func check(_ body: LiveBody) throws {
    for (id, f) in body.items {
      if let k = f["kind"], !Compact.kinds.contains(k.string ?? "") { throw Compact.Failure.input("unknown kind \(k) of \(id)") }
      for name in ["pos", "size"] where f[name] != nil && Compact.numbers(f[name], 2) == nil {
        throw Compact.Failure.input("\(name) of \(id)")
      }
      if let w = f["w"], w.number == nil { throw Compact.Failure.input("w of \(id)") }
    }
    if body.starts.values.contains(where: { $0.count != 2 }) { throw Compact.Failure.input("starts") }
    if let c = body.cursor, c.count != 2 { throw Compact.Failure.input("cursor") }
  }

  private static func group(_ ids: [(String, Data)], _ body: LiveBody) -> Group? {
    let members = ids.filter { body.items[$0.0]!["pos"] != nil && body.starts[$0.0] != nil }
    guard !members.isEmpty else { return nil }
    func off(_ id: String) -> [Double] {
      let p = Compact.numbers(body.items[id]!["pos"], 2)!, s = body.starts[id]!
      return [p[0] - s[0], p[1] - s[1]]
    }
    let o = off(members[0].0)
    guard members.allSatisfy({ zip(off($0.0), o).allSatisfy { abs($0 - $1) <= Compact.epsilon } }) else { return nil }
    return Group(set: GroupSet(ids: members.map(\.0), starts: members.map { body.starts[$0.0]! }),
                 bins: members.map(\.1), offset: o.map { Float($0) })
  }

  /// `v` on the wire; a text that was `was` goes as a splice when that is shorter.
  private static func field(_ name: String, _ v: JSONValue, _ was: JSONValue?) throws -> Pack {
    switch name {
    case "pos", "size": return Compact.f32(Compact.numbers(v, 2)!)
    case "w": return .float32(Float(v.number!))
    case "kind": return .int(Int64(Compact.kinds.firstIndex(of: v.string!)!))
    default: break
    }
    let p = try Compact.pack(v)
    if Compact.texts.contains(name), let was = was?.string, let v = v.string {
      let (at, del, ins) = Compact.splice(was, v)
      let s = Pack.array([.int(Int64(Compact.fnv1a(was))), .int(Int64(at)), .int(Int64(del)), .string(ins)])
      if try s.packed().count < p.packed().count { return s }
    }
    return p
  }
}

/// Turns compact bytes into the JSON-shaped bodies `Live` handles, keeping one sender's state.
public final class LiveDecoder {
  private var cursorBoard: String?, liveBoard: String?
  private var cursorSeq = 0, liveSeq = 0
  private var caretID: String?
  private var groupIDs: [String]?, groupStarts: [[Double]]?

  public init() {}

  /// `{t: "cursor", seq, at, board, x, y}`, `{t: "live", seq, at, board, items, caret, cursor}`, or nil when malformed or
  /// not after the last body of its kind; `overlay`: id → the fields this receiver shows for this sender.
  public func decode(_ d: Data, overlay: [String: LiveFields] = [:]) -> [String: JSONValue]? {
    guard let v = (try? Pack.unpack(d))?.array, let t = v.first.flatMap(Self.integral) else { return nil }
    switch t {
    case 1: return cursor(v)
    case 2: return live(v, overlay)
    default: return nil
    }
  }

  private func cursor(_ v: [Pack]) -> [String: JSONValue]? {
    guard v.count == 5 || v.count == 6, let seq = Self.uint(v[1]), let at = Self.safe(v[2]) else { return nil }
    let x = v[3].number, y = v[4].number
    guard (v[3] == .null && v[4] == .null) || (x != nil && y != nil) else { return nil }
    var board = cursorBoard
    if v.count == 6 {
      guard let b = Self.id(v[5]) else { return nil }
      board = b
    }
    guard let board, seq > cursorSeq else { return nil }
    (cursorBoard, cursorSeq) = (board, seq)
    return ["t": .string("cursor"), "seq": .number(Double(seq)), "at": .number(Double(at) / 10), "board": .string(board),
            "x": x.map(JSONValue.number) ?? .null, "y": y.map(JSONValue.number) ?? .null]
  }

  private func live(_ v: [Pack], _ overlay: [String: LiveFields]) -> [String: JSONValue]? {
    guard v.count == 8, let seq = Self.uint(v[1]), let at = Self.safe(v[2]) else { return nil }
    let (boardBin, caretPack, items, group, cursorPack) = (v[3], v[4], v[5], v[6], v[7])
    var board = liveBoard
    if boardBin != .null {
      guard let b = Self.id(boardBin) else { return nil }
      board = b
    }
    guard let board else { return nil }
    var caret: (id: String?, back: Bool, at: Int)?
    if caretPack != .null {
      guard let c = caretPack.array, c.count == 3, c[0] == .null || Self.id(c[0]) != nil, case .bool(let back) = c[1],
            let at = Self.uint(c[2])
      else { return nil }
      caret = (Self.id(c[0]), back, at)
    }
    var cursor: [Double]?
    if cursorPack != .null {
      guard let p = Self.pair(cursorPack) else { return nil }
      cursor = p
    }
    guard let entries = items.map else { return nil }
    var out: [String: LiveFields] = [:]
    for (idPack, fieldsPack) in entries {
      guard let id = Self.id(idPack), let fields = fieldsPack.map else { return nil }
      var f: LiveFields = [:]
      for (k, x) in fields {
        guard let k = Self.integral(k) else { return nil }
        // a field from a newer sender
        guard k >= 0, k < Double(Compact.fields.count) else { continue }
        let name = Compact.fields[Int(k)]
        switch Self.unfield(name, x, overlay[id]?[name]) {
        case .bad: return nil
        case .stale: break
        case .value(let value): f[name] = value
        }
      }
      if !f.isEmpty { out[id] = f }
    }
    var ids = groupIDs, starts = groupStarts, offset: [Double]?
    if group != .null {
      guard let g = group.array, g.count == 1 || g.count == 3, let o = Self.pair(g[0]) else { return nil }
      offset = o
      if g.count == 3 {
        guard let i = g[1].array, let s = g[2].array, i.count == s.count else { return nil }
        let gi = i.compactMap(Self.id), gs = s.compactMap(Self.pair)
        guard gi.count == i.count, gs.count == s.count else { return nil }
        (ids, starts) = (gi, gs)
      }
    }
    guard seq > liveSeq else { return nil }
    (liveBoard, liveSeq, groupIDs, groupStarts) = (board, seq, ids, starts)
    if let offset, let ids, let starts {
      for (i, id) in ids.enumerated() {
        out[id, default: [:]]["pos"] = .array([.number(starts[i][0] + offset[0]), .number(starts[i][1] + offset[1])])
      }
    }
    caretID = caret.flatMap { $0.id ?? caretID }
    let caretValue: JSONValue = if let caret, let caretID {
      .object(["id": .string(caretID), "back": .bool(caret.back), "at": .number(Double(caret.at))])
    } else { .null }
    return ["t": .string("live"), "seq": .number(Double(seq)), "at": .number(Double(at) / 10), "board": .string(board),
            "items": .object(out.mapValues(JSONValue.object)), "caret": caretValue,
            "cursor": cursor.map { .array($0.map(JSONValue.number)) } ?? .null]
  }

  private enum Field {
    case value(JSONValue)
    /// A splice that does not apply to what the receiver shows.
    case stale
    case bad
  }

  /// A wire field back to its JSON value.
  private static func unfield(_ name: String, _ v: Pack, _ current: JSONValue?) -> Field {
    switch name {
    case "pos", "size": return pair(v).map { .value(.array($0.map(JSONValue.number))) } ?? .bad
    case "w": return v.number.map { .value(.number($0)) } ?? .bad
    case "color": return safe(v).map { .value(.number(Double($0))) } ?? .bad
    case "kind":
      guard let k = integral(v), k >= 0, k < Double(Compact.kinds.count) else { return .bad }
      return .value(.string(Compact.kinds[Int(k)]))
    case "gone":
      guard case .bool(true) = v else { return .bad }
      return .value(.bool(true))
    default: break
    }
    if let s = v.string { return .value(.string(s)) }
    guard let a = v.array, a.count == 4, let hash = uint(a[0]), let at = uint(a[1]), let del = uint(a[2]), let ins = a[3].string
    else { return .bad }
    guard let text = current?.string, Int(Compact.fnv1a(text)) == hash else { return .stale }
    let u = Array(text.utf16)
    guard at + del <= u.count else { return .stale }
    let units = u[..<at] + Array(ins.utf16) + u[(at + del)...]
    let s = String(decoding: units, as: UTF16.self)
    // one that splits a surrogate pair
    guard s.utf16.elementsEqual(units) else { return .stale }
    return .value(.string(s))
  }

  /// A number that is a whole number, as the web's `Number.isInteger` takes it.
  private static func integral(_ v: Pack) -> Double? {
    guard let n = v.number, n.isFinite, n == n.rounded() else { return nil }
    return n
  }

  private static func safe(_ v: Pack) -> Int? {
    guard let n = integral(v), abs(n) <= 0x1f_ffff_ffff_ffff else { return nil }
    return Int(n)
  }

  private static func uint(_ v: Pack) -> Int? { safe(v).flatMap { $0 >= 0 ? $0 : nil } }

  private static func id(_ v: Pack) -> String? {
    guard let b = v.bin, b.count == 16 else { return nil }
    return Base64URL.encode(b)
  }

  private static func pair(_ v: Pack) -> [Double]? {
    guard let a = v.array, a.count == 2, let x = a[0].number, let y = a[1].number else { return nil }
    return [x, y]
  }
}
