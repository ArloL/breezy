import Foundation

/// A MessagePack subset: nil, bool, int, float32/64, str, bin, array, map.
public indirect enum Pack: Equatable, Sendable {
  case null
  case bool(Bool)
  case int(Int64)
  case float32(Float)
  case float64(Double)
  case string(String)
  case bin(Data)
  case array([Pack])
  case map([(Pack, Pack)])

  public enum Failure: Error { case truncated, trailing, unsupported(UInt8), range, utf8 }

  public static func == (a: Pack, b: Pack) -> Bool {
    switch (a, b) {
    case (.null, .null): true
    case let (.bool(x), .bool(y)): x == y
    case let (.int(x), .int(y)): x == y
    case let (.float32(x), .float32(y)): x == y
    case let (.float64(x), .float64(y)): x == y
    case let (.string(x), .string(y)): x == y
    case let (.bin(x), .bin(y)): x == y
    case let (.array(x), .array(y)): x == y
    case let (.map(x), .map(y)): x.count == y.count && zip(x, y).allSatisfy { $0.0 == $1.0 && $0.1 == $1.1 }
    default: false
    }
  }

  public var int: Int64? { if case .int(let v) = self { v } else { nil } }
  public var number: Double? {
    switch self {
    case .int(let v): Double(v)
    case .float32(let v): Double(v)
    case .float64(let v): v
    default: nil
    }
  }
  public var string: String? { if case .string(let v) = self { v } else { nil } }
  public var bin: Data? { if case .bin(let v) = self { v } else { nil } }
  public var array: [Pack]? { if case .array(let v) = self { v } else { nil } }
  public var map: [(Pack, Pack)]? { if case .map(let v) = self { v } else { nil } }

  public func packed() -> Data {
    var out = Data()
    write(&out)
    return out
  }

  public static func unpack(_ d: Data) throws -> Pack {
    var r = Reader(bytes: [UInt8](d))
    let v = try r.read()
    guard r.at == r.bytes.count else { throw Failure.trailing }
    return v
  }

  private static let maxSafe: Int64 = 1 << 53 - 1

  private static func be(_ v: UInt64, _ size: Int) -> [UInt8] {
    (0..<size).map { UInt8(truncatingIfNeeded: v >> UInt64(8 * (size - 1 - $0))) }
  }

  private static func header(_ out: inout Data, _ n: Int, fix: UInt8, fixMax: Int, tags: (UInt8?, UInt8, UInt8)) {
    if n <= fixMax {
      out.append(fix | UInt8(n))
    } else if let t = tags.0, n < 0x100 {
      out.append(contentsOf: [t, UInt8(n)])
    } else if n < 0x10000 {
      out.append(tags.1)
      out.append(contentsOf: be(UInt64(n), 2))
    } else {
      precondition(n <= Int(UInt32.max), "msgpack: too long")
      out.append(tags.2)
      out.append(contentsOf: be(UInt64(n), 4))
    }
  }

  private func write(_ out: inout Data) {
    switch self {
    case .null: out.append(0xc0)
    case .bool(let b): out.append(b ? 0xc3 : 0xc2)
    case .int(let v): Pack.writeInt(&out, v)
    case .float32(let v):
      out.append(0xca)
      out.append(contentsOf: Pack.be(UInt64(v.bitPattern), 4))
    case .float64(let v):
      out.append(0xcb)
      out.append(contentsOf: Pack.be(v.bitPattern, 8))
    case .string(let s):
      let b = Data(s.utf8)
      Pack.header(&out, b.count, fix: 0xa0, fixMax: 31, tags: (0xd9, 0xda, 0xdb))
      out.append(b)
    case .bin(let b):
      Pack.header(&out, b.count, fix: 0, fixMax: -1, tags: (0xc4, 0xc5, 0xc6))
      out.append(b)
    case .array(let a):
      Pack.header(&out, a.count, fix: 0x90, fixMax: 15, tags: (nil, 0xdc, 0xdd))
      for x in a { x.write(&out) }
    case .map(let m):
      Pack.header(&out, m.count, fix: 0x80, fixMax: 15, tags: (nil, 0xde, 0xdf))
      for (k, v) in m {
        k.write(&out)
        v.write(&out)
      }
    }
  }

  private static func writeInt(_ out: inout Data, _ v: Int64) {
    if v >= 0 {
      if v < 0x80 { out.append(UInt8(v)) }
      else if v < 0x100 { out.append(contentsOf: [0xcc, UInt8(v)]) }
      else if v < 0x10000 { out.append(0xcd); out.append(contentsOf: be(UInt64(v), 2)) }
      else if v < 0x1_0000_0000 { out.append(0xce); out.append(contentsOf: be(UInt64(v), 4)) }
      else { out.append(0xcf); out.append(contentsOf: be(UInt64(v), 8)) }
    } else if v >= -32 { out.append(UInt8(bitPattern: Int8(v))) }
    else if v >= -0x80 { out.append(contentsOf: [0xd0, UInt8(bitPattern: Int8(v))]) }
    else if v >= -0x8000 { out.append(0xd1); out.append(contentsOf: be(UInt64(bitPattern: v), 2)) }
    else if v >= -0x8000_0000 { out.append(0xd2); out.append(contentsOf: be(UInt64(bitPattern: v), 4)) }
    else { out.append(0xd3); out.append(contentsOf: be(UInt64(bitPattern: v), 8)) }
  }

  private struct Reader {
    let bytes: [UInt8]
    var at = 0

    init(bytes: [UInt8]) { self.bytes = bytes }

    mutating func take(_ k: Int) throws -> Range<Int> {
      guard k <= bytes.count - at else { throw Failure.truncated }
      defer { at += k }
      return at..<at + k
    }

    mutating func uint(_ size: Int) throws -> UInt64 {
      try bytes[take(size)].reduce(0) { $0 << 8 | UInt64($1) }
    }

    mutating func signed(_ size: Int) throws -> Int64 {
      let u = try uint(size)
      let shift = UInt64(64 - 8 * size)
      return Int64(bitPattern: u << shift) >> Int64(shift)
    }

    mutating func safe(_ v: Int64) throws -> Pack {
      guard (-Pack.maxSafe...Pack.maxSafe).contains(v) else { throw Failure.range }
      return .int(v)
    }

    mutating func count(_ size: Int) throws -> Int { Int(try uint(size)) }

    mutating func raw(_ k: Int) throws -> Data { Data(bytes[try take(k)]) }

    mutating func str(_ k: Int) throws -> Pack {
      guard let s = String(data: try raw(k), encoding: .utf8) else { throw Failure.utf8 }
      return .string(s)
    }

    mutating func list(_ k: Int) throws -> Pack {
      var out: [Pack] = []
      for _ in 0..<k { out.append(try read()) }
      return .array(out)
    }

    mutating func pairs(_ k: Int) throws -> Pack {
      var out: [(Pack, Pack)] = []
      for _ in 0..<k {
        let key = try read()
        out.append((key, try read()))
      }
      return .map(out)
    }

    mutating func read() throws -> Pack {
      let t = bytes.indices.contains(at) ? bytes[at] : nil
      guard let t else { throw Failure.truncated }
      at += 1
      switch t {
      case 0..<0x80: return .int(Int64(t))
      case 0xe0...0xff: return .int(Int64(Int8(bitPattern: t)))
      case 0x80...0x8f: return try pairs(Int(t & 15))
      case 0x90...0x9f: return try list(Int(t & 15))
      case 0xa0...0xbf: return try str(Int(t & 31))
      case 0xc0: return .null
      case 0xc2: return .bool(false)
      case 0xc3: return .bool(true)
      case 0xc4: return .bin(try raw(count(1)))
      case 0xc5: return .bin(try raw(count(2)))
      case 0xc6: return .bin(try raw(count(4)))
      case 0xca: return .float32(Float(bitPattern: UInt32(try uint(4))))
      case 0xcb: return .float64(Double(bitPattern: try uint(8)))
      case 0xcc: return .int(Int64(try uint(1)))
      case 0xcd: return .int(Int64(try uint(2)))
      case 0xce: return .int(Int64(try uint(4)))
      case 0xcf:
        let u = try uint(8)
        guard u <= UInt64(Pack.maxSafe) else { throw Failure.range }
        return .int(Int64(u))
      case 0xd0: return .int(try signed(1))
      case 0xd1: return .int(try signed(2))
      case 0xd2: return .int(try signed(4))
      case 0xd3: return try safe(try signed(8))
      case 0xd9: return try str(count(1))
      case 0xda: return try str(count(2))
      case 0xdb: return try str(count(4))
      case 0xdc: return try list(count(2))
      case 0xdd: return try list(count(4))
      case 0xde: return try pairs(count(2))
      case 0xdf: return try pairs(count(4))
      default: throw Failure.unsupported(t)
      }
    }
  }
}
