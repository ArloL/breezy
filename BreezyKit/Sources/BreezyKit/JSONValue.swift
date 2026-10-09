import Foundation

/// A JSON value: a record's fields hold these, so that fields this version does not know survive.
public enum JSONValue: Codable, Equatable, Sendable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case array([JSONValue])
  case object([String: JSONValue])
  case null

  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let b = try? c.decode(Bool.self) {
      self = .bool(b)
    } else if let n = try? c.decode(Double.self) {
      self = .number(n)
    } else if let s = try? c.decode(String.self) {
      self = .string(s)
    } else if let a = try? c.decode([JSONValue].self) {
      self = .array(a)
    } else {
      self = .object(try c.decode([String: JSONValue].self))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .string(let s): try c.encode(s)
    case .number(let n): try c.encode(n)
    case .bool(let b): try c.encode(b)
    case .array(let a): try c.encode(a)
    case .object(let o): try c.encode(o)
    case .null: try c.encodeNil()
    }
  }

  public var string: String? { if case .string(let s) = self { s } else { nil } }
  public var number: Double? { if case .number(let n) = self { n } else { nil } }
  public var array: [JSONValue]? { if case .array(let a) = self { a } else { nil } }
  public var object: [String: JSONValue]? { if case .object(let o) = self { o } else { nil } }
  public var bool: Bool? { if case .bool(let b) = self { b } else { nil } }
}
