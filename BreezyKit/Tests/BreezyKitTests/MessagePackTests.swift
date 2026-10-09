import Foundation
import Testing
@testable import BreezyKit

private struct Case {
  let value: Pack
  let hex: String?
  let prefix: String?
  let bytes: Int?
}

private func pack(_ j: Any) throws -> Pack {
  switch j {
  case is NSNull: return .null
  case let n as NSNumber:
    if CFGetTypeID(n) == CFBooleanGetTypeID() { return .bool(n.boolValue) }
    return CFNumberIsFloatType(n) ? .float64(n.doubleValue) : .int(n.int64Value)
  case let s as String: return .string(s)
  case let a as [Any]: return .array(try a.map(pack))
  case let o as [String: Any]:
    if let v = o["f32"] as? NSNumber { return .float32(v.floatValue) }
    if let v = o["bin"] as? String { return .bin(Base64URL.decode(v)!) }
    if let n = o["mapRange"] as? Int { return .map((0..<n).map { (.int(Int64($0)), .int(Int64($0))) }) }
    if let r = o["repeat"] as? [Any], let n = r[1] as? Int {
      switch try pack(r[0]) {
      case .string(let s): return .string(String(repeating: s, count: n))
      case .bin(let b): return .bin(Data(repeating: b[0], count: n * b.count))
      case let u: return .array(Array(repeating: u, count: n))
      }
    }
    return .map(try (o["map"] as! [[Any]]).map { (try pack($0[0]), try pack($0[1])) })
  default: fatalError("fixture")
  }
}

private func cases() throws -> [Case] {
  let root = try JSONSerialization.jsonObject(with: fixture("msgpack.json")) as! [String: Any]
  return try (root["cases"] as! [[String: Any]]).map {
    Case(value: try pack($0["value"]!), hex: $0["hex"] as? String, prefix: $0["hexPrefix"] as? String, bytes: $0["bytes"] as? Int)
  }
}

private func bytes(_ hex: String) -> Data {
  Data(stride(from: 0, to: hex.count, by: 2).map { UInt8(hex.dropFirst($0).prefix(2), radix: 16)! })
}

private func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

@Suite struct MessagePackTests {
  @Test func packMatchesTheSharedHex() throws {
    for c in try cases() {
      let p = c.value.packed()
      if let h = c.hex { #expect(hex(p) == h, Comment(rawValue: h)) }
      if let prefix = c.prefix {
        #expect(p.count == c.bytes, Comment(rawValue: prefix))
        #expect(hex(p.prefix(prefix.count / 2)) == prefix)
      }
    }
  }

  @Test func unpackMatchesTheSharedValues() throws {
    for c in try cases() {
      let source = c.hex.map(bytes) ?? c.value.packed()
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
