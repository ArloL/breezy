import BreezyKit
import Foundation

/// A command the host cannot carry out; the answer carries `message` as its `error`.
struct SimError: Error {
  var message: String
  init(_ message: String) { self.message = message }
}

typealias Fields = [String: JSONValue]

extension JSONValue {
  subscript(key: String) -> JSONValue? { object?[key] }
  var int: Int? { number.flatMap { Int(exactly: $0) } }

  static func int(_ n: Int) -> JSONValue { .number(Double(n)) }
  static func bytes(_ d: Data) -> JSONValue { .string(Base64URL.encode(d)) }
  static func optional(_ s: String?) -> JSONValue { s.map(JSONValue.string) ?? .null }

  func required(_ key: String) throws -> JSONValue {
    guard let v = self[key] else { throw SimError("missing \(key)") }
    return v
  }

  func int(_ key: String) throws -> Int {
    guard let n = self[key]?.int else { throw SimError("\(key) must be an integer") }
    return n
  }

  func number(_ key: String) throws -> Double {
    guard let n = self[key]?.number else { throw SimError("\(key) must be a number") }
    return n
  }

  func string(_ key: String) throws -> String {
    guard let s = self[key]?.string else { throw SimError("\(key) must be a string") }
    return s
  }

  /// `text` as a string, or `bytes` as base64url.
  func message() throws -> PeerMessage {
    if let t = self["text"]?.string { return .text(t) }
    if let b = self["bytes"]?.string, let d = Base64URL.decode(b) { return .bytes(d) }
    throw SimError("needs text or bytes")
  }
}

enum Wire {
  static let encoder: JSONEncoder = {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return e
  }()

  static func line(_ v: JSONValue) -> String { String(decoding: try! encoder.encode(v), as: UTF8.self) }
}
