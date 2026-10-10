import Foundation

/// Base64 with `-` and `_` and no padding, as ids, keys and blobs travel.
public enum Base64URL {
  public static func encode(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  public static func decode(_ text: String) -> Data? {
    guard text.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
    var b = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    b += String(repeating: "=", count: (4 - b.count % 4) % 4)
    return Data(base64Encoded: b)
  }
}

/// Where ids, secrets and nonces come from: the system's generator, unless a task binds `source`, as the fuzzer's
/// devices bind a seeded one so that runs replay.
public enum Randomness {
  @TaskLocal public static var source: (@Sendable (Int) -> Data)?
}

public func randomBytes(_ count: Int) -> Data {
  if let source = Randomness.source { return source(count) }
  var g = SystemRandomNumberGenerator()
  return Data((0..<count).map { _ in UInt8.random(in: 0...255, using: &g) })
}
