import Foundation
import Testing
@testable import BreezyKit

private struct Case {
  let value: Pack
  let hex: String?
  let prefix: String?
  let bytes: Int?
}

private func pack(_ j: JSONValue) throws -> Pack {
  switch j {
  case .null: return .null
  case .bool(let b): return .bool(b)
  case .number(let n): return n == n.rounded() ? .int(Int64(n)) : .float64(n)
  case .string(let s): return .string(s)
  case .array(let a): return .array(try a.map(pack))
  case .object(let o):
    if let v = o["f32"]?.number { return .float32(Float(v)) }
    if let v = o["bin"]?.string { return .bin(Base64URL.decode(v)!) }
    if let n = o["mapRange"]?.number { return .map((0..<Int(n)).map { (.int(Int64($0)), .int(Int64($0))) }) }
    if let r = o["repeat"]?.array, let n = r[1].number.map(Int.init) {
      switch try pack(r[0]) {
      case .string(let s): return .string(String(repeating: s, count: n))
      case .bin(let b): return .bin(Data(repeating: b[0], count: n * b.count))
      case let u: return .array(Array(repeating: u, count: n))
      }
    }
    return .map(try o["map"]!.array!.map { (try pack($0.array![0]), try pack($0.array![1])) })
  }
}

private func cases() throws -> [Case] {
  let root = try JSONDecoder().decode(JSONValue.self, from: fixture("msgpack.json"))
  return try root.object!["cases"]!.array!.map {
    let o = $0.object!
    return Case(value: try pack(o["value"]!), hex: o["hex"]?.string, prefix: o["hexPrefix"]?.string, bytes: o["bytes"]?.number.map(Int.init))
  }
}

private func bytes(_ hex: String) -> Data {
  Data(stride(from: 0, to: hex.count, by: 2).map { UInt8(hex.dropFirst($0).prefix(2), radix: 16)! })
}

private func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

@Suite struct MessagePackTests {
  @Test func packMatchesTheSharedHex() throws {
    for c in try cases() {
      let p = try c.value.packed()
      if let h = c.hex { #expect(hex(p) == h, Comment(rawValue: h)) }
      if let prefix = c.prefix {
        #expect(p.count == c.bytes, Comment(rawValue: prefix))
        #expect(hex(p.prefix(prefix.count / 2)) == prefix)
      }
    }
  }

  @Test func unpackMatchesTheSharedValues() throws {
    for c in try cases() {
      let source = try c.hex.map(bytes) ?? c.value.packed()
      #expect(try Pack.unpack(source) == c.value, Comment(rawValue: c.hex ?? c.prefix ?? ""))
    }
  }

  @Test func unpackRejectsMalformedInput() {
    for h in ["c1", "da00", "", "00ff", "cd01", "a3616263c0", "c40001", "a1ff", "d9"] {
      #expect(throws: Pack.Failure.self, Comment(rawValue: h)) { try Pack.unpack(bytes(h)) }
    }
  }

  @Test func unpackRejectsTypesOutsideTheSubset() {
    for h in ["c70100ff", "c8000100ff", "c900000001ff", "d401ff", "d50100ff", "d6000000000", "d7", "d8", "c4", "c1"] {
      #expect(throws: Pack.Failure.self, Comment(rawValue: h)) { try Pack.unpack(bytes(h)) }
    }
  }

  @Test func integersBeyondTheSafeRangeThrow() throws {
    for h in ["cf0020000000000000", "d3ffdfffffffffffff", "cfffffffffffffffff", "cf8000000000000000", "d38000000000000000"] {
      #expect(throws: Pack.Failure.self, Comment(rawValue: h)) { try Pack.unpack(bytes(h)) }
    }
    #expect(try Pack.unpack(bytes("cf001fffffffffffff")) == .int(1 << 53 - 1))
  }

  @Test func packRejectsIntegersBeyondTheSafeRange() throws {
    for v in [Int64(1) << 53, -(Int64(1) << 53), Int64.max, Int64.min] {
      #expect(throws: Pack.Failure.self) { try Pack.int(v).packed() }
      #expect(throws: Pack.Failure.self) { try Pack.array([.int(v)]).packed() }
    }
    #expect(try Pack.int(1 << 53 - 1).packed() == bytes("cf001fffffffffffff"))
  }

  @Test func float32SurvivesARoundTrip() throws {
    #expect(try Pack.unpack(Pack.float32(0.1).packed()) == .float32(0.1))
  }

  @Test func helpersReadTheirCase() {
    #expect(Pack.int(3).int == 3)
    #expect(Pack.int(3).number == 3)
    #expect(Pack.float32(1.5).number == 1.5)
    #expect(Pack.float64(2.5).number == 2.5)
    #expect(Pack.string("a").string == "a")
    #expect(Pack.string("a").int == nil)
    #expect(Pack.bin(Data([1])).bin == Data([1]))
    #expect(Pack.array([.null]).array == [.null])
    #expect(Pack.map([(.int(1), .null)]).map?.count == 1)
  }

  @Test func mapsCompareByOrderAndContent() {
    #expect(Pack.map([(.int(1), .null)]) == .map([(.int(1), .null)]))
    #expect(Pack.map([(.int(1), .null)]) != .map([(.int(1), .bool(true))]))
    #expect(Pack.map([]) != .array([]))
  }
}
